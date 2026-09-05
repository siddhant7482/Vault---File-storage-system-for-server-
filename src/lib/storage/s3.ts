import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PutTarget, StorageDriver, StoredObject } from "./types";

/* ============================================================
   S3 DRIVER — Garage on the node.

   Garage rather than MinIO: ~100 MB resident against 300–400, which
   matters on a box with 16 GB that will never be upgraded. It speaks
   enough of the S3 API for everything here, including presigned GET
   and PUT, which is the part that keeps bytes out of the app.

   Nothing below is Garage-specific. Point it at MinIO, B2 or R2 and
   it works, which is the escape hatch if Garage ever disappoints.
   ============================================================ */

const BUCKET = process.env.S3_BUCKET || "vault";

function client() {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 driver selected but S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not all set");
  }
  return new S3Client({
    endpoint,
    region: process.env.S3_REGION || "garage",
    credentials: { accessKeyId, secretAccessKey },
    /* Garage and MinIO address buckets by path, not by subdomain. Leave
     * this off and every request 404s in a way that looks like the
     * bucket is missing. */
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  });
}

/* One client for the process. The SDK pools sockets internally and
 * rebuilding it per request leaks handles under load. */
const globalForS3 = globalThis as unknown as { __vaultS3?: S3Client };
function s3() {
  return (globalForS3.__vaultS3 ??= client());
}

export class S3Driver implements StorageDriver {
  readonly name = "s3" as const;

  async health() {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: BUCKET }));
      return { ok: true, detail: `${process.env.S3_ENDPOINT}/${BUCKET}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async *list(prefix = ""): AsyncGenerator<StoredObject> {
    let token: string | undefined;
    do {
      const res = await s3().send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix || undefined,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const o of res.Contents ?? []) {
        /* S3 has no directories, but consoles fake them with zero-byte
         * keys ending in "/". Those are not files and must not appear
         * in the index or they show up as 0-byte blocks on the Map. */
        if (!o.Key || o.Key.endsWith("/")) continue;
        yield {
          key: o.Key,
          bytes: o.Size ?? 0,
          modifiedAt: o.LastModified ?? new Date(),
          etag: o.ETag?.replace(/"/g, ""),
        };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const r = await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return {
        key,
        bytes: r.ContentLength ?? 0,
        modifiedAt: r.LastModified ?? new Date(),
        etag: r.ETag?.replace(/"/g, ""),
      };
    } catch {
      return null;
    }
  }

  async getUrl(key: string, opts: { expiresIn?: number; download?: boolean; filename?: string } = {}) {
    const filename = (opts.filename || key.split("/").pop() || "file").replace(/"/g, "");
    return getSignedUrl(
      s3(),
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ResponseContentDisposition: opts.download
          ? `attachment; filename="${filename}"`
          : `inline; filename="${filename}"`,
      }),
      { expiresIn: opts.expiresIn ?? 300 },
    );
  }

  async putTarget(key: string, opts: { contentType?: string; expiresIn?: number } = {}): Promise<PutTarget> {
    const expiresIn = opts.expiresIn ?? 900;
    const url = await getSignedUrl(
      s3(),
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: opts.contentType }),
      { expiresIn },
    );
    return {
      mode: "url",
      url,
      /* Signed over, so the browser must send exactly this or the
       * signature check fails with a confusing 403. */
      headers: opts.contentType ? { "content-type": opts.contentType } : {},
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    const r = await s3().send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        /* Same inclusive-end convention as HTTP, which is where S3 took
         * it from. In practice this path is rarely used with s3 — the
         * browser talks to Garage directly on a presigned URL and gets
         * range support from it — but the scanner and any proxy read
         * should behave identically across drivers. */
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    if (!r.Body) throw new Error(`No body for ${key}`);
    return r.Body.transformToWebStream() as ReadableStream<Uint8Array>;
  }

  async write(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType?: string) {
    /* The SDK needs a length for a stream, and we do not have one on the
     * proxy path — so buffer. Only the fs driver normally takes that
     * path; here it is a fallback for small writes, not the hot road. */
    const bytes =
      body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: contentType }));
  }

  async move(fromKey: string, toKey: string) {
    /* S3 has no rename. Copy then delete, and only delete once the copy
     * has been acknowledged — the reverse order loses the file if the
     * copy fails. */
    await s3().send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        Key: toKey,
        CopySource: `${BUCKET}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
      }),
    );
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: fromKey }));
  }

  async remove(key: string) {
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  }

  async usage() {
    let bytes = 0;
    let objects = 0;
    for await (const o of this.list()) {
      bytes += o.bytes;
      objects += 1;
    }
    return { bytes, objects };
  }
}
