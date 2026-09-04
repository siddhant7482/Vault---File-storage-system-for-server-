/* ============================================================
   Extension → class and content type.

   Used for the Map's fill pattern and for the Content-Type on a
   download. Both are cosmetic, which is the point: nothing here is
   trusted for a security decision, because an extension is a claim
   made by whoever named the file, not a fact about its bytes.
   ============================================================ */

export type Kind = "document" | "image" | "video" | "audio" | "archive" | "text" | "other";

const BY_EXT: Record<string, { kind: Kind; mime: string }> = {
  pdf: { kind: "document", mime: "application/pdf" },
  doc: { kind: "document", mime: "application/msword" },
  docx: { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xls: { kind: "document", mime: "application/vnd.ms-excel" },
  xlsx: { kind: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ppt: { kind: "document", mime: "application/vnd.ms-powerpoint" },
  pptx: { kind: "document", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  odt: { kind: "document", mime: "application/vnd.oasis.opendocument.text" },
  epub: { kind: "document", mime: "application/epub+zip" },

  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  svg: { kind: "image", mime: "image/svg+xml" },
  heic: { kind: "image", mime: "image/heic" },
  heif: { kind: "image", mime: "image/heif" },
  tif: { kind: "image", mime: "image/tiff" },
  tiff: { kind: "image", mime: "image/tiff" },
  bmp: { kind: "image", mime: "image/bmp" },
  /* Camera raw. Worth naming individually because these are the files
   * that quietly eat an allocation — a folder of them is gigabytes. */
  dng: { kind: "image", mime: "image/x-adobe-dng" },
  cr2: { kind: "image", mime: "image/x-canon-cr2" },
  cr3: { kind: "image", mime: "image/x-canon-cr3" },
  nef: { kind: "image", mime: "image/x-nikon-nef" },
  arw: { kind: "image", mime: "image/x-sony-arw" },
  raf: { kind: "image", mime: "image/x-fuji-raf" },

  mp4: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  mkv: { kind: "video", mime: "video/x-matroska" },
  webm: { kind: "video", mime: "video/webm" },
  avi: { kind: "video", mime: "video/x-msvideo" },
  m4v: { kind: "video", mime: "video/x-m4v" },

  mp3: { kind: "audio", mime: "audio/mpeg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  wav: { kind: "audio", mime: "audio/wav" },
  flac: { kind: "audio", mime: "audio/flac" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  opus: { kind: "audio", mime: "audio/opus" },

  zip: { kind: "archive", mime: "application/zip" },
  tar: { kind: "archive", mime: "application/x-tar" },
  gz: { kind: "archive", mime: "application/gzip" },
  tgz: { kind: "archive", mime: "application/gzip" },
  bz2: { kind: "archive", mime: "application/x-bzip2" },
  xz: { kind: "archive", mime: "application/x-xz" },
  "7z": { kind: "archive", mime: "application/x-7z-compressed" },
  rar: { kind: "archive", mime: "application/vnd.rar" },
  dmg: { kind: "archive", mime: "application/x-apple-diskimage" },

  txt: { kind: "text", mime: "text/plain; charset=utf-8" },
  md: { kind: "text", mime: "text/markdown; charset=utf-8" },
  csv: { kind: "text", mime: "text/csv; charset=utf-8" },
  json: { kind: "text", mime: "application/json" },
  yaml: { kind: "text", mime: "application/yaml" },
  yml: { kind: "text", mime: "application/yaml" },
  xml: { kind: "text", mime: "application/xml" },
  log: { kind: "text", mime: "text/plain; charset=utf-8" },
};

export function extOf(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return null;
  const ext = name.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

export function classify(name: string): { ext: string | null; kind: Kind; mime: string } {
  const ext = extOf(name);
  const hit = ext ? BY_EXT[ext] : undefined;
  return { ext, kind: hit?.kind ?? "other", mime: hit?.mime ?? "application/octet-stream" };
}

/** Which files are worth rendering a preview for at all. Everything else
 *  gets the honest "NO PREVIEW" plate rather than a broken image. */
export function previewable(kind: Kind): boolean {
  return kind === "image" || kind === "document" || kind === "text";
}
