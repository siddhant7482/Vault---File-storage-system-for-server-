import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { objects } from "@/db/schema";
import { storage } from "@/lib/storage";
import { markOpened } from "@/lib/vault";

export const dynamic = "force-dynamic";

/* ============================================================
   Issue a short-lived URL for one object's bytes.

   This is the ONLY place that decides a file has been opened, and
   that decision is load-bearing: COLD is the feature this app is
   built around, and it is worth nothing if the count drifts.

   So the intent matters.

     intent=open      a human asked for this file. Counts.
     intent=preview   the detail panel is rendering a thumbnail
                      because the row happened to be selected.
                      Does NOT count.

   Glancing at a preview is not using a file. If previews cleared
   COLD, the flag would evaporate the first time you scrolled the
   index, and the one number nobody could argue with would become
   the one number nobody trusts.
   ============================================================ */

const PREVIEW_TTL = 120;
const OPEN_TTL = 300;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const intent = url.searchParams.get("intent") === "preview" ? "preview" : "open";
  const download = url.searchParams.get("download") === "1";

  const [row] = await db
    .select({ key: objects.key, name: objects.name, deletedAt: objects.deletedAt })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1);

  if (!row || row.deletedAt) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const store = storage();
  const signed = await store.getUrl(row.key, {
    expiresIn: intent === "preview" ? PREVIEW_TTL : OPEN_TTL,
    download,
    filename: row.name,
  });

  if (intent === "open") await markOpened(id);

  return NextResponse.json(
    { url: signed, name: row.name, counted: intent === "open" },
    { headers: { "cache-control": "no-store" } },
  );
}
