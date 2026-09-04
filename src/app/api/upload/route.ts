import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { objects } from "@/db/schema";
import { classify } from "@/lib/kind";
import { INBOX_PREFIX, dedupeName, joinKey, safeSegment, storage } from "@/lib/storage";
import { getSettings } from "@/lib/vault";

export const dynamic = "force-dynamic";
/* Uploads stream; they must not be buffered into a serverless-style
 * response budget. */
export const maxDuration = 300;

/* ============================================================
   Taking in a new file.

   Everything arrives in the Inbox. Not "sometimes", not "unless we
   can guess" — always. The Inbox carrying a count is the entire
   pressure mechanic, and an upload that quietly files itself
   somewhere clever is an upload you will never find again.

   Two guards before a byte is written:

     1. The allocation. Vault refuses to grow past its ceiling.
        A tight ship that silently loosens is not a tight ship, and
        on a 119 GB disk shared with five other apps, "just this
        once" is how you fill a root partition.

     2. The name. Sanitised, then deduplicated against what is
        already in the Inbox. Overwriting is never an outcome.
   ============================================================ */

export async function POST(req: Request) {
  const url = new URL(req.url);
  const rawName = url.searchParams.get("name") || url.searchParams.get("key") || "";
  const declaredLength = Number(req.headers.get("content-length") || 0);

  const name = safeSegment(rawName.split("/").pop() || "");
  if (!name) return NextResponse.json({ error: "a filename is required" }, { status: 400 });

  /* ---- allocation check ---- */
  const settings = await getSettings();
  const [{ used }] = await db
    .select({ used: sql<number>`coalesce(sum(${objects.bytes}), 0)::bigint` })
    .from(objects)
    .where(isNull(objects.deletedAt));

  const usedBytes = Number(used);
  if (declaredLength && usedBytes + declaredLength > settings.allocationBytes) {
    return NextResponse.json(
      {
        error: "allocation full",
        detail: `This file would take Vault past its ${Math.round(settings.allocationBytes / 1024 ** 3)} GB allocation.`,
        usedBytes,
        allocationBytes: settings.allocationBytes,
      },
      { status: 507 },
    );
  }

  /* ---- name collision inside the inbox ---- */
  const inboxRows = await db
    .select({ name: objects.name })
    .from(objects)
    .where(and(isNull(objects.folderId), isNull(objects.deletedAt)));
  const taken = new Set(inboxRows.map((r) => r.name.toLowerCase()));
  const finalName = dedupeName(name, (c) => taken.has(c.toLowerCase()));
  const key = joinKey(INBOX_PREFIX, finalName);

  if (!req.body) return NextResponse.json({ error: "no body" }, { status: 400 });

  const store = storage();
  try {
    await store.write(key, req.body as ReadableStream<Uint8Array>, classify(finalName).mime);
  } catch (e) {
    return NextResponse.json(
      { error: "write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  /* Read the size back from the store rather than trusting the header —
   * a truncated upload must not be indexed at its claimed length or the
   * Map will draw a block that does not exist. */
  const meta = await store.head(key);
  if (!meta) {
    return NextResponse.json({ error: "wrote nothing" }, { status: 502 });
  }

  const { ext, kind, mime } = classify(finalName);
  const now = new Date();
  const [row] = await db
    .insert(objects)
    .values({
      key,
      name: finalName,
      folderId: null,
      filedBy: "imported",
      ext,
      kind,
      mime,
      bytes: meta.bytes,
      addedAt: now,
      modifiedAt: meta.modifiedAt,
    })
    .onConflictDoUpdate({
      target: objects.key,
      set: { bytes: meta.bytes, modifiedAt: meta.modifiedAt, deletedAt: null, updatedAt: now },
    })
    .returning({ id: objects.id });

  return NextResponse.json(
    { id: row.id, key, name: finalName, bytes: meta.bytes },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

/** Where to send the bytes. With s3 the client PUTs straight at Garage
 *  and never touches this app; with fs it comes back here. Either way
 *  the caller does not need to know which driver is configured. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = safeSegment((url.searchParams.get("name") || "").split("/").pop() || "");
  if (!name) return NextResponse.json({ error: "a filename is required" }, { status: 400 });

  const store = storage();
  const key = joinKey(INBOX_PREFIX, name);
  const target = await store.putTarget(key, { contentType: classify(name).mime });

  return NextResponse.json({ key, target }, { headers: { "cache-control": "no-store" } });
}
