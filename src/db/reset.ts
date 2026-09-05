import "@/env";

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { folders, settings } from "@/db/schema";
import { bytes as fmtBytes } from "@/lib/format";
import { storage } from "@/lib/storage";

/* ============================================================
   `pnpm reset` — an empty vault, ready for real files.

   Different from `pnpm seed`, which fills the vault with a scaled
   fixture for looking at. This empties it and puts the allocation
   back to its real size, which is the state you want before putting
   your own documents in.

   It creates an empty FOLDER SKELETON by default. That is not
   decoration: suggested filing works by choosing from the folders
   that already exist, and refuses to invent a taxonomy for you. With
   no folders at all, the first file you drop gets no suggestion and
   the feature looks broken when it is in fact being careful. Pass
   --bare to skip it and start from nothing.

   DESTRUCTIVE, and it hard-deletes: no undo window, no backup. It
   refuses to run against a vault that holds anything unless you pass
   --force, because it was written as a dev fixture and then run
   against a deployed vault full of real photos.
   ============================================================ */

/* Two levels, matching the design. Deliberately generic — these are a
 * starting point to rename, not a filing system anyone should have to
 * live with. */
const SKELETON = [
  "Documents/Housing",
  "Documents/ID",
  "Documents/Finance",
  "Documents/Work",
  "Documents/Education",
  "Photos/Trips",
  "Photos/Family",
  "Photos/Screenshots",
  "Receipts",
  "Projects",
];

async function main() {
  const args = process.argv.slice(2);
  const bare = args.includes("--bare");
  const force = args.includes("--force");

  const store = storage();
  const health = await store.health();
  if (!health.ok) throw new Error(`storage unreachable: ${health.detail}`);
  console.log(`storage   ${store.name} — ${health.detail}`);

  /* ---- refuse to run over anything real ----
   *
   * This script hard-deletes. It bypasses trashObject's undo window and
   * calls store.remove() directly, so there is nothing to restore
   * afterwards and no backup to fall back on until restic is wired up.
   *
   * It was written as a dev fixture and then run against a deployed
   * vault that had been filled with real photos in the meantime. Three
   * objects and 122 MB went, permanently, because nothing between the
   * intent and the deletion asked whether the vault was empty.
   *
   * So now it counts first and stops. --force is the only way past,
   * and it has to be typed deliberately every single time. */
  const existing: { key: string; bytes: number }[] = [];
  for await (const o of store.list()) existing.push({ key: o.key, bytes: o.bytes });
  const totalBytes = existing.reduce((n, o) => n + o.bytes, 0);

  if (existing.length && !force) {
    console.error(`\nREFUSING TO RESET — this vault holds ${existing.length} object${existing.length === 1 ? "" : "s"}, ${fmtBytes(totalBytes)}.`);
    console.error("");
    for (const o of existing.slice(0, 10)) console.error(`  ${o.key}  (${fmtBytes(o.bytes)})`);
    if (existing.length > 10) console.error(`  … and ${existing.length - 10} more`);
    console.error("");
    console.error("This deletes bytes permanently. There is no undo window and no backup.");
    console.error("If you are certain: pnpm reset -- --force");
    process.exit(1);
  }

  /* ---- bytes ---- */
  let removed = 0;
  let freed = 0;
  for (const o of existing) {
    await store.remove(o.key);
    removed += 1;
    freed += o.bytes;
  }
  console.log(`removed   ${removed} objects, ${fmtBytes(freed)}`);

  /* ---- index ---- */
  await db.execute(
    sql`truncate table object_tags, refs, shares, objects, folders, scans restart identity cascade`,
  );
  console.log(`index     truncated`);

  /* ---- allocation, back to the real ceiling ---- */
  const gb = Number(process.env.VAULT_ALLOCATION_GB || 30);
  const coldDays = Number(process.env.VAULT_COLD_DAYS || 365);
  const allocationBytes = gb * 1024 ** 3;

  await db
    .insert(settings)
    .values({ id: 1, allocationBytes, coldDays })
    .onConflictDoUpdate({
      target: settings.id,
      set: { allocationBytes, coldDays, lastScanAt: null, updatedAt: new Date() },
    });
  console.log(`allocation ${gb} GB, cold after ${coldDays} days`);

  /* ---- folder skeleton ---- */
  if (bare) {
    console.log(`folders   none (--bare)`);
  } else {
    /* Insert parents before children so parent_id can be filled in one
     * pass. Sorting by depth guarantees that. */
    const paths = [...new Set(SKELETON.flatMap(expand))].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    const idByPath = new Map<string, number>();
    for (const path of paths) {
      const parts = path.split("/");
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join("/");
      const [row] = await db
        .insert(folders)
        .values({ path, name, parentId: parentPath ? (idByPath.get(parentPath) ?? null) : null })
        .returning({ id: folders.id });
      idByPath.set(path, row.id);
    }
    console.log(`folders   ${paths.length} created, all empty`);
  }

  console.log(`\nempty — drag files onto the panel, or:`);
  console.log(`  curl -X POST --data-binary @thing.pdf "http://localhost:3004/api/upload?name=thing.pdf"`);
  process.exit(0);
}

/** "Documents/Housing" implies "Documents" too. */
function expand(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

main().catch((e) => {
  console.error(`\nreset failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
