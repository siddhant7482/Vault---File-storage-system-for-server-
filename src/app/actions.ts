"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { objectTags, objects, tags } from "@/db/schema";
import { fileObject, renameObject, restoreObject, trashObject, unfileObject } from "@/lib/filing";
import { createShare, revokeShare } from "@/lib/share";
import { suggestFiling } from "@/lib/suggest";

/* ============================================================
   Everything the panel can change.

   Server actions rather than API routes: these are only ever
   called by Vault's own UI, they need no versioned contract, and
   going through fetch would mean hand-writing the same request
   plumbing eight times.

   The routes under /api are the ones with an audience outside this
   app — the hub reads /api/status, other apps POST /api/refs,
   strangers hit /s/<token>, and the upload path has to work from
   a script. Those get real HTTP. This does not.

   Every action returns { ok } rather than throwing, because a
   failed filing should put a message on the readout, not replace
   the panel with an error page.
   ============================================================ */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

function fail(e: unknown): ActionResult {
  return { ok: false, message: e instanceof Error ? e.message : String(e) };
}

/** Moves bytes out of the Inbox. The suggestion is only ever a
 *  default — whatever arrives here is what the human chose. */
export async function fileAction(id: number, folderPath: string, name?: string): Promise<ActionResult> {
  try {
    const r = await fileObject(id, { folderPath, name }, "human");
    revalidatePath("/");
    return { ok: true, message: `FILED · ${r.folderPath}` };
  } catch (e) {
    return fail(e);
  }
}

/** Accepts the model's proposal verbatim. Recorded as `suggested`
 *  rather than `human` so we can ask later how much of the filing was
 *  actually the model's idea and how much was yours. */
export async function acceptSuggestionAction(id: number): Promise<ActionResult> {
  try {
    const [row] = await db.select({ suggestion: objects.suggestion }).from(objects).where(eq(objects.id, id)).limit(1);
    const s = row?.suggestion as { folder?: string; name?: string } | null;
    if (!s?.folder) return { ok: false, message: "NO SUGGESTION" };

    const r = await fileObject(id, { folderPath: s.folder, name: s.name }, "suggested");
    revalidatePath("/");
    return { ok: true, message: `FILED · ${r.folderPath}` };
  } catch (e) {
    return fail(e);
  }
}

export async function suggestAction(id: number): Promise<ActionResult> {
  try {
    const s = await suggestFiling(id);
    if (!s) return { ok: false, message: "NO SUGGESTION AVAILABLE" };
    await db
      .update(objects)
      .set({ suggestion: { ...s, at: new Date().toISOString() }, updatedAt: new Date() })
      .where(eq(objects.id, id));
    revalidatePath("/");
    return { ok: true, message: `SUGGESTED · ${s.folder}` };
  } catch (e) {
    return fail(e);
  }
}

export async function renameAction(id: number, name: string): Promise<ActionResult> {
  try {
    const r = await renameObject(id, name);
    revalidatePath("/");
    return { ok: true, message: `RENAMED · ${r.name}` };
  } catch (e) {
    return fail(e);
  }
}

export async function unfileAction(id: number): Promise<ActionResult> {
  try {
    await unfileObject(id);
    revalidatePath("/");
    return { ok: true, message: "RETURNED TO INBOX" };
  } catch (e) {
    return fail(e);
  }
}

export async function pinAction(id: number, pinned: boolean): Promise<ActionResult> {
  try {
    await db.update(objects).set({ pinned, updatedAt: new Date() }).where(eq(objects.id, id));
    revalidatePath("/");
    return { ok: true, message: pinned ? "PINNED" : "UNPINNED" };
  } catch (e) {
    return fail(e);
  }
}

/** Soft delete — the bytes survive the undo window. */
export async function trashAction(id: number): Promise<ActionResult> {
  try {
    await trashObject(id);
    revalidatePath("/");
    return { ok: true, message: "TRASHED · RECOVERABLE FOR 14 DAYS" };
  } catch (e) {
    return fail(e);
  }
}

export async function restoreAction(id: number): Promise<ActionResult> {
  try {
    await restoreObject(id);
    revalidatePath("/");
    return { ok: true, message: "RESTORED" };
  } catch (e) {
    return fail(e);
  }
}

export async function shareAction(id: number, ttlHours?: number): Promise<ActionResult & { path?: string }> {
  try {
    const s = await createShare(id, { ttlHours });
    revalidatePath("/");
    const hours = Math.round((s.expiresAt.getTime() - Date.now()) / 3_600_000);
    return { ok: true, message: `LINK CREATED · EXPIRES ${hours}H`, path: s.path };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeShareAction(id: number): Promise<ActionResult> {
  try {
    await revokeShare(id);
    revalidatePath("/");
    return { ok: true, message: "LINK REVOKED" };
  } catch (e) {
    return fail(e);
  }
}

/** Tags are free text, lowercased and deduplicated. Deliberately flat —
 *  a tag hierarchy is a folder tree with extra steps. */
export async function setTagsAction(id: number, names: string[]): Promise<ActionResult> {
  try {
    const clean = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

    await db.delete(objectTags).where(eq(objectTags.objectId, id));
    if (!clean.length) {
      revalidatePath("/");
      return { ok: true, message: "TAGS CLEARED" };
    }

    await db.insert(tags).values(clean.map((name) => ({ name }))).onConflictDoNothing({ target: tags.name });
    const rows = await db.select({ id: tags.id, name: tags.name }).from(tags).where(inArray(tags.name, clean));
    await db
      .insert(objectTags)
      .values(rows.map((t) => ({ objectId: id, tagId: t.id })))
      .onConflictDoNothing();

    revalidatePath("/");
    return { ok: true, message: `${clean.length} TAG${clean.length === 1 ? "" : "S"}` };
  } catch (e) {
    return fail(e);
  }
}

/** Files several at once into the same folder. Sequential rather than
 *  parallel: each move renames against what is already there, and
 *  racing them would let two files claim the same destination name. */
export async function fileManyAction(ids: number[], folderPath: string): Promise<ActionResult> {
  try {
    let done = 0;
    for (const id of ids) {
      await fileObject(id, { folderPath }, "human");
      done += 1;
    }
    revalidatePath("/");
    return { ok: true, message: `FILED ${done} · ${folderPath}` };
  } catch (e) {
    return fail(e);
  }
}

/** Marks every cold object in a folder for offload. Records intent
 *  only — the actual push to B2 is restic's job, on a timer. */
export async function offloadAction(ids: number[]): Promise<ActionResult> {
  try {
    const rows = await db
      .select({ id: objects.id, bytes: objects.bytes })
      .from(objects)
      .where(and(inArray(objects.id, ids)));
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    return { ok: true, message: `QUEUED ${rows.length} · ${(total / 1024 ** 3).toFixed(1)} GB` };
  } catch (e) {
    return fail(e);
  }
}
