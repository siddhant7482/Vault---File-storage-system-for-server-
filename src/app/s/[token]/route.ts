import { NextResponse } from "next/server";
import { redeem } from "@/lib/share";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/* ============================================================
   Redeeming a share link.

   The one route in Vault that an untrusted stranger can reach, so
   it does as little as possible:

     · resolves the token, or 404s
     · issues a short-lived storage URL and redirects to it
     · never reveals the object key, the folder, or anything about
       what else exists

   Redeeming does NOT mark the file as opened. Someone else reading
   a document you sent them is not you using it, and COLD is a
   statement about YOUR relationship to a file. Conflating the two
   would let a share quietly launder a file out of the cold list.

   A wrong, expired or revoked token all return the same 404 with
   the same body. Distinguishing them would confirm that a token
   once existed.
   ============================================================ */

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const hit = token ? await redeem(token) : null;
  if (!hit) {
    return new NextResponse("This link has expired or does not exist.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const url = await storage().getUrl(hit.key, {
    expiresIn: 300,
    download: true,
    filename: hit.name,
  });

  /* Relative for the fs driver, absolute for s3 — NextResponse.redirect
   * needs an absolute URL, so resolve against the incoming request. */
  const absolute = url.startsWith("http") ? url : new URL(url, _req.url).toString();

  return NextResponse.redirect(absolute, {
    status: 302,
    headers: { "cache-control": "no-store" },
  });
}
