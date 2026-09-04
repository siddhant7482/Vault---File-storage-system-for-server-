import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { scan } from "@/index/scan";
import { suggestForInbox } from "@/lib/suggest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* Triggers a reconciliation. Also what the systemd timer hits, so it
 * has to be safe to call twice at once — the scan itself is idempotent
 * and keyed on object keys, so the worst case is duplicated work. */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const hash = url.searchParams.get("hash") === "1";

  try {
    const result = await scan({ hash });
    const suggested = await suggestForInbox();

    await db
      .insert(settings)
      .values({ id: 1, lastScanAt: new Date() })
      .onConflictDoUpdate({ target: settings.id, set: { lastScanAt: new Date(), updatedAt: new Date() } });

    return NextResponse.json({ ...result, suggested }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
