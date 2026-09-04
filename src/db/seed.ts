import "@/env";

import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { objects, refs, settings } from "@/db/schema";
import { scan } from "@/index/scan";
import { bytes as fmtBytes } from "@/lib/format";
import { INBOX_PREFIX, joinKey, storage } from "@/lib/storage";

/* ============================================================
   `pnpm seed` — a vault worth looking at.

   SCALE. The real thing is a 30 GB allocation holding multi-gigabyte
   photo archives. Writing that to disk to look at a dev panel would
   be absurd, so everything here is divided by 1000: a 2.9 GB archive
   becomes 2.9 MB, and the allocation is set to 30 MB to match.

   Every proportion on the Map is therefore identical to production
   while the whole fixture is about 18 MB. That matters more than the
   absolute numbers — the Map's only job is showing relative area,
   and this exercises exactly the same arithmetic.

   Destructive: clears the index and the store first. It is a dev
   fixture, not a migration.
   ============================================================ */

const SCALE = 1000;
const MB = 1024 * 1024;

type Fixture = {
  path: string;
  /** Megabytes at production scale — written as kilobytes here. */
  mb: number;
  /** Days since it was last opened. null means never. */
  openedDaysAgo: number | null;
  ref?: { app: string; label: string };
  pinned?: boolean;
};

const FILES: Fixture[] = [
  { path: "Photos/Trips/Iceland raws.zip", mb: 2980, openedDaysAgo: null },
  { path: "Photos/Screenshots/Screenshots 2024.zip", mb: 2210, openedDaysAgo: null },
  { path: "Photos/Screenshots/Screenshots 2025.zip", mb: 1870, openedDaysAgo: 30 },
  { path: "Photos/Family/Family - Diwali.zip", mb: 1420, openedDaysAgo: 31, ref: { app: "archive", label: "12 memories" } },
  { path: "Photos/Trips/Newcastle flat.zip", mb: 1420, openedDaysAgo: null },
  { path: "Photos/Trips/Lisbon 2019.zip", mb: 1240, openedDaysAgo: null, ref: { app: "archive", label: "1 memory" } },
  { path: "Photos/Family/Graduation.zip", mb: 960, openedDaysAgo: 3, ref: { app: "archive", label: "4 memories" } },

  { path: "Documents/Finance/Payslips 2026.pdf", mb: 1290, openedDaysAgo: 34, ref: { app: "nori", label: "8 months" } },
  { path: "Documents/Finance/Bank statements 2024.pdf", mb: 940, openedDaysAgo: null },
  { path: "Documents/Education/Dissertation draft.pdf", mb: 620, openedDaysAgo: null },
  { path: "Documents/Finance/Bank statements 2026.pdf", mb: 9, openedDaysAgo: 4, ref: { app: "nori", label: "3 months reconciled" } },
  { path: "Documents/Housing/Tenancy agreement.pdf", mb: 4, openedDaysAgo: 24, pinned: true },
  { path: "Documents/ID/Visa correspondence.pdf", mb: 3, openedDaysAgo: 45 },
  { path: "Documents/Housing/Council tax 2026.pdf", mb: 2, openedDaysAgo: null },
  { path: "Documents/ID/Passport scan.pdf", mb: 2, openedDaysAgo: 3, pinned: true },
  { path: "Documents/ID/BRP card.jpg", mb: 2, openedDaysAgo: 18 },
  { path: "Documents/Education/Degree certificate.pdf", mb: 1, openedDaysAgo: 90 },
  { path: "Documents/Work/CV - current.pdf", mb: 1, openedDaysAgo: 0, ref: { app: "warden", label: "4 applications" }, pinned: true },

  { path: "Receipts/Groceries - 2026.zip", mb: 310, openedDaysAgo: 4, ref: { app: "nori", label: "214 transactions" } },
  { path: "Receipts/Groceries - 2025.zip", mb: 198, openedDaysAgo: null },

  { path: "Projects/CommandHQ/Warden - backups.tar", mb: 1180, openedDaysAgo: null },
  { path: "Projects/University/University archive.zip", mb: 690, openedDaysAgo: null },
  { path: "Projects/CommandHQ/CommandHQ - notes.md", mb: 1, openedDaysAgo: 0 },
];

/* Left unfiled so the Inbox has something to do. The third is a
 * byte-for-byte copy of a filed file, which is what makes duplicate
 * detection visible without waiting for a collision to happen. */
const UNFILED: { name: string; mb: number; copyOf?: string }[] = [
  { name: "Scan_20260902_114233.pdf", mb: 2 },
  { name: "IMG_8841.heic", mb: 3 },
  { name: "tenancy-agreement-copy.pdf", mb: 4, copyOf: "Documents/Housing/Tenancy agreement.pdf" },
];

async function main() {
  const store = storage();
  const health = await store.health();
  if (!health.ok) throw new Error(`storage unreachable: ${health.detail}`);
  console.log(`storage   ${store.name} — ${health.detail}`);

  /* ---- clear ---- */
  let cleared = 0;
  for await (const o of store.list()) {
    await store.remove(o.key);
    cleared += 1;
  }
  await db.execute(sql`truncate table object_tags, refs, shares, objects, folders, scans restart identity cascade`);
  console.log(`cleared   ${cleared} objects, index reset`);

  /* ---- write bytes ---- */
  const contentFor = (mb: number) => randomBytes(Math.max(512, Math.round((mb * MB) / SCALE)));

  let written = 0;
  const bodies = new Map<string, Buffer>();
  for (const f of FILES) {
    const body = contentFor(f.mb);
    bodies.set(f.path, body);
    await store.write(f.path, body);
    written += body.byteLength;
  }
  for (const u of UNFILED) {
    /* A copy has to be the SAME BYTES, or the checksums differ and the
     * duplicate never gets caught. That is the whole point of it. */
    const body = u.copyOf ? bodies.get(u.copyOf)! : contentFor(u.mb);
    await store.write(joinKey(INBOX_PREFIX, u.name), body);
    written += body.byteLength;
  }
  console.log(`wrote     ${FILES.length + UNFILED.length} objects, ${fmtBytes(written)}`);

  /* ---- allocation, scaled to match ---- */
  await db
    .insert(settings)
    .values({ id: 1, allocationBytes: Math.round((30 * 1024) / SCALE) * MB, coldDays: 365 })
    .onConflictDoUpdate({
      target: settings.id,
      set: { allocationBytes: Math.round((30 * 1024) / SCALE) * MB, updatedAt: new Date() },
    });

  /* ---- index it, hashing everything so duplicates surface ---- */
  const r = await scan({ hash: true, hashBudgetBytes: 1024 * MB });
  console.log(`scanned   ${r.seen} objects, hashed ${r.hashed}`);

  /* ---- the things a scan cannot know ---- */
  let touched = 0;
  for (const f of FILES) {
    if (f.openedDaysAgo === null) continue;
    await db
      .update(objects)
      .set({ lastOpenedAt: new Date(Date.now() - f.openedDaysAgo * 86_400_000), openCount: 1 })
      .where(eq(objects.key, f.path));
    touched += 1;
  }
  for (const f of FILES.filter((x) => x.pinned)) {
    await db.update(objects).set({ pinned: true }).where(eq(objects.key, f.path));
  }
  for (const f of FILES.filter((x) => x.ref)) {
    await db.insert(refs).values({ objectKey: f.path, app: f.ref!.app, label: f.ref!.label }).onConflictDoNothing();
  }
  console.log(`opened    ${touched} marked as used; ${FILES.length - touched} left cold`);

  await db.update(settings).set({ lastScanAt: new Date() }).where(eq(settings.id, 1));

  const [{ cold }] = await db
    .select({ cold: sql<number>`coalesce(sum(${objects.bytes}), 0)::bigint` })
    .from(objects)
    .where(sql`${objects.lastOpenedAt} is null`);

  console.log(`cold      ${fmtBytes(Number(cold))} never opened`);
  console.log(`\nready — pnpm dev, then http://localhost:3004`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nseed failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
