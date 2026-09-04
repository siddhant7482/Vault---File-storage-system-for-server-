import { NextResponse } from "next/server";
import type { AppStatus, StatusAlert, StatusLevel } from "@/lib/status-contract";
import { bytes as fmtBytes, held } from "@/lib/format";
import { getMap, getSettings, listUnfiled } from "@/lib/vault";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/* ============================================================
   What Vault tells the hub.

   The hub never touches this database — it asks, once, with a 1.5s
   timeout, and renders whatever comes back. So this route has two
   obligations: answer fast, and never throw. A Vault that is broken
   should say so in a headline, not take the panel down with it.

   The level is the interesting part. `attention` is reserved for
   things a human must act on — files waiting to be filed, an
   allocation about to run out. Cold weight is deliberately NOT
   attention: it is a standing fact about the vault, not a task, and
   an alert that is always on is an alert nobody reads.
   ============================================================ */

const ALLOCATION_WARN = 0.85;
const ALLOCATION_URGENT = 0.95;
/** Something sitting unfiled this long has stopped being "recent". */
const STALE_INBOX_DAYS = 7;

export async function GET() {
  const at = new Date().toISOString();

  try {
    const store = storage();
    const health = await store.health();

    if (!health.ok) {
      /* The index may still answer, but every number it holds is about
       * bytes we currently cannot reach. Saying "ok" here would be a
       * lie of exactly the kind this panel exists to prevent. */
      return json({
        app: "vault",
        level: "down",
        headline: `Storage unreachable — ${health.detail}`.slice(0, 120),
        metrics: [{ label: "DRIVER", value: store.name.toUpperCase() }],
        alerts: [{ text: "Vault cannot reach its object store", severity: "urgent", href: "/" }],
        at,
      });
    }

    const [map, unfiled, settings] = await Promise.all([getMap(), listUnfiled(), getSettings()]);

    const usedFraction = map.allocationBytes ? map.usedBytes / map.allocationBytes : 0;
    const alerts: StatusAlert[] = [];
    let level: StatusLevel = "ok";

    if (unfiled.length) {
      level = "attention";
      const oldest = unfiled[0];
      const days = Math.floor((Date.now() - oldest.addedAt.getTime()) / 86_400_000);
      alerts.push({
        text:
          unfiled.length === 1
            ? `1 file unfiled, waiting ${held(oldest.addedAt)}`
            : `${unfiled.length} files unfiled, oldest waiting ${held(oldest.addedAt)}`,
        severity: days >= STALE_INBOX_DAYS ? "soon" : "info",
        href: "/",
      });
    }

    if (usedFraction >= ALLOCATION_URGENT) {
      level = "attention";
      alerts.push({
        text: `Vault is ${(usedFraction * 100).toFixed(0)}% full — ${fmtBytes(map.freeBytes)} left`,
        severity: "urgent",
        href: "/?cold=1",
      });
    } else if (usedFraction >= ALLOCATION_WARN) {
      if (level === "ok") level = "warn";
      alerts.push({
        text: `Vault is ${(usedFraction * 100).toFixed(0)}% full`,
        severity: "soon",
        href: "/?cold=1",
      });
    }

    /* Cold is reported as a metric, never as an alert. It is a
     * standing condition — an alert that never clears trains you to
     * ignore the row it sits in. */
    const headline = unfiled.length
      ? `${fmtBytes(map.usedBytes)} of ${fmtBytes(map.allocationBytes)} · ${unfiled.length} unfiled`
      : `${fmtBytes(map.usedBytes)} of ${fmtBytes(map.allocationBytes)} · inbox clear`;

    return json({
      app: "vault",
      level,
      headline,
      metrics: [
        { label: "USED", value: fmtBytes(map.usedBytes) },
        {
          label: "COLD",
          value: map.coldBytes ? `${fmtBytes(map.coldBytes)} · ${map.coldCount}` : "none",
        },
      ],
      alerts,
      at: settings.lastScanAt ? at : at,
    });
  } catch (e) {
    /* Almost always Postgres being restarted. Report it plainly rather
     * than 500ing — the hub renders a headline, and a 500 renders
     * nothing at all. */
    return json({
      app: "vault",
      level: "down",
      headline: `Index unavailable — ${e instanceof Error ? e.message : String(e)}`.slice(0, 120),
      metrics: [],
      alerts: [{ text: "Vault could not read its index", severity: "urgent" }],
      at,
    });
  }
}

function json(status: AppStatus) {
  return NextResponse.json(status, {
    /* The hub polls this on every render. Caching it would mean the
     * panel showing a number that was true a minute ago. */
    headers: { "cache-control": "no-store" },
  });
}
