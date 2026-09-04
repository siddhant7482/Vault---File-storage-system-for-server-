import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { refs } from "@/db/schema";

export const dynamic = "force-dynamic";

/* ============================================================
   How the other apps tell Vault a file matters.

   Warden posts "this CV is attached to 4 applications". Nori posts
   "this statement covers 3 reconciled months". Archive posts "this
   zip is 12 memories". Vault reads them and shows them, so that
   before you delete something you can see what it is load-bearing
   for across the whole node.

   Two decisions worth stating:

   · Keyed by OBJECT KEY, not id. An app can register a reference
     to something before Vault has indexed it, and the key is the
     one identifier that never changes.

   · One row per (app, key), upserted. Apps re-post their whole
     claim rather than appending, so a re-sync in Warden cannot
     multiply the same reference four times over.

   No auth on this. Everything on the node sits behind Tailscale,
   and adding a shared secret between six apps that already trust
   each other buys nothing but a rotation problem.
   ============================================================ */

const Body = z.object({
  app: z.string().min(1).max(32),
  objectKey: z.string().min(1).max(1024),
  /** Human-readable, written by the app that owns the reference. */
  label: z.string().min(1).max(120),
  href: z.string().max(512).nullable().optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: "bad body", detail: String(e) }, { status: 400 });
  }

  await db
    .insert(refs)
    .values({
      app: parsed.app,
      objectKey: parsed.objectKey,
      label: parsed.label,
      href: parsed.href ?? null,
    })
    .onConflictDoUpdate({
      target: [refs.app, refs.objectKey],
      set: { label: parsed.label, href: parsed.href ?? null, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/** An app dropping its claim — the CV is no longer attached to
 *  anything, so the lamp on that row should go out. */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const app = url.searchParams.get("app");
  const objectKey = url.searchParams.get("objectKey");
  if (!app || !objectKey) {
    return NextResponse.json({ error: "app and objectKey are required" }, { status: 400 });
  }

  await db.delete(refs).where(and(eq(refs.app, app), eq(refs.objectKey, objectKey)));
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
