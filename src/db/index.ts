import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set — copy .env.example to .env.local");

/* Production Postgres (CT 100) is shared by every CommandHQ app and is
 * tuned for max_connections = 50. Six apps at five connections each fits
 * with room to spare; leaving the pool unbounded does not. */
const POOL_MAX = 5;

/* Next dev reloads modules on every edit. Without stashing the client on
 * globalThis, each reload opens a fresh pool and leaks the old one until
 * Postgres starts refusing connections. */
const globalForDb = globalThis as unknown as {
  __vaultClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__vaultClient ??
  postgres(url, {
    max: POOL_MAX,
    onnotice: () => {},
    /* Postgres lives in its own container and will restart — updates,
     * reboots, a `docker compose down`. Without these the pool keeps
     * handing out sockets to a server that no longer exists, and every
     * query fails until the app itself is restarted. Learned on Warden. */
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__vaultClient = client;

export const db = drizzle(client, { schema });
export { schema };
