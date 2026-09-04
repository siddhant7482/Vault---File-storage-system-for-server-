import { and, eq, isNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { folders, objects } from "@/db/schema";
import { classify } from "@/lib/kind";
import { INBOX_PREFIX, dedupeName, joinKey, keyName, safeSegment, storage } from "@/lib/storage";

/* ============================================================
   Filing — moving bytes out of the Inbox and into a folder.

   Filing is a MOVE IN THE STORE, not a database update. The key
   changes, the folder row follows, and a scan run immediately
   afterwards agrees with what just happened. Any design where the
   index says "Documents/Housing" and the bucket says "_inbox" is a
   design that eventually loses a file.

   Order matters and is deliberate:

     1. work out the destination key, deduplicating the name
     2. move the bytes
     3. update the index

   If step 2 fails, nothing has changed. If step 3 fails, the bytes
   are in the right place and the next scan repairs the index. The
   reverse order can leave the index pointing at a key that does not
   exist, which looks exactly like data loss to the person using it.
   ============================================================ */

export type FilingTarget = { folderPath: string; name?: string };

/** Resolves "Documents/Housing" to a folder row, creating the chain if
 *  it does not exist yet. Folders are cheap; a filing that fails
 *  because a folder is missing is not. */
export async function ensureFolder(path: string): Promise<number> {
  const clean = path.split("/").map(safeSegment).filter(Boolean).join("/");
  if (!clean) throw new Error("Empty folder path");

  const parts = clean.split("/");
  let parentId: number | null = null;
  let built = "";

  for (const part of parts) {
    built = built ? `${built}/${part}` : part;
    const [existing] = await db.select({ id: folders.id }).from(folders).where(eq(folders.path, built)).limit(1);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    /* Annotated rather than inferred: `parentId` feeds the insert and
     * the insert's return type feeds `parentId`, which TypeScript sees
     * as circular unless one end is pinned down. */
    const inserted: { id: number }[] = await db
      .insert(folders)
      .values({ path: built, name: part, parentId })
      .onConflictDoNothing({ target: folders.path })
      .returning({ id: folders.id });
    const created = inserted[0];

    if (created) {
      parentId = created.id;
    } else {
      /* Lost a race with a concurrent filing. Re-read rather than
       * failing — two people filing at once is not an error. */
      const [found] = await db.select({ id: folders.id }).from(folders).where(eq(folders.path, built)).limit(1);
      if (!found) throw new Error(`Could not create folder ${built}`);
      parentId = found.id;
    }
  }

  return parentId!;
}

/* ------------------------------------------------------------
   Folder maintenance.

   A folder IS a key prefix. So renaming one is not a metadata edit —
   it is a move of every object underneath it, and the same discipline
   applies: bytes first, index second. Do it the other way round and
   the index points at keys that do not exist, which looks exactly
   like data loss to whoever is holding the laptop.
   ------------------------------------------------------------ */

export async function createFolder(path: string): Promise<{ id: number; path: string }> {
  const clean = path.split("/").map(safeSegment).filter(Boolean).join("/");
  if (!clean) throw new Error("Empty folder name");
  /* Two levels is the whole design. Deeper nesting is how a file store
   * turns into somewhere things go missing. */
  if (clean.split("/").length > 2) throw new Error("Two levels only — Documents/Housing, not deeper");
  const id = await ensureFolder(clean);
  return { id, path: clean };
}

export async function renameFolder(id: number, rawName: string): Promise<{ path: string }> {
  const [folder] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
  if (!folder) throw new Error("No such folder");

  const name = safeSegment(rawName.trim());
  if (!name) throw new Error("Empty name");
  if (name === folder.name) return { path: folder.path };

  const parentPath = folder.path.includes("/") ? folder.path.slice(0, folder.path.lastIndexOf("/")) : "";
  const newPath = parentPath ? `${parentPath}/${name}` : name;

  const [clash] = await db.select({ id: folders.id }).from(folders).where(eq(folders.path, newPath)).limit(1);
  if (clash) throw new Error(`${newPath} already exists`);

  /* Every object at or below the old prefix, including grandchildren. */
  const affected = await db
    .select({ id: objects.id, key: objects.key })
    .from(objects)
    .where(and(isNull(objects.deletedAt), like(objects.key, `${folder.path}/%`)));

  const store = storage();
  const moved: { id: number; key: string }[] = [];
  for (const o of affected) {
    const destKey = newPath + o.key.slice(folder.path.length);
    await store.move(o.key, destKey);
    moved.push({ id: o.id, key: destKey });
  }
  for (const m of moved) {
    await db.update(objects).set({ key: m.key, updatedAt: new Date() }).where(eq(objects.id, m.id));
  }

  /* The folder itself, then every descendant's path prefix. */
  await db.update(folders).set({ path: newPath, name }).where(eq(folders.id, id));
  const descendants = await db
    .select({ id: folders.id, path: folders.path })
    .from(folders)
    .where(like(folders.path, `${folder.path}/%`));
  for (const d of descendants) {
    await db
      .update(folders)
      .set({ path: newPath + d.path.slice(folder.path.length) })
      .where(eq(folders.id, d.id));
  }

  return { path: newPath };
}

/**
 * Only ever removes an EMPTY folder, and never touches a byte.
 *
 * Deleting a folder full of files is not a thing this app will do in
 * one click. If the files should go, trash them and watch the number
 * go down; if they should move, move them. A recursive folder delete
 * is the single easiest way to lose something irreplaceable, and it
 * saves about four seconds.
 */
export async function deleteFolder(id: number): Promise<void> {
  const [folder] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
  if (!folder) throw new Error("No such folder");

  const [{ n: fileCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(objects)
    .where(and(isNull(objects.deletedAt), like(objects.key, `${folder.path}/%`)));
  if (fileCount > 0) {
    throw new Error(`${folder.path} holds ${fileCount} file${fileCount === 1 ? "" : "s"} — move or trash them first`);
  }

  const [{ n: childCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(folders)
    .where(like(folders.path, `${folder.path}/%`));
  if (childCount > 0) throw new Error(`${folder.path} has subfolders — remove them first`);

  await db.delete(folders).where(eq(folders.id, id));
}

/** Every name already used in a folder, so a move never overwrites. */
async function namesIn(folderId: number): Promise<Set<string>> {
  const rows = await db
    .select({ name: objects.name })
    .from(objects)
    .where(and(eq(objects.folderId, folderId), isNull(objects.deletedAt)));
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export async function fileObject(
  id: number,
  target: FilingTarget,
  by: "human" | "suggested" | "rule" = "human",
): Promise<{ key: string; name: string; folderPath: string }> {
  const [row] = await db
    .select({ id: objects.id, key: objects.key, name: objects.name, deletedAt: objects.deletedAt })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1);

  if (!row || row.deletedAt) throw new Error("No such file");

  const folderId = await ensureFolder(target.folderPath);
  const [folder] = await db.select({ path: folders.path }).from(folders).where(eq(folders.id, folderId)).limit(1);

  const taken = await namesIn(folderId);
  const wanted = safeSegment(target.name?.trim() || row.name);
  const finalName = dedupeName(wanted, (c) => taken.has(c.toLowerCase()));
  const destKey = joinKey(folder.path, finalName);

  if (destKey === row.key) {
    /* Already exactly where it was asked to go. Still record the
     * filing, because "imported" and "filed by a human" are different
     * facts even when the key is the same. */
    await db
      .update(objects)
      .set({ folderId, filedBy: by, filedAt: new Date(), suggestion: null, updatedAt: new Date() })
      .where(eq(objects.id, id));
    return { key: destKey, name: finalName, folderPath: folder.path };
  }

  await storage().move(row.key, destKey);

  const { ext, kind, mime } = classify(finalName);
  await db
    .update(objects)
    .set({
      key: destKey,
      name: finalName,
      folderId,
      filedBy: by,
      filedAt: new Date(),
      ext,
      kind,
      mime,
      suggestion: null,
      updatedAt: new Date(),
    })
    .where(eq(objects.id, id));

  return { key: destKey, name: finalName, folderPath: folder.path };
}

/** Rename in place. Same move discipline: bytes first, index second. */
export async function renameObject(id: number, rawName: string): Promise<{ key: string; name: string }> {
  const [row] = await db
    .select({ key: objects.key, name: objects.name, folderId: objects.folderId })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1);
  if (!row) throw new Error("No such file");

  const wanted = safeSegment(rawName.trim());
  if (!wanted) throw new Error("Empty name");
  if (wanted === row.name) return { key: row.key, name: row.name };

  const taken = row.folderId ? await namesIn(row.folderId) : new Set<string>();
  const finalName = dedupeName(wanted, (c) => taken.has(c.toLowerCase()));

  const prefix = row.key.slice(0, row.key.lastIndexOf("/") + 1);
  const destKey = prefix + finalName;

  await storage().move(row.key, destKey);

  const { ext, kind, mime } = classify(finalName);
  await db
    .update(objects)
    .set({ key: destKey, name: finalName, ext, kind, mime, updatedAt: new Date() })
    .where(eq(objects.id, id));

  return { key: destKey, name: finalName };
}

/** Back to the Inbox. Used by undo, and by "this was filed wrong". */
export async function unfileObject(id: number): Promise<string> {
  const [row] = await db.select({ key: objects.key, name: objects.name }).from(objects).where(eq(objects.id, id)).limit(1);
  if (!row) throw new Error("No such file");

  const destKey = joinKey(INBOX_PREFIX, keyName(row.key));
  await storage().move(row.key, destKey);
  await db
    .update(objects)
    .set({ key: destKey, folderId: null, filedBy: "imported", filedAt: null, updatedAt: new Date() })
    .where(eq(objects.id, id));
  return destKey;
}

/**
 * Soft delete. The bytes stay until a sweep runs.
 *
 * Deliberate: the cost of an undo window is a few gigabytes for a few
 * days; the cost of not having one is the only copy of a passport
 * scan. On a 30 GB allocation that trade still favours the window.
 */
export async function trashObject(id: number) {
  await db.update(objects).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(objects.id, id));
}

export async function restoreObject(id: number) {
  await db.update(objects).set({ deletedAt: null, updatedAt: new Date() }).where(eq(objects.id, id));
}

/** Actually removes bytes for anything trashed longer ago than the
 *  window. Run by the same timer as the scan. */
export async function sweepTrash(olderThanDays = 14): Promise<{ removed: number; bytes: number }> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const rows = await db
    .select({ id: objects.id, key: objects.key, bytes: objects.bytes })
    .from(objects)
    .where(sql`${objects.deletedAt} is not null and ${objects.deletedAt} < ${cutoff}`);

  const store = storage();
  let removed = 0;
  let freed = 0;
  for (const r of rows) {
    try {
      await store.remove(r.key);
      await db.delete(objects).where(eq(objects.id, r.id));
      removed += 1;
      freed += r.bytes;
    } catch {
      /* Leave it for the next sweep rather than dropping the index row
       * for bytes that are still on disk. */
    }
  }
  return { removed, bytes: freed };
}
