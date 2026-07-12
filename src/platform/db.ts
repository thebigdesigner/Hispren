/**
 * SECURITY-CRITICAL. Human line-by-line review required on any change.
 *
 * Invariants enforced here (see CLAUDE.md):
 *  - The API connects as `hispren_app` (NOT the migration owner). RLS does not
 *    apply to table owners/superusers — connecting as owner silently disables
 *    every policy.
 *  - ALL tenant-scoped queries run inside withTenant(), which opens a
 *    transaction and runs `SET LOCAL app.tenant_id`. SET LOCAL dies with the
 *    transaction, so tenant context can never bleed across pooled connections.
 *  - There is deliberately NO exported raw `query()` for tenant data. The only
 *    escape hatch is `platformQuery()` — its name is greppable in code review.
 */
import { Pool, PoolClient } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // must be the hispren_app role
  max: 20,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Pick<PoolClient, "query">;

/**
 * Run `fn` inside a transaction scoped to one tenant.
 * Every query inside sees only that tenant's rows (RLS), and inserts are
 * forced to that tenant (WITH CHECK).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    // Defense in depth: tenantId is interpolated into SET LOCAL below (SET
    // does not accept bind params). Validate shape strictly, never trust input.
    throw new Error("withTenant: invalid tenant id");
  }
  const client = await pool.connect();
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
 * Platform-scope queries ONLY: login (before tenant context exists), tenant
 * provisioning, hostname→tenant resolution. Never for tenant data.
 * The name exists to be grepped in review.
 */
export async function platformQuery<R = any>(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: R[] }> {
  return pool.query(sql, params);
}

export async function healthcheck(): Promise<boolean> {
  const r = await pool.query("SELECT 1 AS ok");
  return r.rows[0]?.ok === 1;
}
