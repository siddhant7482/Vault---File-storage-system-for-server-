import "@/env";

import { scan } from "./scan";
import { bytes } from "@/lib/format";
import { storage } from "@/lib/storage";

/* CLI entry: `pnpm scan [--hash] [--prefix Documents]`
 *
 * Also what the systemd timer runs on the node. Prints a plain report
 * because the first question when a number on the Map looks wrong is
 * always "when was the index last true, and what did it find". */

async function main() {
  const args = process.argv.slice(2);
  const hash = args.includes("--hash");
  const prefixArg = args.indexOf("--prefix");
  const prefix = prefixArg > -1 ? args[prefixArg + 1] : undefined;

  const store = storage();
  const health = await store.health();
  console.log(`storage   ${store.name} — ${health.ok ? "ok" : "UNREACHABLE"} (${health.detail})`);
  if (!health.ok) process.exit(1);

  const t0 = Date.now();
  const r = await scan({
    hash,
    prefix,
    onProgress: (m) => console.log(`          ${m}`),
  });

  console.log("");
  console.log(`seen      ${r.seen} objects, ${bytes(r.bytesTotal)}`);
  console.log(`added     ${r.added}`);
  console.log(`updated   ${r.updated}`);
  console.log(`vanished  ${r.vanished}${r.vanished ? "  (marked deleted, bytes untouched)" : ""}`);
  console.log(`hashed    ${r.hashed}${hash ? "" : "  (pass --hash to enable)"}`);
  console.log(`took      ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  process.exit(0);
}

main().catch((e) => {
  console.error(`\nscan failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
