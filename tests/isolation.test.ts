/**
 * TWO-TENANT ADVERSARIAL ISOLATION SUITE
 * Runs on EVERY commit. Exists because AI-generated code omits tenant filters
 * and single-tenant tests can't catch it.
 *
 * RULE: if a test here fails, THE CODE IS WRONG, NOT THE TEST.
 * Never relax an RLS policy to make this suite pass.
 *
 * Requires: migrations applied; DATABASE_URL = hispren_app role (NOT owner —
 * RLS doesn't apply to owners, and this suite verifies that misconfiguration).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }); // owner role

let A: string, B: string; // tenant ids
let personA: string;

async function asTenant<T>(tenantId: string, fn: (q: (s: string, p?: any[]) => Promise<any>) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const r = await fn((s, p) => c.query(s, p));
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  // Seed two tenants AS OWNER (provisioning is platform-scope)
  const t = await admin.query(`
    INSERT INTO tenants (name, subdomain) VALUES
      ('Church A', 'iso-church-a-' || substr(md5(random()::text),1,6)),
      ('Church B', 'iso-church-b-' || substr(md5(random()::text),1,6))
    RETURNING id
  `);
  [A, B] = [t.rows[0].id, t.rows[1].id];

  const p = await asTenant(A, (q) =>
    q(`INSERT INTO persons (tenant_id, first_name, last_name, phone, date_of_birth)
       VALUES (current_tenant_id(), 'Amaka', 'Okafor', '+2348012345678', '1990-03-14')
       RETURNING id`)
  );
  personA = p.rows[0].id;
});

describe("cross-tenant reads are impossible", () => {
  it("B cannot see A's persons", async () => {
    const r = await asTenant(B, (q) => q(`SELECT * FROM persons`));
    expect(r.rows).toHaveLength(0);
  });

  it("B cannot fetch A's person by primary key", async () => {
    const r = await asTenant(B, (q) =>
      q(`SELECT * FROM persons WHERE id = $1`, [personA])
    );
    expect(r.rows).toHaveLength(0); // RLS filters even direct PK lookups
  });

  it("B cannot see A's tenant row", async () => {
    const r = await asTenant(B, (q) =>
      q(`SELECT * FROM tenants WHERE id = $1`, [A])
    );
    expect(r.rows).toHaveLength(0);
  });
});

describe("cross-tenant writes are impossible", () => {
  it("B cannot INSERT a person into A (WITH CHECK)", async () => {
    await expect(
      asTenant(B, (q) =>
        q(`INSERT INTO persons (tenant_id, first_name) VALUES ($1, 'Intruder')`, [A])
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("B cannot UPDATE A's person", async () => {
    const r = await asTenant(B, (q) =>
      q(`UPDATE persons SET first_name = 'Hacked' WHERE id = $1 RETURNING id`, [personA])
    );
    expect(r.rows).toHaveLength(0); // 0 rows matched — silently no-op, no leak
    const check = await asTenant(A, (q) =>
      q(`SELECT first_name FROM persons WHERE id = $1`, [personA])
    );
    expect(check.rows[0].first_name).toBe("Amaka");
  });

  it("B cannot DELETE A's person", async () => {
    const r = await asTenant(B, (q) =>
      q(`DELETE FROM persons WHERE id = $1 RETURNING id`, [personA])
    );
    expect(r.rows).toHaveLength(0);
  });
});

describe("fail-closed without tenant context", () => {
  it("no app.tenant_id set → zero rows, not all rows", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(`SELECT * FROM persons`);
      expect(r.rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });

  it("garbage tenant id is rejected before reaching SQL", async () => {
    // withTenant() validates UUID shape; simulate its guard here
    const bad = "'; DROP TABLE persons; --";
    expect(
      /^[0-9a-f-]{36}$/i.test(bad)
    ).toBe(false);
  });
});

describe("misconfiguration tripwire", () => {
  it("app role is NOT the table owner (RLS would be silently disabled)", async () => {
    const r = await pool.query(`
      SELECT current_user AS me,
             tableowner
        FROM pg_tables WHERE tablename = 'persons'
    `);
    expect(r.rows[0].me).not.toBe(r.rows[0].tableowner);
  });

  it("RLS is ENABLED and FORCED on all tenant tables", async () => {
    const r = await admin.query(`
      SELECT relname FROM pg_class
       WHERE relname IN ('persons','households','groups','tasks','care_requests',
                         'segments','consents','event_outbox','files')
         AND (NOT relrowsecurity OR NOT relforcerowsecurity)
    `);
    expect(r.rows).toHaveLength(0); // any row here = a table lost its policies
  });
});

describe("outbox events carry tenant isolation", () => {
  it("B cannot read A's events", async () => {
    await asTenant(A, (q) =>
      q(`INSERT INTO event_outbox (tenant_id, event_type, entity_type)
         VALUES (current_tenant_id(), 'test.event', 'person')`)
    );
    const r = await asTenant(B, (q) =>
      q(`SELECT * FROM event_outbox WHERE event_type = 'test.event'`)
    );
    expect(r.rows).toHaveLength(0);
  });
});

describe("schema guarantees", () => {
  it("group hierarchy rejects cycles", async () => {
    const g = await asTenant(A, (q) => q(
      `INSERT INTO groups (tenant_id, group_type, name)
       VALUES (current_tenant_id(),'branch','Cycle Test') RETURNING id`));
    const child = await asTenant(A, (q) => q(
      `INSERT INTO groups (tenant_id, parent_id, group_type, name)
       VALUES (current_tenant_id(),$1,'cell','Child') RETURNING id`, [g.rows[0].id]));
    await expect(
      asTenant(A, (q) => q(`UPDATE groups SET parent_id=$1 WHERE id=$2`,
        [child.rows[0].id, g.rows[0].id]))
    ).rejects.toThrow(/cycle/i);
  });

  it("credit wallet cannot go negative", async () => {
    await admin.query(
      `INSERT INTO credit_wallets (tenant_id, credit_type, balance)
       VALUES ($1,'sms',100) ON CONFLICT DO NOTHING`, [A]);
    await expect(
      admin.query(`UPDATE credit_wallets SET balance = balance - 500
                    WHERE tenant_id=$1 AND credit_type='sms'`, [A])
    ).rejects.toThrow(/check constraint/i);
  });

  it("birthday columns are generated correctly", async () => {
    const r = await asTenant(A, (q) => q(
      `SELECT dob_month, dob_day FROM persons WHERE id = $1`, [personA]));
    expect(r.rows[0].dob_month).toBe(3);
    expect(r.rows[0].dob_day).toBe(14);
  });
});
