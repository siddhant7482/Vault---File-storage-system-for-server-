import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { objects, shares } from "@/db/schema";
import { getSettings } from "@/lib/vault";

/* ============================================================
   Sharing — handing one file to one person.

   No accounts, no permissions model, no "anyone with the link can
   edit". A share is a bearer token with a mandatory expiry, and
   that is the whole feature.

   Two rules it will not bend on:

     1. EXPIRY IS MANDATORY. A link that never dies is a leak with
        a delay. The default is seven days; the maximum is thirty.

     2. REVOCATION IS IMMEDIATE AND PERMANENT. The row survives so
        the history does — you can see that a thing was shared, and
        when it stopped being shared.

   Tokens are random, never derived from the file. Deriving them
   would mean the same file always produces the same link, so
   revoking one and issuing another would hand back a URL somebody
   already has.
   ============================================================ */

const MAX_TTL_HOURS = 24 * 30;

export async function createShare(objectId: number, opts: { ttlHours?: number; note?: string } = {}) {
  const settings = await getSettings();
  const ttl = Math.min(Math.max(1, opts.ttlHours ?? settings.shareTtlHours), MAX_TTL_HOURS);

  const [target] = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.id, objectId), isNull(objects.deletedAt)))
    .limit(1);
  if (!target) throw new Error("No such file");

  /* 24 random bytes — 192 bits. Not guessable, and short enough to
   * paste into a message without wrapping. */
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttl * 3_600_000);

  await db.insert(shares).values({ objectId, token, expiresAt, note: opts.note ?? null });

  return { token, expiresAt, path: `/s/${token}`, name: target.name };
}

export async function revokeShare(objectId: number) {
  await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.objectId, objectId), isNull(shares.revokedAt)));
}

/** Resolves a token to the object it points at, or null. Checks
 *  revocation and expiry together so a caller cannot forget one. */
export async function redeem(token: string) {
  const [row] = await db
    .select({
      shareId: shares.id,
      objectId: objects.id,
      key: objects.key,
      name: objects.name,
      deletedAt: objects.deletedAt,
    })
    .from(shares)
    .innerJoin(objects, eq(shares.objectId, objects.id))
    .where(and(eq(shares.token, token), isNull(shares.revokedAt), gt(shares.expiresAt, new Date())))
    .limit(1);

  if (!row || row.deletedAt) return null;

  /* Recorded so the detail panel can say a link has actually been
   * used — "shared, never opened" and "shared, opened nine times" are
   * very different facts about a file. */
  await db
    .update(shares)
    .set({ hits: sql`${shares.hits} + 1`, lastHitAt: new Date() })
    .where(eq(shares.id, row.shareId));

  return { objectId: row.objectId, key: row.key, name: row.name };
}

/** Everything currently live, for the "active shares" list. */
export async function activeShares() {
  return db
    .select({
      token: shares.token,
      expiresAt: shares.expiresAt,
      hits: shares.hits,
      lastHitAt: shares.lastHitAt,
      objectId: objects.id,
      name: objects.name,
      bytes: objects.bytes,
    })
    .from(shares)
    .innerJoin(objects, eq(shares.objectId, objects.id))
    .where(and(isNull(shares.revokedAt), gt(shares.expiresAt, new Date()), isNull(objects.deletedAt)))
    .orderBy(desc(shares.createdAt));
}
