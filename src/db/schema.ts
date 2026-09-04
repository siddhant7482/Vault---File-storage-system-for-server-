import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

/* ============================================================
   VAULT — schema

   One rule governs all of it: THE OBJECT STORE IS THE TRUTH.

   Every row here is derived from a byte range that exists in the
   store, and `pnpm scan` rebuilds the lot by walking the bucket.
   That means Postgres can be dropped, corrupted or left behind in a
   migration and nothing is lost except the things a scan cannot
   recover — tags, pins, shares and open history. Those are the only
   columns that are genuinely authored here, and they are the only
   ones worth backing up separately.

   The corollary is that `objects.key` is sacred. It is the address
   of the bytes, it never changes, and renaming a file changes
   `name` and nothing else. Anything that points at a file across
   CommandHQ points at the key.
   ============================================================ */

/* ---------------- enums ---------------- */

/** Coarse class, derived from the extension at scan time. Drives the
 *  fill pattern on the Map and nothing else — never trust it for
 *  anything that matters, the extension can lie. */
export const kindEnum = pgEnum("object_kind", [
  "document",
  "image",
  "video",
  "audio",
  "archive",
  "text",
  "other",
]);

/** How a file ended up in the folder it is in. `suggested` means the
 *  model proposed it and a human pressed File; `imported` means it was
 *  already in that prefix when the first scan ran. Kept so we can ask
 *  later how much of the filing was actually the model's idea. */
export const filedByEnum = pgEnum("filed_by", ["human", "suggested", "imported", "rule"]);

/* ---------------- folders ---------------- */

/**
 * Shallow on purpose — two levels is the whole design. `path` is the
 * object-store prefix with no leading or trailing slash ("Documents",
 * "Documents/Housing"), which makes a folder's contents a prefix
 * listing rather than a recursive query.
 */
export const folders = pgTable(
  "folders",
  {
    id: serial("id").primaryKey(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    parentId: integer("parent_id"),

    /** Display order in the tree. Ties break on name. */
    position: integer("position").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("folders_path_idx").on(t.path), index("folders_parent_idx").on(t.parentId)],
);

/* ---------------- objects ---------------- */

export const objects = pgTable(
  "objects",
  {
    id: serial("id").primaryKey(),

    /** The object-store key. Immutable, unique, and the only thing any
     *  other app is ever given. Renames do not touch it. */
    key: text("key").notNull(),

    /** What the user sees. Free to change; the key is not. */
    name: text("name").notNull(),

    /** Null means unfiled — the Inbox. That is a real state, not a
     *  missing value, and the whole pressure mechanic depends on it
     *  being distinguishable from "filed at the root". */
    folderId: integer("folder_id").references(() => folders.id, { onDelete: "set null" }),
    filedBy: filedByEnum("filed_by").notNull().default("imported"),
    filedAt: timestamp("filed_at", { withTimezone: true }),

    ext: text("ext"),
    mime: text("mime"),
    kind: kindEnum("kind").notNull().default("other"),

    /** Bytes. bigint because a 4 GB video overflows int4 and the Map's
     *  arithmetic has to stay exact — a treemap that lies about area is
     *  worse than no treemap. Stored as a JS number via mode:"number";
     *  Number.MAX_SAFE_INTEGER is 9 PB, so the ceiling is theoretical. */
    bytes: bigint("bytes", { mode: "number" }).notNull(),

    /** sha256 of the content. This is how duplicates are caught: same
     *  checksum, different key, and one of them is a copy you did not
     *  mean to keep. Null until a scan has had a chance to hash it —
     *  hashing 12 GB of photos is not something to do inline. */
    checksum: text("checksum"),

    /** From the store's own metadata, so it survives a rebuild. */
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    modifiedAt: timestamp("modified_at", { withTimezone: true }).notNull(),

    /** Null means NEVER OPENED, which is the strongest signal Vault has
     *  and the entire basis of COLD. A scan cannot recover this, so it
     *  is one of the few genuinely authored columns here. */
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),

    pinned: boolean("pinned").notNull().default(false),

    /** The model's filing proposal, held until accepted or overridden:
     *  { folder, name, reason, model, at }. Cleared on filing so the
     *  Inbox never shows a stale suggestion. */
    suggestion: jsonb("suggestion"),

    /** Soft delete. The bytes go when a sweep runs, not when the button
     *  is pressed — an undo window is cheap and losing the only copy of
     *  a passport scan is not. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("objects_key_idx").on(t.key),
    index("objects_folder_idx").on(t.folderId),
    /* Duplicate detection walks this, so it wants to be an index even
     * though the column is nullable and deliberately not unique. */
    index("objects_checksum_idx").on(t.checksum),
    index("objects_bytes_idx").on(t.bytes),
    index("objects_added_idx").on(t.addedAt),
    /* COLD is "lastOpenedAt IS NULL OR lastOpenedAt < cutoff", and nulls
     * sort together, so this index serves both halves. */
    index("objects_opened_idx").on(t.lastOpenedAt),
  ],
);

/* ---------------- tags ---------------- */

export const tags = pgTable(
  "tags",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_name_idx").on(t.name)],
);

export const objectTags = pgTable(
  "object_tags",
  {
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.objectId, t.tagId] }), index("object_tags_tag_idx").on(t.tagId)],
);

/* ---------------- sharing ---------------- */

/**
 * A share is a bearer token with an expiry. There is no account system
 * behind it and there never will be — the whole point is handing one
 * file to one person without either of us signing into anything.
 *
 * Expiry is mandatory. A link that never dies is a leak with a delay.
 */
export const shares = pgTable(
  "shares",
  {
    id: serial("id").primaryKey(),
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),

    /** Random, URL-safe, never derived from anything about the file. */
    token: text("token").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set the moment it is revoked; the row stays so the history does. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    hits: integer("hits").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shares_token_idx").on(t.token),
    index("shares_object_idx").on(t.objectId),
    index("shares_expires_idx").on(t.expiresAt),
  ],
);

/* ---------------- cross-app references ---------------- */

/**
 * Written by the OTHER apps, not by Vault. Warden says "this CV is
 * attached to four applications"; Nori says "this statement covers
 * three reconciled months"; Archive says "this zip is twelve
 * memories". Vault only reads them, and shows them so you know what a
 * file is load-bearing for before you delete it.
 *
 * Deliberately keyed by object key rather than id, so an app can
 * register a reference to something before Vault has indexed it.
 */
export const refs = pgTable(
  "refs",
  {
    id: serial("id").primaryKey(),
    objectKey: text("object_key").notNull(),

    /** "warden" | "nori" | "archive" | … — the registry id in the hub. */
    app: text("app").notNull(),
    /** Human-readable, written by that app: "4 applications". */
    label: text("label").notNull(),
    /** Deep link back into the app that owns the reference. */
    href: text("href"),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* One row per app per file — apps update their own claim rather than
     * appending, or a re-sync would multiply the references. */
    uniqueIndex("refs_app_object_idx").on(t.app, t.objectKey),
    index("refs_object_idx").on(t.objectKey),
  ],
);

/* ---------------- scans ---------------- */

/**
 * One row per index rebuild. Kept as history because a scan is the
 * thing that reconciles Postgres with reality, and when a number on
 * the Map looks wrong the first question is always when the index was
 * last true.
 */
export const scans = pgTable("scans", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),

  seen: integer("seen").notNull().default(0),
  added: integer("added").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  /** Indexed here but gone from the store — the index was stale. */
  vanished: integer("vanished").notNull().default(0),
  hashed: integer("hashed").notNull().default(0),

  bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
  error: text("error"),
});

/* ---------------- settings ---------------- */

/** Single row, id = 1. Mirrors Warden's shape so the hub can steer both
 *  through the same kind of endpoint. */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),

  /** The tight ship, in bytes. Everything on the Map is drawn against
   *  this, and uploads are refused past it. */
  allocationBytes: bigint("allocation_bytes", { mode: "number" }).notNull().default(30 * 1024 ** 3),

  /** Untouched for this many days and a file counts as cold. */
  coldDays: integer("cold_days").notNull().default(365),

  /** Whether to ask the model where new files should go. */
  suggestFiling: boolean("suggest_filing").notNull().default(true),

  /** Default lifetime for a new share link. */
  shareTtlHours: integer("share_ttl_hours").notNull().default(24 * 7),

  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Folder = typeof folders.$inferSelect;
export type VaultObject = typeof objects.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type Ref = typeof refs.$inferSelect;
export type Settings = typeof settings.$inferSelect;
