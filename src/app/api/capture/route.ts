import { NextResponse } from "next/server";
import type { CaptureResult } from "@/lib/status-contract";
import { bytes as fmtBytes, held } from "@/lib/format";
import { classify } from "@/lib/kind";
import { INBOX_PREFIX, joinKey, safeSegment, storage } from "@/lib/storage";
import { getMap, listUnfiled } from "@/lib/vault";

export const dynamic = "force-dynamic";

/* ============================================================
   DROP — Vault's verb on the hub's capture row.

   The other apps' capture actions complete in one POST: Warden
   logs an application, Nori snaps a receipt. A file cannot work
   that way, because the hub does not have the bytes.

   So DROP hands back an upload target instead of pretending to
   perform the capture. With s3 that is a presigned PUT straight at
   Garage; with fs it is a proxy URL. Either way the hub gets
   somewhere to send a file to, and Vault never has to claim it did
   something it did not.

   Called with no body it just reports the Inbox, which is the
   honest answer to "what would happen if I dropped something here".
   ============================================================ */

export async function POST(req: Request): Promise<NextResponse<CaptureResult & Record<string, unknown>>> {
  let name = "";
  try {
    const body = (await req.json()) as { name?: string } | null;
    name = typeof body?.name === "string" ? body.name : "";
  } catch {
    /* No body, or not JSON. That is a valid way to call this. */
  }

  try {
    if (!name.trim()) {
      const [unfiled, map] = await Promise.all([listUnfiled(), getMap()]);
      const message = unfiled.length
        ? `${unfiled.length} unfiled · oldest ${held(unfiled[0].addedAt)} · ${fmtBytes(map.freeBytes)} free`
        : `Inbox clear · ${fmtBytes(map.freeBytes)} free`;
      return NextResponse.json(
        { ok: true, message, unfiled: unfiled.length, freeBytes: map.freeBytes },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const clean = safeSegment(name.split("/").pop() || "");
    if (!clean) {
      return NextResponse.json({ ok: false, message: "That filename is not usable" }, { status: 400 });
    }

    const key = joinKey(INBOX_PREFIX, clean);
    const target = await storage().putTarget(key, { contentType: classify(clean).mime });

    return NextResponse.json(
      { ok: true, message: `Ready for ${clean}`, key, target },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
