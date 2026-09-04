import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { folders, objects, refs, settings, shares, tags, objectTags } from "@/db/schema";
import type { Kind } from "@/lib/kind";
import { isUnfiled } from "@/lib/storage";

/* ============================================================
   The read model — everything the panel needs, and nothing it
   does not.

   Queries live here rather than in the routes so that the page
   (a server component) and the API answer from exactly the same
   arithmetic. The Map and the index disagreeing about a number
   is the fastest way to make the whole thing untrustworthy.
   ============================================================ */

export type Scope = { top: string | null; sub: string | null } | null;

export type Settings = {
  allocationBytes: number;
  coldDays: number;
  suggestFiling: boolean;
  shareTtlHours: number;
  lastScanAt: Date | null;
};

export async function getSettings(): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (row) {
    return {
      allocationBytes: row.allocationBytes,
      coldDays: row.coldDays,
      suggestFiling: row.suggestFiling,
      shareTtlHours: row.shareTtlHours,
      lastScanAt: row.lastScanAt,
    };
  }
  /* First run, before the row exists. Fall back to env so the gauge is
   * drawn against something real rather than zero. */
  const gb = Number(process.env.VAULT_ALLOCATION_GB || 30);
  return {
    allocationBytes: gb * 1024 ** 3,
    coldDays: Number(process.env.VAULT_COLD_DAYS || 365),
    suggestFiling: true,
    shareTtlHours: 24 * 7,
    lastScanAt: null,
  };
}

/** The cutoff below which a file counts as cold. Null lastOpenedAt is
 *  also cold — never opened is the strongest form of it. */
function coldCutoff(coldDays: number) {
  return new Date(Date.now() - coldDays * 86_400_000);
}

const live = isNull(objects.deletedAt);

/* ---------------- the tree ---------------- */

export type TreeNode = {
  id: number;
  path: string;
  name: string;
  count: number;
  bytes: number;
  children: TreeNode[];
};

export async function getTree(): Promise<{ nodes: TreeNode[]; inbox: number }> {
  const rows = await db
    .select({ id: folders.id, path: folders.path, name: folders.name, parentId: folders.parentId })
    .from(folders)
    .orderBy(asc(folders.position), asc(folders.name));

  const agg = await db
    .select({
      folderId: objects.folderId,
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${objects.bytes}), 0)::bigint`,
    })
    .from(objects)
    .where(and(live, isNotNull(objects.folderId)))
    .groupBy(objects.folderId);

  const stat = new Map(agg.map((a) => [a.folderId!, { count: a.count, bytes: Number(a.bytes) }]));

  const byId = new Map<number, TreeNode>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      name: r.name,
      count: stat.get(r.id)?.count ?? 0,
      bytes: stat.get(r.id)?.bytes ?? 0,
      children: [],
    });
  }

  const roots: TreeNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  /* A parent's totals include its children's — the sidebar says how much
   * "Documents" costs, not how much sits loose at its top level. */
  const roll = (n: TreeNode): { count: number; bytes: number } => {
    for (const c of n.children) {
      const r = roll(c);
      n.count += r.count;
      n.bytes += r.bytes;
    }
    return { count: n.count, bytes: n.bytes };
  };
  roots.forEach(roll);

  const [{ n: inbox }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(objects)
    .where(and(live, isNull(objects.folderId)));

  return { nodes: roots, inbox };
}

/* ---------------- objects ---------------- */

export type ObjectRow = {
  id: number;
  key: string;
  name: string;
  folderPath: string | null;
  ext: string | null;
  kind: Kind;
  bytes: number;
  addedAt: Date;
  lastOpenedAt: Date | null;
  cold: boolean;
  pinned: boolean;
  refApps: string[];
  shared: "active" | "expired" | null;
};

export async function listObjects(opts: {
  scope?: Scope;
  q?: string;
  coldOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ rows: ObjectRow[]; total: number; bytes: number }> {
  const s = await getSettings();
  const cutoff = coldCutoff(s.coldDays);

  const where = [live];
  if (opts.scope?.top) {
    const path = opts.scope.sub ? `${opts.scope.top}/${opts.scope.sub}` : opts.scope.top;
    /* Prefix match so selecting "Documents" includes everything beneath
     * it — the sidebar counts already work that way. */
    where.push(or(eq(folders.path, path), ilike(folders.path, `${path}/%`))!);
  }
  if (opts.q) {
    const like = `%${opts.q}%`;
    where.push(or(ilike(objects.name, like), ilike(objects.key, like))!);
  }
  if (opts.coldOnly) {
    where.push(or(isNull(objects.lastOpenedAt), lt(objects.lastOpenedAt, cutoff))!);
  }

  const base = db
    .select({
      id: objects.id,
      key: objects.key,
      name: objects.name,
      folderPath: folders.path,
      ext: objects.ext,
      kind: objects.kind,
      bytes: objects.bytes,
      addedAt: objects.addedAt,
      lastOpenedAt: objects.lastOpenedAt,
      pinned: objects.pinned,
    })
    .from(objects)
    .leftJoin(folders, eq(objects.folderId, folders.id))
    .where(and(...where));

  const [{ total, bytes }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${objects.bytes}), 0)::bigint`,
    })
    .from(objects)
    .leftJoin(folders, eq(objects.folderId, folders.id))
    .where(and(...where));

  /* Largest first. On a tight allocation the question is nearly always
   * "what is big", not "what is recent" — and the Map is sorted the same
   * way, so the two views agree. */
  const rows = await base.orderBy(desc(objects.bytes)).limit(opts.limit ?? 300).offset(opts.offset ?? 0);

  const decorated = await decorate(rows, cutoff);
  return { rows: decorated, total, bytes: Number(bytes) };
}

/** Attaches the two things that come from other tables: which apps
 *  reference a file, and whether a live share exists. Done as two set
 *  queries rather than per row. */
async function decorate(
  rows: Omit<ObjectRow, "cold" | "refApps" | "shared">[],
  cutoff: Date,
): Promise<ObjectRow[]> {
  if (!rows.length) return [];
  const keys = rows.map((r) => r.key);
  const ids = rows.map((r) => r.id);

  const refRows = keys.length
    ? await db.select({ objectKey: refs.objectKey, app: refs.app }).from(refs).where(inArray(refs.objectKey, keys))
    : [];
  const refsByKey = new Map<string, string[]>();
  for (const r of refRows) {
    refsByKey.set(r.objectKey, [...(refsByKey.get(r.objectKey) ?? []), r.app]);
  }

  const shareRows = ids.length
    ? await db
        .select({ objectId: shares.objectId, expiresAt: shares.expiresAt, revokedAt: shares.revokedAt })
        .from(shares)
        .where(inArray(shares.objectId, ids))
    : [];
  const shareById = new Map<number, "active" | "expired">();
  for (const s of shareRows) {
    const active = !s.revokedAt && s.expiresAt.getTime() > Date.now();
    const prior = shareById.get(s.objectId);
    if (active) shareById.set(s.objectId, "active");
    else if (!prior) shareById.set(s.objectId, "expired");
  }

  return rows.map((r) => ({
    ...r,
    cold: r.lastOpenedAt === null || r.lastOpenedAt < cutoff,
    refApps: refsByKey.get(r.key) ?? [],
    shared: shareById.get(r.id) ?? null,
  }));
}

/* ---------------- the inbox ---------------- */

export type UnfiledRow = ObjectRow & {
  suggestion: { folder: string; name: string; reason?: string } | null;
  duplicateOfKey: string | null;
};

export async function listUnfiled(): Promise<UnfiledRow[]> {
  const s = await getSettings();
  const cutoff = coldCutoff(s.coldDays);

  const rows = await db
    .select({
      id: objects.id,
      key: objects.key,
      name: objects.name,
      folderPath: sql<string | null>`null`,
      ext: objects.ext,
      kind: objects.kind,
      bytes: objects.bytes,
      addedAt: objects.addedAt,
      lastOpenedAt: objects.lastOpenedAt,
      pinned: objects.pinned,
      suggestion: objects.suggestion,
      checksum: objects.checksum,
    })
    .from(objects)
    .where(and(live, isNull(objects.folderId)))
    /* Oldest first — the pressure is about what has been sitting
     * longest, so that is what the top of the list has to show. */
    .orderBy(asc(objects.addedAt));

  const decorated = await decorate(
    rows.map(({ suggestion: _s, checksum: _c, ...r }) => r),
    cutoff,
  );

  /* Duplicate detection: an unfiled file whose checksum already exists
   * on a filed one is a copy, and saying so before it is filed is worth
   * more than saying so afterwards. */
  const sums = rows.map((r) => r.checksum).filter((c): c is string => !!c);
  const dupes = sums.length
    ? await db
        .select({ checksum: objects.checksum, key: objects.key })
        .from(objects)
        .where(and(live, isNotNull(objects.folderId), inArray(objects.checksum, sums)))
    : [];
  const dupeBySum = new Map(dupes.map((d) => [d.checksum!, d.key]));

  return decorated.map((r, i) => ({
    ...r,
    suggestion: (rows[i].suggestion as UnfiledRow["suggestion"]) ?? null,
    duplicateOfKey: rows[i].checksum ? (dupeBySum.get(rows[i].checksum!) ?? null) : null,
  }));
}

/* ---------------- the map ---------------- */

export type MapBlock = {
  /** Null for the aggregated tail block, which stands for many files. */
  id: number | null;
  name: string;
  top: string;
  bytes: number;
  cold: boolean;
  linked: boolean;
  /** How many files this block stands for. 1 for a real object. */
  count: number;
};

export type MapData = {
  groups: { top: string; bytes: number; blocks: MapBlock[] }[];
  freeBytes: number;
  allocationBytes: number;
  usedBytes: number;
  coldBytes: number;
  coldCount: number;
};

/**
 * The Map has to stay honest about area while staying drawable. Four
 * thousand photos is four thousand DOM nodes, most of them a pixel
 * wide and unlabelled — useless to look at and slow to render.
 *
 * So: the largest files in each folder get their own block, and the
 * remainder is folded into ONE tail block whose area is the exact sum
 * of what it replaces. Total area per folder is unchanged, which is
 * the property that matters. The tail is clickable and drops you into
 * the index filtered to that folder.
 */
const BLOCKS_PER_GROUP = 34;

export async function getMap(): Promise<MapData> {
  const s = await getSettings();
  const cutoff = coldCutoff(s.coldDays);

  const rows = await db
    .select({
      id: objects.id,
      key: objects.key,
      name: objects.name,
      bytes: objects.bytes,
      lastOpenedAt: objects.lastOpenedAt,
      folderPath: folders.path,
    })
    .from(objects)
    .leftJoin(folders, eq(objects.folderId, folders.id))
    .where(live)
    .orderBy(desc(objects.bytes));

  const linkedKeys = new Set((await db.select({ k: refs.objectKey }).from(refs)).map((r) => r.k));

  const byTop = new Map<string, { id: number; name: string; bytes: number; cold: boolean; linked: boolean }[]>();
  let usedBytes = 0;
  let coldBytes = 0;
  let coldCount = 0;

  for (const r of rows) {
    usedBytes += r.bytes;
    const cold = r.lastOpenedAt === null || r.lastOpenedAt < cutoff;
    if (cold) {
      coldBytes += r.bytes;
      coldCount += 1;
    }
    /* Unfiled objects group under "Inbox" so the Map accounts for every
     * byte — a map that silently omits the Inbox understates usage. */
    const top = r.folderPath ? r.folderPath.split("/")[0] : "Inbox";
    const list = byTop.get(top) ?? [];
    list.push({ id: r.id, name: r.name, bytes: r.bytes, cold, linked: linkedKeys.has(r.key) });
    byTop.set(top, list);
  }

  const groups = [...byTop.entries()]
    .map(([top, items]) => {
      const head = items.slice(0, BLOCKS_PER_GROUP);
      const tail = items.slice(BLOCKS_PER_GROUP);
      const blocks: MapBlock[] = head.map((i) => ({
        id: i.id,
        name: i.name,
        top,
        bytes: i.bytes,
        cold: i.cold,
        linked: i.linked,
        count: 1,
      }));
      if (tail.length) {
        const tailBytes = tail.reduce((n, i) => n + i.bytes, 0);
        blocks.push({
          id: null,
          name: `${tail.length} smaller`,
          top,
          bytes: tailBytes,
          /* The tail is cold only if all of it is — a half-cold block
           * would light up under COLD and overstate the problem. */
          cold: tail.every((i) => i.cold),
          linked: false,
          count: tail.length,
        });
      }
      return { top, bytes: items.reduce((n, i) => n + i.bytes, 0), blocks };
    })
    .sort((a, b) => b.bytes - a.bytes);

  return {
    groups,
    usedBytes,
    allocationBytes: s.allocationBytes,
    freeBytes: Math.max(0, s.allocationBytes - usedBytes),
    coldBytes,
    coldCount,
  };
}

/* ---------------- one file ---------------- */

export type Detail = ObjectRow & {
  checksum: string | null;
  mime: string | null;
  openCount: number;
  tags: string[];
  refs: { app: string; label: string; href: string | null }[];
  share: { token: string; expiresAt: Date; revokedAt: Date | null; hits: number } | null;
};

export async function getDetail(id: number): Promise<Detail | null> {
  const s = await getSettings();
  const cutoff = coldCutoff(s.coldDays);

  const [row] = await db
    .select({
      id: objects.id,
      key: objects.key,
      name: objects.name,
      folderPath: folders.path,
      ext: objects.ext,
      mime: objects.mime,
      kind: objects.kind,
      bytes: objects.bytes,
      addedAt: objects.addedAt,
      lastOpenedAt: objects.lastOpenedAt,
      openCount: objects.openCount,
      pinned: objects.pinned,
      checksum: objects.checksum,
    })
    .from(objects)
    .leftJoin(folders, eq(objects.folderId, folders.id))
    .where(and(eq(objects.id, id), live))
    .limit(1);

  if (!row) return null;

  const [base] = await decorate([row], cutoff);

  const tagRows = await db
    .select({ name: tags.name })
    .from(objectTags)
    .innerJoin(tags, eq(objectTags.tagId, tags.id))
    .where(eq(objectTags.objectId, id));

  const refRows = await db
    .select({ app: refs.app, label: refs.label, href: refs.href })
    .from(refs)
    .where(eq(refs.objectKey, row.key));

  const [shareRow] = await db
    .select({ token: shares.token, expiresAt: shares.expiresAt, revokedAt: shares.revokedAt, hits: shares.hits })
    .from(shares)
    .where(eq(shares.objectId, id))
    .orderBy(desc(shares.createdAt))
    .limit(1);

  return {
    ...base,
    checksum: row.checksum,
    mime: row.mime,
    openCount: row.openCount,
    tags: tagRows.map((t) => t.name),
    refs: refRows,
    share: shareRow ?? null,
  };
}

/** Called whenever a file's bytes are actually served. This is the only
 *  writer of lastOpenedAt, and therefore the only thing that can move a
 *  file out of COLD. */
export async function markOpened(id: number) {
  await db
    .update(objects)
    .set({ lastOpenedAt: new Date(), openCount: sql`${objects.openCount} + 1`, updatedAt: new Date() })
    .where(eq(objects.id, id));
}

export { isUnfiled };
