/**
 * SECURITY-CRITICAL. Human line-by-line review required on any change.
 *
 * TWO POOLS, TWO ROLES. This split is the security model.
 *
 *   appPool       -> hispren_app       DATABASE_URL
 *                    Tenant-scoped. RLS enforced. Handles ~all traffic.
 *                    Cannot read across tenants. Every query goes through
 *                    withTenant(), which opens a transaction and runs
 *                    SET LOCAL app.tenant_id. SET LOCAL dies with the
 *                    transaction, so context can never bleed across pooled
 *                    connections.
 *
 *   platformPool  -> hispren_platform  PLATFORM_DATABASE_URL
 *                    Cross-tenant, but ONLY on platform tables: tenants,
 *                    tenant_domains, tenant_memberships, event_outbox,
 *                    billing. Needed for the things that happen BEFORE a
 *                    tenant context exists: hostname->tenant resolution,
 *                    login, the outbox relay, billing jobs.
 *                    It is BLIND to persons/households/giving by database
 *                    policy, not by convention. Verified in 04_verify_isolation.
 *
 * NEITHER role owns any table. RLS does not apply to table owners.
 * The owner role (neondb_owner) is used for MIGRATIONS ONLY and its
 * credentials never reach the running app.
 */
import { Pool, PoolClient } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
if (!process.env.PLATFORM_DATABASE_URL)
  throw new Error("PLATFORM_DATABASE_URL is not set");

const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const platformPool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL,
  max: 5, // platform work is narrow: resolution, login, relay, billing
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Pick<PoolClient, "query">;

/**
 * Run `fn` inside a transaction scoped to ONE tenant, as hispren_app.
 * Every query inside sees only that tenant's rows (RLS USING), and every
 * insert is forced to that tenant (RLS WITH CHECK).
 *
 * This is the ONLY way to touch church data. There is deliberately no
 * exported raw query() for tenant tables.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    // tenantId is interpolated below because SET does not accept bind params.
    // Validate the shape strictly. Never trust the caller.
    throw new Error("withTenant: invalid tenant id");
  }
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cross-tenant platform work, as hispren_platform.
 *
 * Legitimate uses, and only these:
 *   - hostname -> tenant resolution (tenant.ts)
 *   - login / session lookup (auth.ts)
 *   - outbox relay (events.ts)
 *   - billing jobs (billing/metering.ts)
 *   - tenant provisioning (signup)
 *
 * The name is deliberately greppable. Every call site gets reviewed.
 * If you reach for this to read a person, a household, or a gift — stop.
 * The database will refuse you anyway.
 */
export async function platformQuery<R = any>(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: R[] }> {
  return platformPool.query(sql, params);
}

export async function healthcheck(): Promise<{ app: boolean; platform: boolean }> {
  const [a, p] = await Promise.allSettled([
    appPool.query("SELECT 1 AS ok"),
    platformPool.query("SELECT 1 AS ok"),
  ]);
  return {
    app: a.status === "fulfilled",
    platform: p.status === "fulfilled",
  };
}

export async function shutdown(): Promise<void> {
  await Promise.all([appPool.end(), platformPool.end()]);
}
