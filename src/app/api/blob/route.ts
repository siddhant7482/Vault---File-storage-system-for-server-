import { NextResponse } from "next/server";
import { verify } from "@/lib/storage/fs";
import { classify } from "@/lib/kind";
import { keyName, storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/* ============================================================
   Serves bytes for the fs driver, and only for the fs driver.

   With s3 the browser talks straight to Garage on a presigned URL
   and this route is never reached. With fs there is nothing to
   presign, so this stands in for it: an HMAC over key + expiry,
   checked here, then a stream from disk.

   The security property to preserve is that possessing this URL is
   the ONLY thing that grants access, and only briefly. So:

     · the signature covers the expiry, so it cannot be extended
     · verification is constant-time and checks expiry first
     · the key is never trusted as a path — the driver re-validates
       it and refuses anything that could climb out of the root
     · no database lookup happens here at all, which means this
       route cannot be used to enumerate what exists

   It deliberately does NOT record an open. That already happened
   when the URL was issued, and counting it twice would inflate the
   one statistic COLD depends on.
   ============================================================ */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const exp = Number(url.searchParams.get("exp") || 0);
  const sig = url.searchParams.get("sig") || "";
  const download = url.searchParams.get("dl") === "1";
  const name = url.searchParams.get("name") || keyName(key);

  const store = storage();
  if (store.name !== "fs") {
    /* On s3 this route should never be called. If something does call
     * it, say so plainly rather than quietly serving anything. */
    return NextResponse.json({ error: "not applicable for the s3 driver" }, { status: 400 });
  }

  if (!key || !verify(key, exp, sig)) {
    /* One status for every failure mode — expired, forged, malformed,
     * missing. Distinguishing them here would leak which keys exist. */
    return new NextResponse("Link expired or invalid", { status: 403 });
  }

  const meta = await store.head(key);
  if (!meta) return new NextResponse("Gone", { status: 404 });

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await store.read(key);
  } catch {
    return new NextResponse("Unreadable", { status: 500 });
  }

  const { mime } = classify(name);
  const safeName = name.replace(/["\\\r\n]/g, "");

  return new NextResponse(stream, {
    headers: {
      "content-type": mime,
      "content-length": String(meta.bytes),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
      /* Private, and no longer than the link itself lives. */
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}
