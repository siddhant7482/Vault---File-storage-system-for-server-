import Panel, { type PanelData } from "@/components/Panel";
import { storage } from "@/lib/storage";
import { suggestionsEnabled } from "@/lib/suggest";
import { getMap, getSettings, getTree, listObjects, listUnfiled } from "@/lib/vault";

/* Every number on this panel is arithmetic over the current index, so
 * caching the page would mean showing a vault that was true a while
 * ago. The whole point is that the Map does not lie. */
export const dynamic = "force-dynamic";

export default async function Page() {
  /* One failure mode dominates here: Postgres restarting underneath a
   * render. Catch it and hand the panel an empty vault with the lamps
   * out, rather than replacing the whole app with an error page — the
   * panel is how you find out something is wrong. */
  let data: PanelData;

  try {
    const store = storage();
    const [health, tree, unfiled, list, map, settings] = await Promise.all([
      store.health(),
      getTree(),
      listUnfiled(),
      listObjects({ limit: 500 }),
      getMap(),
      getSettings(),
    ]);

    data = {
      tree: tree.nodes,
      inboxCount: tree.inbox,
      unfiled,
      rows: list.rows,
      total: list.total,
      scopedBytes: list.bytes,
      map,
      driver: store.name,
      storageOk: health.ok,
      lastScanAt: settings.lastScanAt ? settings.lastScanAt.toISOString() : null,
      suggestionsOn: suggestionsEnabled(),
    };
  } catch {
    data = {
      tree: [],
      inboxCount: 0,
      unfiled: [],
      rows: [],
      total: 0,
      scopedBytes: 0,
      map: {
        groups: [],
        freeBytes: 0,
        allocationBytes: Number(process.env.VAULT_ALLOCATION_GB || 30) * 1024 ** 3,
        usedBytes: 0,
        coldBytes: 0,
        coldCount: 0,
      },
      driver: process.env.STORAGE_DRIVER || "fs",
      storageOk: false,
      lastScanAt: null,
      suggestionsOn: false,
    };
  }

  return <Panel {...data} />;
}
