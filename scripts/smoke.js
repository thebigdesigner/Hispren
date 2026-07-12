/**
 * End-to-end smoke test. Run BEFORE building Phase 1.
 * Proves: both roles connect, RLS holds from Node, platform can resolve a
 * tenant, and the app role cannot cross tenants.
 *
 *   node scripts/smoke.js
 */
require("dotenv").config();
const { Pool } = require("pg");

const app = new Pool({ connectionString: process.env.DATABASE_URL });
const plat = new Pool({ connectionString: process.env.PLATFORM_DATABASE_URL });

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
let failed = 0;
const chk = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
  if (!ok) failed++;
};

async function asTenant(tid, sql, params = []) {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

(async () => {
  console.log("\nHISPREN SMOKE TEST\n");

  console.log("connections");
  chk("hispren_app connects",      (await app.query("SELECT 1 ok")).rows[0].ok, 1);
  chk("hispren_platform connects", (await plat.query("SELECT 1 ok")).rows[0].ok, 1);
  chk("app role is not the table owner",
    (await app.query(
      `SELECT current_user = (SELECT tableowner FROM pg_tables WHERE tablename='persons') AS same`
    )).rows[0].same, false);

  // provision two churches — a PLATFORM operation, exactly like signup
  await plat.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [A, B]);
  await plat.query(
    `INSERT INTO tenants (id,name,subdomain) VALUES ($1,'Smoke A','smoke-a'),($2,'Smoke B','smoke-b')`,
    [A, B]
  );
  const p = await asTenant(A,
    `INSERT INTO persons (tenant_id,first_name,last_name,date_of_birth)
     VALUES (current_tenant_id(),'Amaka','Okafor','1990-03-14') RETURNING id`);
  const pid = p.rows[0].id;

  console.log("\ntenant isolation (from Node, through the pooler)");
  chk("A sees its member",              (await asTenant(A, `SELECT count(*) n FROM persons`)).rows[0].n, 1);
  chk("B sees nothing",                 (await asTenant(B, `SELECT count(*) n FROM persons`)).rows[0].n, 0);
  chk("B cannot fetch A's member by id",
    (await asTenant(B, `SELECT count(*) n FROM persons WHERE id=$1`, [pid])).rows[0].n, 0);

  let blocked = false;
  try {
    await asTenant(B, `INSERT INTO persons (tenant_id,first_name) VALUES ($1,'Intruder')`, [A]);
  } catch { blocked = true; }
  chk("B cannot write into A", blocked, true);

  await asTenant(B, `UPDATE persons SET first_name='Hacked' WHERE id=$1`, [pid]);
  chk("B cannot overwrite A's member",
    (await asTenant(A, `SELECT first_name FROM persons WHERE id=$1`, [pid])).rows[0].first_name, "Amaka");

  console.log("\npooler safety (tenant context must not leak between requests)");
  await Promise.all(Array.from({ length: 30 }, (_, i) =>
    asTenant(i % 2 ? A : B, `SELECT count(*) n FROM persons`)
      .then(r => { if (Number(r.rows[0].n) !== (i % 2 ? 1 : 0)) failed++; })
  ));
  chk("30 interleaved A/B queries, no context bleed", failed === 0 ? "clean" : "BLED", "clean");

  console.log("\nplatform layer (must work, or nobody can log in)");
  chk("platform resolves subdomain",
    (await plat.query(`SELECT count(*) n FROM tenants WHERE subdomain='smoke-a'`)).rows[0].n, 1);
  chk("platform reads outbox",
    (await plat.query(`SELECT count(*) n FROM event_outbox WHERE 1=1`)).rows[0].n >= 0, true);
  chk("platform CANNOT read members",
    (await plat.query(`SELECT count(*) n FROM persons`)).rows[0].n, 0);

  await plat.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [A, B]);
  await app.end(); await plat.end();

  console.log(
    failed === 0
      ? "\nALL GREEN — the stack works end to end. Safe to build Phase 1.\n"
      : `\n${failed} CHECK(S) FAILED — stop and fix.\n`
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error("\nSMOKE TEST ERROR:", e.message, "\n"); process.exit(1); });
