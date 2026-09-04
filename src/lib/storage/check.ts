import "@/env";

import { bytes as fmtBytes } from "@/lib/format";
import { INBOX_PREFIX, joinKey, storage } from "@/lib/storage";

/* `pnpm check:storage`
 *
 * Proves the driver can do the four things the app depends on, against
 * whatever STORAGE_DRIVER is currently set to. Run it after pointing
 * Vault at Garage for the first time — the failure modes there
 * (path-style addressing off, bucket missing, key without write
 * permission) all surface as confusing 403s at runtime, and this turns
 * them into one clear line before any real bytes are involved. */

const PROBE = joinKey(INBOX_PREFIX, ".vault-probe");

async function main() {
  const store = storage();
  console.log(`driver    ${store.name}`);

  const health = await store.health();
  console.log(`health    ${health.ok ? "ok" : "FAILED"} — ${health.detail}`);
  if (!health.ok) process.exit(1);

  const payload = new TextEncoder().encode(`vault probe ${new Date().toISOString()}\n`);

  try {
    await store.write(PROBE, payload, "text/plain");
    console.log(`write     ok — ${PROBE}`);

    const head = await store.head(PROBE);
    if (!head || head.bytes !== payload.byteLength) {
      throw new Error(`head returned ${head ? `${head.bytes} bytes` : "nothing"}, expected ${payload.byteLength}`);
    }
    console.log(`head      ok — ${head.bytes} bytes`);

    const url = await store.getUrl(PROBE, { expiresIn: 60 });
    console.log(`url       ok — ${url.length > 90 ? url.slice(0, 90) + "…" : url}`);

    const stream = await store.read(PROBE);
    const text = await new Response(stream).text();
    if (!text.startsWith("vault probe")) throw new Error("read back the wrong content");
    console.log(`read      ok`);
  } finally {
    /* Always clean up, even on failure — a probe file left in the Inbox
     * would show up as something needing filing. */
    await store.remove(PROBE).catch(() => {});
  }
  console.log(`cleanup   ok`);

  const usage = await store.usage();
  console.log(`usage     ${usage.objects} objects, ${fmtBytes(usage.bytes)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nfailed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
