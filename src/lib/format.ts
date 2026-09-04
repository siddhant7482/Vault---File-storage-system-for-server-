/* Formatting shared by the server and the panel. Kept in one place
   because the Map, the gauge and the index all have to agree — a
   treemap block labelled 1.2 GB next to a row saying 1,240 MB reads
   as a bug even when both are true. */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Binary units, because that is what the store reports and what `df`
 *  will say when you go and check. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${n} B`;
}

/** Terse, uppercase, fixed width-ish — the panel reads as telemetry and
 *  "11 Jul" is one glance where "11 July 2026" is two. */
export function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
    .toUpperCase();
}

/** What the detail panel shows for "last opened". NEVER is not an error
 *  state — it is the single most useful thing Vault knows about a file. */
export function opened(d: Date | string | null | undefined): string {
  if (!d) return "NEVER";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "NEVER";

  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  if (days < 30) return `${days}D AGO`;
  return shortDate(date);
}

/** How long something has been sitting in the Inbox. The pressure is
 *  the number, so it is always a count, never "a while ago". */
export function held(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  if (days === 0) return "TODAY";
  return `${days}D`;
}

export function percent(part: number, whole: number, dp = 1): string {
  if (!whole) return "0%";
  return `${((part / whole) * 100).toFixed(dp)}%`;
}
