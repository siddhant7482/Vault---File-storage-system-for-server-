import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { folders, objects, scans } from "@/db/schema";
import { classify } from "@/lib/kind";
import { INBOX_PREFIX, isUnfiled, keyFolder, keyName, storage } from "@/lib/storage";

/* ============================================================
   THE SCAN — reconciling the index with the bytes.

   This is the function that makes the claim "Postgres is
   disposable" true rather than aspirational. Drop the database,
   run this, and everything on the Map comes back: the folder tree
   is rebuilt from key prefixes, every object is re-indexed from
   the store's own listing, and the only things genuinely lost are
   the columns a scan cannot know — tags, pins, shares, and open
   history.

   Three properties it has to hold:

   1. IDEMPOTENT. Running it twice changes nothing the second time.
      Everything is keyed on `objects.key`, which never changes.

   2. NON-DESTRUCTIVE. An object in the index that is missing from
      the store is marked vanished, never hard-deleted. A store
      that is briefly unreachable must not be able to empty the
      index — that is how you turn a network blip into data loss.

   3. INTERRUPTIBLE. Hashing 12 GB of photos is not something to do
      in one transaction. Metadata lands first and is immediately
      useful; checksums fill in afterwards, in budgeted batches,
      and a scan that dies halfway leaves the index better than it
      found it.
   ============================================================ */

export type ScanOptions = {
  /** Limit to one prefix. Used by the upload path to index a single
   *  new arrival without walking the whole bucket. */
  prefix?: string;
  /** Compute sha256 for objects that lack one. Off by default —
   *  a full hash pass reads every byte in the vault. */
  hash?: boolean;
  /** Stop hashing after this many bytes so a scheduled scan cannot
   *  spend an hour reading photos. */
  hashBudgetBytes?: number;
  onProgress?: (msg: string) => void;
};

export type ScanResult = {
  seen: number;
  added: number;
  updated: number;
  vanished: number;
  hashed: number;
  bytesTotal: number;
  ms: number;
};

/** Default hash budget per run: 2 GB. Enough that a vault converges
 *  over a handful of scheduled scans without any single one hurting. */
const DEFAULT_HASH_BUDGET = 2 * 1024 ** 3;

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const store = storage();
  const say = opts.onProgress ?? (() => {});
  const startedAt = Date.now();

  const health = await store.health();
  if (!health.ok) throw new Error(`Storage unreachable (${store.name}): ${health.detail}`);

  const [run] = await db.insert(scans).values({}).returning({ id: scans.id });

  try {
    /* ---- 1. everything the index currently believes ---- */
    const existing = await db
      .select({
        id: objects.id,
        key: objects.key,
        bytes: objects.bytes,
        modifiedAt: objects.modifiedAt,
        folderId: objects.folderId,
        deletedAt: objects.deletedAt,
      })
      .from(objects);

    const byKey = new Map(existing.map((o) => [o.key, o]));
    const seenKeys = new Set<string>();

    /* ---- 2. folders, derived purely from key prefixes ---- */
    const folderIdByPath = await loadFolders();
    const wantedFolders = new Set<string>();

    /* ---- 3. walk the store ---- */
    let seen = 0;
    let added = 0;
    let updated = 0;
    let bytesTotal = 0;

    /* Batched so a vault with thousands of photos does not issue
     * thousands of round trips. */
    const inserts: (typeof objects.$inferInsert)[] = [];
    const updates: { id: number; bytes: number; modifiedAt: Date; folderId: number | null }[] = [];

    for await (const o of store.list(opts.prefix)) {
      seen += 1;
      bytesTotal += o.bytes;
      seenKeys.add(o.key);

      const prefix = keyFolder(o.key);
      /* An unfiled object has no folder — that is a real state, and it
       * is what the Inbox counts. The _inbox prefix is never promoted
       * to a folder row. */
      if (prefix && !isUnfiled(o.key)) collectFolderPaths(prefix, wantedFolders);

      const prior = byKey.get(o.key);
      if (!prior) {
        const { ext, kind, mime } = classify(keyName(o.key));
        inserts.push({
          key: o.key,
          name: keyName(o.key),
          folderId: null, // resolved after folders are created
          filedBy: isUnfiled(o.key) ? "imported" : "imported",
          ext,
          mime,
          kind,
          bytes: o.bytes,
          addedAt: o.modifiedAt,
          modifiedAt: o.modifiedAt,
        });
        added += 1;
      } else if (
        prior.bytes !== o.bytes ||
        prior.modifiedAt.getTime() !== o.modifiedAt.getTime() ||
        prior.deletedAt !== null
      ) {
        updates.push({ id: prior.id, bytes: o.bytes, modifiedAt: o.modifiedAt, folderId: prior.folderId });
        updated += 1;
      }

      if (seen % 500 === 0) say(`walked ${seen} objects`);
    }

    /* ---- 4. materialise folders before objects reference them ---- */
    for (const path of [...wantedFolders].sort((a, b) => a.split("/").length - b.split("/").length)) {
      if (folderIdByPath.has(path)) continue;
      const parentPath = keyFolder(path);
      const [row] = await db
        .insert(folders)
        .values({
          path,
          name: keyName(path),
          parentId: parentPath ? (folderIdByPath.get(parentPath) ?? null) : null,
        })
        .onConflictDoNothing()
        .returning({ id: folders.id });
      if (row) folderIdByPath.set(path, row.id);
      else {
        const [found] = await db.select({ id: folders.id }).from(folders).where(eq(folders.path, path));
        if (found) folderIdByPath.set(path, found.id);
      }
    }

    /* ---- 5. write objects ---- */
    for (const chunk of batches(inserts, 200)) {
      for (const row of chunk) {
        const prefix = keyFolder(row.key);
        row.folderId = prefix && !isUnfiled(row.key) ? (folderIdByPath.get(prefix) ?? null) : null;
      }
      await db.insert(objects).values(chunk).onConflictDoNothing({ target: objects.key });
    }
    for (const u of updates) {
      await db
        .update(objects)
        .set({ bytes: u.bytes, modifiedAt: u.modifiedAt, deletedAt: null, updatedAt: new Date() })
        .where(eq(objects.id, u.id));
    }

    /* Re-home anything whose key prefix no longer matches its folder —
     * that happens when a file is moved outside the app, and the index
     * has to follow the bytes rather than argue with them. */
    await realignFolders(folderIdByPath);

    /* ---- 6. vanished ---- */
    let vanished = 0;
    if (!opts.prefix) {
      const gone = existing.filter((o) => !seenKeys.has(o.key) && o.deletedAt === null).map((o) => o.id);
      for (const chunk of batches(gone, 500)) {
        await db.update(objects).set({ deletedAt: new Date() }).where(inArray(objects.id, chunk));
      }
      vanished = gone.length;
      if (vanished) say(`${vanished} indexed objects are no longer in the store`);
    }

    /* ---- 7. checksums, budgeted ---- */
    let hashed = 0;
    if (opts.hash) {
      hashed = await hashPass(opts.hashBudgetBytes ?? DEFAULT_HASH_BUDGET, say);
    }

    const ms = Date.now() - startedAt;
    await db
      .update(scans)
      .set({ finishedAt: new Date(), seen, added, updated, vanished, hashed, bytesTotal })
      .where(eq(scans.id, run.id));

    return { seen, added, updated, vanished, hashed, bytesTotal, ms };
  } catch (e) {
    await db
      .update(scans)
      .set({ finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) })
      .where(eq(scans.id, run.id));
    throw e;
  }
}

/* ---------------- helpers ---------------- */

async function loadFolders(): Promise<Map<string, number>> {
  const rows = await db.select({ id: folders.id, path: folders.path }).from(folders);
  return new Map(rows.map((r) => [r.path, r.id]));
}

/** "Documents/Housing" implies "Documents" too. */
function collectFolderPaths(prefix: string, into: Set<string>) {
  const parts = prefix.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) into.add(parts.slice(0, i).join("/"));
}

/** The store is the truth about where a file lives, so this pushes the
 *  index back into agreement with the keys after a walk. */
async function realignFolders(folderIdByPath: Map<string, number>) {
  const rows = await db
    .select({ id: objects.id, key: objects.key, folderId: objects.folderId })
    .from(objects)
    .where(isNull(objects.deletedAt));

  for (const r of rows) {
    const prefix = keyFolder(r.key);
    const want = prefix && !isUnfiled(r.key) ? (folderIdByPath.get(prefix) ?? null) : null;
    if (want !== r.folderId) {
      await db.update(objects).set({ folderId: want, updatedAt: new Date() }).where(eq(objects.id, r.id));
    }
  }
}

/**
 * Fills in missing checksums, smallest first, until the byte budget is
 * spent. Smallest first on purpose: it converges the count quickly, so
 * duplicate detection starts working on documents long before it has
 * finished chewing through a folder of raw photos.
 */
async function hashPass(budgetBytes: number, say: (m: string) => void): Promise<number> {
  const store = storage();
  const pending = await db
    .select({ id: objects.id, key: objects.key, bytes: objects.bytes })
    .from(objects)
    .where(and(isNull(objects.checksum), isNull(objects.deletedAt)))
    .orderBy(objects.bytes)
    .limit(5000);

  let spent = 0;
  let done = 0;
  for (const o of pending) {
    if (spent + o.bytes > budgetBytes && done > 0) break;
    try {
      const stream = await store.read(o.key);
      const hash = createHash("sha256");
      const reader = stream.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (value) hash.update(value);
      }
      await db
        .update(objects)
        .set({ checksum: hash.digest("hex"), updatedAt: new Date() })
        .where(eq(objects.id, o.id));
      spent += o.bytes;
      done += 1;
      if (done % 50 === 0) say(`hashed ${done} objects`);
    } catch {
      /* Unreadable right now is not the same as gone. Leave the checksum
       * null and let the next scan try again. */
    }
  }
  return done;
}

function* batches<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/** Objects sharing a checksum: same bytes, different key. Exactly one of
 *  each group is the one you meant to keep. */
export async function duplicates() {
  return db
    .select({
      checksum: objects.checksum,
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`max(${objects.bytes})::bigint`,
      keys: sql<string[]>`array_agg(${objects.key} order by ${objects.addedAt})`,
    })
    .from(objects)
    .where(and(isNull(objects.deletedAt), sql`${objects.checksum} is not null`))
    .groupBy(objects.checksum)
    .having(sql`count(*) > 1`);
}

export { INBOX_PREFIX };
