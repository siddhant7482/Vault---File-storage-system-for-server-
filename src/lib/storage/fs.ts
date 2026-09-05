import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PutTarget, StorageDriver, StoredObject } from "./types";

/* ============================================================
   FS DRIVER — the bytes are a directory.

   Not a toy. On a single node with local disk this is a perfectly
   honest production choice, and it is what dev runs against so that
   building the app never waits on Garage being provisioned.

   The one thing S3 gives that a directory does not is presigned
   URLs, and that is the whole reason bytes do not pass through the
   app. So this driver replaces them with the same idea done by hand:
   an HMAC over key + expiry, checked by a route that then streams
   from disk. Same contract, same short lifetime, same
   unforgeability. It just costs a hop through Node.
   ============================================================ */

/* Resolved lazily, not at module scope. Two reasons, both real:
 *
 * · Turbopack statically traces filesystem access. A dynamic resolve()
 *   at import time makes it trace the WHOLE project into the standalone
 *   output, which is the artefact we copy onto the node. The ignore
 *   comment tells it this path is deliberate.
 * · Module scope runs at import, which can be before .env.local has
 *   been read by a CLI entrypoint. A function reads it when asked.
 */
let cachedRoot: string | null = null;
function root(): string {
  if (cachedRoot) return cachedRoot;
  return (cachedRoot = resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.STORAGE_FS_ROOT || ".vault-store",
  ));
}

/* A missing signing key is fatal in production — unsigned download URLs
 * would mean anything on the tailnet could read any file by guessing a
 * name. In dev an ephemeral key is fine; links just stop working on
 * restart, which is the correct amount of annoying. */
const SIGNING_KEY = (() => {
  const k = process.env.LINK_SIGNING_KEY;
  if (k) return Buffer.from(k, "utf8");
  if (process.env.NODE_ENV === "production") {
    throw new Error("LINK_SIGNING_KEY is not set — refusing to serve unsigned download links");
  }
  console.warn("[vault] LINK_SIGNING_KEY unset; using an ephemeral dev key (links die on restart)");
  return randomBytes(32);
})();

/** Keys are POSIX-ish and relative. Anything that could climb out of the
 *  root — "..", an absolute path, a drive letter, a NUL — is refused
 *  rather than sanitised, because silently rewriting a key would break
 *  the promise that a key addresses exactly one thing forever. */
function toPath(key: string): string {
  if (!key || key.startsWith("/") || key.includes("\0") || /^[a-zA-Z]:/.test(key)) {
    throw new Error(`Illegal object key: ${JSON.stringify(key)}`);
  }
  const full = resolve(root(), key.split("/").join(sep));
  if (full !== root() && !full.startsWith(root() + sep)) {
    throw new Error(`Object key escapes the store root: ${JSON.stringify(key)}`);
  }
  return full;
}

function toKey(fullPath: string): string {
  return fullPath.slice(root().length + 1).split(sep).join("/");
}

export function sign(key: string, expiresAtMs: number): string {
  return createHmac("sha256", SIGNING_KEY).update(`${key}|${expiresAtMs}`).digest("base64url");
}

/** Constant-time, and it checks expiry before signature so an expired
 *  link cannot be used as a timing oracle. */
export function verify(key: string, expiresAtMs: number, sig: string): boolean {
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return false;
  const expected = Buffer.from(sign(key, expiresAtMs));
  const given = Buffer.from(sig || "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class FsDriver implements StorageDriver {
  readonly name = "fs" as const;

  async health() {
    try {
      await mkdir(root(), { recursive: true });
      const s = await stat(/* turbopackIgnore: true */ root());
      if (!s.isDirectory()) return { ok: false, detail: `${root()} is not a directory` };
      return { ok: true, detail: root() };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async *list(prefix = ""): AsyncGenerator<StoredObject> {
    const start = prefix ? toPath(prefix) : root();
    /* Explicit stack rather than recursion: a deep tree of photos should
     * not be able to blow the call stack, and this lets a caller stop
     * iterating early without unwinding anything. */
    const stack: string[] = [start];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // vanished mid-walk, or never existed
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          const s = await stat(full);
          yield { key: toKey(full), bytes: s.size, modifiedAt: s.mtime };
        }
      }
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const s = await stat(/* turbopackIgnore: true */ toPath(key));
      return s.isFile() ? { key, bytes: s.size, modifiedAt: s.mtime } : null;
    } catch {
      return null;
    }
  }

  async getUrl(key: string, opts: { expiresIn?: number; download?: boolean; filename?: string } = {}) {
    const exp = Date.now() + (opts.expiresIn ?? 300) * 1000;
    const q = new URLSearchParams({ key, exp: String(exp), sig: sign(key, exp) });
    if (opts.download) q.set("dl", "1");
    if (opts.filename) q.set("name", opts.filename);
    return `/api/blob?${q}`;
  }

  async putTarget(key: string): Promise<PutTarget> {
    /* No signature here: the upload route is behind the same tailnet
     * boundary as the rest of the app, and unlike a download link this
     * URL is never handed to anyone else. */
    return { mode: "proxy", url: `/api/upload?key=${encodeURIComponent(key)}` };
  }

  async read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    /* Reading an arbitrary key IS the job of a file store, so Turbopack
     * cannot statically scope this and would otherwise trace the entire
     * project into the standalone output. The path is already validated
     * by toPath(), which refuses anything outside the store root. */
    const stream = createReadStream(
      /* turbopackIgnore: true */ toPath(key),
      range ? { start: range.start, end: range.end } : undefined,
    );
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  async write(key: string, body: ReadableStream<Uint8Array> | Uint8Array) {
    const full = toPath(key);
    await mkdir(dirname(full), { recursive: true });
    const source = body instanceof Uint8Array ? Readable.from(Buffer.from(body)) : Readable.fromWeb(body as never);
    await pipeline(source, createWriteStream(/* turbopackIgnore: true */ full));
  }

  async move(fromKey: string, toKey_: string) {
    const from = toPath(fromKey);
    const to = toPath(toKey_);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    await pruneEmpty(dirname(from));
  }

  async remove(key: string) {
    const full = toPath(key);
    await rm(full, { force: true });
    await pruneEmpty(dirname(full));
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

/** An emptied folder is not a folder any more. Walk up removing empties
 *  so the tree matches what a prefix listing would show in S3, where
 *  directories do not exist at all. Stops at the root. */
async function pruneEmpty(dir: string) {
  let cur = dir;
  while (cur.startsWith(root() + sep)) {
    try {
      const entries = await readdir(cur);
      if (entries.length) return;
      await rm(cur, { recursive: false, force: true });
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}
