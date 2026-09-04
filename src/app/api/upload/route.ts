import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { objects } from "@/db/schema";
import { createFolder } from "@/lib/filing";
import { classify } from "@/lib/kind";
import { INBOX_PREFIX, dedupeName, joinKey, safeSegment, storage } from "@/lib/storage";
import { getSettings } from "@/lib/vault";

export const dynamic = "force-dynamic";
/* Uploads stream; they must not be buffered into a serverless-style
 * response budget. */
export const maxDuration = 300;

/* ============================================================
   Taking in a new file.

   Loose files always arrive in the Inbox. Not "sometimes", not
   "unless we can guess" — always. The Inbox carrying a count is the
   entire pressure mechanic, and an upload that quietly files itself
   somewhere clever is an upload you will never find again.

   The ONE exception is a dropped directory, which passes ?folder=.
   Dragging a folder called "Iceland 2024" in is not the app guessing
   where things belong; it is you saying so, and flattening 300 photos
   into the Inbox to honour a rule would be obeying the letter of it
   while destroying the point. Two levels deep maximum, every segment
   sanitised, and it is recorded as filed by a human because it was.

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

  /* Optional destination. Loose files always land in the Inbox; this is
   * only ever set when a whole DIRECTORY was dropped, where the folder
   * you dragged is itself a statement about where things go. That is
   * not the app being clever with your files — it is the app not
   * throwing away structure you supplied. */
  const folderParam = url.searchParams.get("folder");

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

  /* ---- resolve the destination ---- */
  let folderId: number | null = null;
  let prefix = INBOX_PREFIX;
  if (folderParam) {
    try {
      /* createFolder, not ensureFolder — it enforces the two-level cap
       * and sanitises each segment, so a dropped directory cannot
       * invent a deep tree. */
      const f = await createFolder(folderParam);
      folderId = f.id;
      prefix = f.path;
    } catch (e) {
      return NextResponse.json(
        { error: "bad folder", detail: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  /* ---- name collision at the destination ---- */
  const siblings = await db
    .select({ name: objects.name })
    .from(objects)
    .where(
      and(
        folderId === null ? isNull(objects.folderId) : eq(objects.folderId, folderId),
        isNull(objects.deletedAt),
      ),
    );
  const taken = new Set(siblings.map((r) => r.name.toLowerCase()));
  const finalName = dedupeName(name, (c) => taken.has(c.toLowerCase()));
  const key = joinKey(prefix, finalName);

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
      folderId,
      /* A dropped directory is a human saying where things go, so it
       * counts as filed by one — not as something the model or a scan
       * decided. */
      filedBy: folderId === null ? "imported" : "human",
      filedAt: folderId === null ? null : now,
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
