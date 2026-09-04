import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { folders, objects } from "@/db/schema";
import { safeSegment } from "@/lib/storage";

/* ============================================================
   Suggested filing.

   The feature that makes tidiness cheaper than mess: most filing
   systems fail because putting a file away costs more than dropping
   it, so this inverts the cost. One tap to accept, always possible
   to override, never automatic.

   WHAT IS SENT: the filename, the extension, the size, and the list
   of folders that already exist. That is all. Not the contents, not
   a page of text, not a thumbnail. A file store that ships your
   documents to a third party to tidy them is not a file store you
   should keep documents in — and a filename carries almost all of
   the signal anyway ("Scan_20260902.pdf" is uninformative whether or
   not the model has read it).

   THE PROMPT SHOWS THE EXACT JSON SHAPE rather than describing the
   fields in prose. Warden learned this the hard way: describing a
   field called `kind` in a sentence got back `classification`, and
   the parse failed silently. Show the shape, get the shape.
   ============================================================ */

export type Suggestion = { folder: string; name: string; reason: string };

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function suggestionsEnabled(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

export async function suggestFiling(objectId: number): Promise<Suggestion | null> {
  if (!suggestionsEnabled()) return null;

  const [file] = await db
    .select({ name: objects.name, ext: objects.ext, kind: objects.kind, bytes: objects.bytes })
    .from(objects)
    .where(and(eq(objects.id, objectId), isNull(objects.deletedAt)))
    .limit(1);
  if (!file) return null;

  const folderRows = await db.select({ path: folders.path }).from(folders).orderBy(folders.path);
  const paths = folderRows.map((f) => f.path);
  /* With no folders yet there is nothing to choose between, and inventing
   * a taxonomy for someone is exactly the kind of "clever" this app
   * avoids. Stay quiet until there is a shape to fit into. */
  if (paths.length === 0) return null;

  const body = {
    model: process.env.OPENROUTER_FILING_MODEL || "anthropic/claude-haiku-4.5",
    temperature: 0,
    max_tokens: 300,
    messages: [
      {
        role: "system",
        content: [
          "You file documents into an existing folder structure.",
          "",
          "Reply with ONLY this JSON object, no prose, no code fence:",
          '{"folder":"","name":"","reason":""}',
          "",
          '"folder" MUST be copied exactly from the FOLDERS list. Never invent one.',
          '"name" is a tidier filename, keeping the original extension.',
          "  Prefer a leading ISO date when the original encodes one: 2026-09 Council Tax Bill.pdf",
          '"reason" is at most 12 words, explaining the choice.',
          "",
          "You are given the FILENAME only — never the contents. If the",
          "filename does not justify a confident choice, return the folder",
          'you consider most likely and say so in "reason".',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `FILENAME: ${file.name}`,
          `EXTENSION: ${file.ext ?? "none"}`,
          `CLASS: ${file.kind}`,
          `SIZE: ${file.bytes} bytes`,
          "",
          "FOLDERS:",
          ...paths.map((p) => `- ${p}`),
        ].join("\n"),
      },
    ],
  };

  let raw: string;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "x-title": "CommandHQ Vault",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    raw = json.choices?.[0]?.message?.content ?? "";
  } catch {
    /* A suggestion is a convenience. If the model is slow, rate-limited
     * or down, the Inbox still works — it just asks you where things go. */
    return null;
  }

  const parsed = parse(raw);
  if (!parsed) return null;

  /* The model is not trusted to name a destination. If it returns a
   * folder that does not exist — a hallucinated one, a near-miss, a
   * different casing — the suggestion is dropped rather than silently
   * creating a folder nobody asked for. */
  const folder = paths.find((p) => p.toLowerCase() === parsed.folder.trim().toLowerCase());
  if (!folder) return null;

  const name = safeSegment(parsed.name.trim()) || file.name;
  /* Keep the real extension whatever the model suggested — the bytes
   * decide what this file is, not the label. */
  const ext = file.ext ? `.${file.ext}` : "";
  const finalName = ext && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name;

  return { folder, name: finalName, reason: parsed.reason.trim().slice(0, 120) };
}

/** Models wrap JSON in fences, or add a sentence before it, however
 *  firmly you ask them not to. Take the first balanced object. */
function parse(raw: string): { folder: string; name: string; reason: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const folder = typeof o.folder === "string" ? o.folder : "";
    const name = typeof o.name === "string" ? o.name : "";
    const reason = typeof o.reason === "string" ? o.reason : "";
    if (!folder || !name) return null;
    return { folder, name, reason };
  } catch {
    return null;
  }
}

/** Fills in suggestions for everything unfiled that lacks one. Called
 *  after an upload and by the scan timer. Sequential on purpose — this
 *  runs against a shared rate limit and the Inbox is small by design. */
export async function suggestForInbox(limit = 10): Promise<number> {
  if (!suggestionsEnabled()) return 0;

  const pending = await db
    .select({ id: objects.id, suggestion: objects.suggestion })
    .from(objects)
    .where(and(isNull(objects.folderId), isNull(objects.deletedAt)))
    .limit(limit);

  let done = 0;
  for (const row of pending) {
    if (row.suggestion) continue;
    const s = await suggestFiling(row.id);
    if (!s) continue;
    await db
      .update(objects)
      .set({
        suggestion: { ...s, model: process.env.OPENROUTER_FILING_MODEL || "anthropic/claude-haiku-4.5", at: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(objects.id, row.id));
    done += 1;
  }
  return done;
}
