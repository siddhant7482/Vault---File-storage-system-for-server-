/* ============================================================
   The CommandHQ status contract, declared locally.

   The hub declares the same shape in its own repo. That duplication
   is deliberate and matches Warden: these are separate repos that
   deploy on their own schedule, and a shared package for twenty
   lines of types would couple releases that have no reason to be
   coupled. The hub validates whatever it receives, so the cost of
   disagreeing is a pad showing "unreachable" — not a crash.
   ============================================================ */

export type StatusLevel = "ok" | "warn" | "attention" | "down";

export interface StatusMetric {
  label: string;
  value: string;
}

export interface StatusAlert {
  /** Readable out of context — it sits beside alerts from other apps. */
  text: string;
  /** ISO 8601. */
  due?: string;
  severity: "info" | "soon" | "urgent";
  /** Path within Vault, e.g. "/?cold=1". */
  href?: string;
}

export interface AppStatus {
  app: "vault";
  level: StatusLevel;
  headline: string;
  metrics: StatusMetric[];
  alerts: StatusAlert[];
  at: string;
}

export interface CaptureResult {
  ok: boolean;
  message: string;
}
