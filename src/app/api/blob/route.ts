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

  const { mime } = classify(name);
  const safeName = name.replace(/["\\\r\n]/g, "");
  const base = {
    "content-type": mime,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
    /* Private, and no longer than the link itself lives. */
    "cache-control": "private, max-age=60",
    "x-content-type-options": "nosniff",
    /* Advertised on every response, not just partial ones — a browser
     * decides whether it can seek by looking for this on the first
     * request it makes. */
    "accept-ranges": "bytes",
  };

  const range = parseRange(req.headers.get("range"), meta.bytes);

  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...base, "content-range": `bytes */${meta.bytes}` },
    });
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await store.read(key, range ?? undefined);
  } catch {
    return new NextResponse("Unreadable", { status: 500 });
  }

  if (range) {
    return new NextResponse(stream, {
      status: 206,
      headers: {
        ...base,
        "content-range": `bytes ${range.start}-${range.end}/${meta.bytes}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }

  return new NextResponse(stream, {
    headers: { ...base, "content-length": String(meta.bytes) },
  });
}

/**
 * Parses a Range header.
 *
 * This is what makes video work at all. A browser opening a video asks
 * for a couple of bytes, then seeks to find an MP4's moov atom — which
 * is frequently at the END of the file — and a server that answers
 * every request with the whole thing either stalls forever or is
 * treated as unseekable and refused. Scrubbing needs it too.
 *
 * Deliberately handles only a single range. Multipart ranges are legal,
 * essentially unused by browsers for media, and answering them
 * incorrectly is worse than declining to: an unparseable header falls
 * through to a normal 200 with the whole body, which is always valid.
 *
 * `end` is inclusive, as HTTP specifies and as createReadStream expects.
 */
function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header || size <= 0) return null;

  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;

  if (rawStart === "") {
    /* A suffix range — "bytes=-500" means the LAST 500 bytes, not the
     * first 500. Getting this backwards serves the wrong part of the
     * file with a 206 that claims otherwise. */
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start < 0) return "unsatisfiable";
  /* A client may ask past the end; clamping is correct and expected. */
  if (end >= size) end = size - 1;
  if (end < start) return "unsatisfiable";

  return { start, end };
}
