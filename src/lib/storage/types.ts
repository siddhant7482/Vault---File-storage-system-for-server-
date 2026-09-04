/* ============================================================
   STORAGE — the seam between Vault and wherever the bytes live.

   Vault never reads or writes a file directly. It asks a driver for a
   URL and gets out of the way, because the one thing that must not
   happen is 12 GB of photos streaming through a Next.js route on a
   box with 16 GB of RAM and no swap.

   Two drivers implement this:

     fs  — a directory. Used in dev, and a legitimate production
           choice on a single node with local disk.
     s3  — Garage on the node, or anything else speaking S3.

   Both treat the bytes as the source of truth. Neither is allowed to
   invent a key, mutate one, or hold state Postgres cannot rebuild.
   ============================================================ */

/** One object as the store itself reports it. Deliberately thin: this is
 *  what a scan can know without opening anything. */
export type StoredObject = {
  /** Full key including prefix — "Documents/Housing/council-tax.pdf". */
  key: string;
  bytes: number;
  modifiedAt: Date;
  /** The store's own strong etag when it offers one. Not a checksum:
   *  multipart uploads produce etags that are not the content hash, so
   *  this is only ever used to notice that something CHANGED. */
  etag?: string;
};

export type PutTarget =
  | {
      /** The client PUTs the bytes straight at the store. Preferred:
       *  nothing passes through the app. */
      mode: "url";
      url: string;
      /** Headers the client must replay exactly or the signature fails. */
      headers: Record<string, string>;
      expiresAt: Date;
    }
  | {
      /** No presigning available, so the upload goes through an app route
       *  that streams to the driver. The fs driver takes this path. */
      mode: "proxy";
      url: string;
    };

export interface StorageDriver {
  /** Which driver this is, for /api/status and for the scan log. */
  readonly name: "fs" | "s3";

  /** Cheap reachability probe. Must not throw — return the failure. */
  health(): Promise<{ ok: boolean; detail: string }>;

  /** Every object under a prefix. Async iterator because a real vault
   *  has thousands of photos and the S3 API pages at 1000. */
  list(prefix?: string): AsyncGenerator<StoredObject>;

  /** One object's metadata, or null if it is not there. */
  head(key: string): Promise<StoredObject | null>;

  /** A time-limited URL that serves the bytes. `download` switches the
   *  content disposition from inline to attachment. */
  getUrl(key: string, opts?: { expiresIn?: number; download?: boolean; filename?: string }): Promise<string>;

  /** Where the client should send new bytes. */
  putTarget(key: string, opts: { contentType?: string; expiresIn?: number }): Promise<PutTarget>;

  /** Streams the content. Only the scanner uses this, and only to hash —
   *  nothing user-facing should ever call it. */
  read(key: string): Promise<ReadableStream<Uint8Array>>;

  /** Accepts bytes on the proxy path. */
  write(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType?: string): Promise<void>;

  /** Same bytes, new key. Used by rename and by filing, which is a move
   *  from the Inbox prefix into a folder prefix. */
  move(fromKey: string, toKey: string): Promise<void>;

  remove(key: string): Promise<void>;

  /** Total bytes held, for the allocation gauge. Walks the store when
   *  the driver cannot answer more cheaply. */
  usage(): Promise<{ bytes: number; objects: number }>;
}
