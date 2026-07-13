/**
 * GIVING AND FUND ACCOUNTING.
 *
 * Hispren NEVER takes a percentage. The church keeps every kobo. This exists to
 * let a treasurer sleep, not to skim.
 */
import { Tx } from "../platform/db";
import { publish } from "../platform/outbox";
import { normaliseText } from "../members/service";

// ---------------------------------------------------------------------------
// FUNDS
// ---------------------------------------------------------------------------
export async function funds(tx: Tx) {
  const { rows } = await tx.query(`
    SELECT s.*, f.description, f.code, f.allowed_categories, f.is_default
      FROM fund_summary() s JOIN funds f ON f.id = s.id`);
  return rows;
}

export async function createFund(tx: Tx, f: {
  name: string; kind: string; code?: string; description?: string;
  allowed_categories?: string[];
}) {
  const { rows } = await tx.query(
    `INSERT INTO funds (tenant_id, name, kind, code, description, allowed_categories)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING *`,
    [normaliseText(f.name), f.kind, f.code || null, normaliseText(f.description),
     f.kind === "restricted" && f.allowed_categories?.length ? f.allowed_categories : null]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// COUNTING SESSIONS
// ---------------------------------------------------------------------------
export async function batches(tx: Tx, limit = 30) {
  const { rows } = await tx.query(`
    SELECT b.*, sv.name AS service,
           coalesce((SELECT sum(amount) FROM contributions c WHERE c.batch_id = b.id), 0) AS counted,
           (SELECT count(*)::int FROM contributions c WHERE c.batch_id = b.id) AS entries
      FROM giving_batches b LEFT JOIN services sv ON sv.id = b.service_id
     ORDER BY b.batch_date DESC, b.created_at DESC LIMIT $1`, [limit]);
  return rows;
}

export async function openBatch(tx: Tx, d: {
  name: string; batch_date?: string; service_id?: string;
  counted_by?: string; verified_by?: string; expected_total?: number;
}, userId: string) {
  const { rows } = await tx.query(
    `INSERT INTO giving_batches (tenant_id, name, batch_date, service_id,
        counted_by, verified_by, expected_total, created_by)
     VALUES (current_tenant_id(), $1, coalesce($2::date, CURRENT_DATE), $3, $4, $5, $6, $7)
     RETURNING *`,
    [normaliseText(d.name), d.batch_date || null, d.service_id || null,
     normaliseText(d.counted_by), normaliseText(d.verified_by),
     d.expected_total ?? null, userId]);
  return rows[0];
}

export async function getBatch(tx: Tx, id: string) {
  const { rows } = await tx.query(`
    SELECT b.*, sv.name AS service,
      coalesce((SELECT sum(amount) FROM contributions c WHERE c.batch_id = b.id), 0) AS counted,
      coalesce((SELECT json_agg(json_build_object(
        'id', c.id, 'amount', c.amount, 'method', c.method,
        'fund', f.name, 'fund_id', c.fund_id,
        'person_id', c.person_id,
        'person', trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
        'envelope_no', c.envelope_no, 'reference', c.reference,
        'headcount', c.headcount, 'anonymous', c.is_anonymous
      ) ORDER BY c.is_anonymous DESC, c.created_at)
        FROM contributions c
        JOIN funds f ON f.id = c.fund_id
        LEFT JOIN persons p ON p.id = c.person_id
       WHERE c.batch_id = b.id), '[]') AS entries
    FROM giving_batches b LEFT JOIN services sv ON sv.id = b.service_id
    WHERE b.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * A CLOSED batch cannot be edited. That is the entire control — if one person
 * can quietly change a counted figure after the fact, the count means nothing
 * and the church has no protection at all.
 */
async function assertOpen(tx: Tx, batchId: string) {
  const { rows } = await tx.query(
    `SELECT status FROM giving_batches WHERE id = $1`, [batchId]);
  if (!rows[0]) throw new Error("No such count.");
  if (rows[0].status === "closed")
    throw new Error(
      "This count has been closed and signed off. It cannot be edited. " +
      "If it is wrong, record a correcting entry in a new count — never quietly " +
      "change a figure two people already signed.");
}

export async function addContribution(tx: Tx, batchId: string, d: {
  fund_id: string; amount: number; person_id?: string | null;
  method?: string; envelope_no?: string; reference?: string;
  headcount?: number; note?: string;
}, userId: string) {
  await assertOpen(tx, batchId);
  const b = await tx.query(`SELECT batch_date FROM giving_batches WHERE id = $1`, [batchId]);
  const { rows } = await tx.query(
    `INSERT INTO contributions (tenant_id, batch_id, fund_id, person_id, amount,
        method, given_on, envelope_no, reference, headcount, note, created_by)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [batchId, d.fund_id, d.person_id || null, d.amount, d.method ?? "cash",
     b.rows[0].batch_date, d.envelope_no || null, d.reference || null,
     d.headcount ?? null, normaliseText(d.note), userId]);

  if (d.person_id) {
    await publish(tx, { type: "giving.recorded", entityType: "person",
      entityId: d.person_id, payload: { amount: d.amount, fund_id: d.fund_id } });
  }
  return rows[0];
}

export async function removeContribution(tx: Tx, id: string) {
  const c = await tx.query(`SELECT batch_id FROM contributions WHERE id = $1`, [id]);
  if (!c.rows[0]) return null;
  await assertOpen(tx, c.rows[0].batch_id);
  await tx.query(`DELETE FROM contributions WHERE id = $1`, [id]);
  return { removed: true };
}

/** Close the count. Two names, and the figure they said out loud. */
export async function closeBatch(tx: Tx, id: string) {
  const b = await getBatch(tx, id);
  if (!b) throw new Error("No such count.");
  if (b.status === "closed") throw new Error("Already closed.");
  if (!b.counted_by)
    throw new Error("Who counted it? Two names. This is the only protection the church has.");

  await tx.query(
    `UPDATE giving_batches SET status='closed', closed_at=now() WHERE id=$1`, [id]);

  const counted = Number(b.counted), expected = Number(b.expected_total ?? 0);
  return {
    closed: true, counted, expected,
    // If the counters said one number and the entries add to another, SAY SO.
    // A discrepancy silently absorbed is a discrepancy nobody ever investigates.
    discrepancy: expected ? counted - expected : null,
  };
}

// ---------------------------------------------------------------------------
// EXPENSES
// ---------------------------------------------------------------------------
export async function expenses(tx: Tx, status?: string) {
  const p: unknown[] = [];
  let w = "";
  if (status) { p.push(status); w = `WHERE e.status = $1`; }
  const { rows } = await tx.query(`
    SELECT e.*, f.name AS fund, f.kind AS fund_kind, u.full_name AS approved_by_name
      FROM expenses e JOIN funds f ON f.id = e.fund_id
      LEFT JOIN app_users u ON u.id = e.approved_by
     ${w} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 100`, p);
  return rows;
}

export async function addExpense(tx: Tx, d: {
  fund_id: string; amount: number; payee: string; category?: string;
  spent_on?: string; method?: string; reference?: string; note?: string;
  approve?: boolean;
}, userId: string) {
  const { rows } = await tx.query(
    `INSERT INTO expenses (tenant_id, fund_id, amount, payee, category, spent_on,
        method, reference, note, status, approved_by, approved_at, created_by)
     VALUES (current_tenant_id(), $1, $2, $3, $4, coalesce($5::date, CURRENT_DATE),
             $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [d.fund_id, d.amount, normaliseText(d.payee), normaliseText(d.category),
     d.spent_on || null, d.method ?? "cash", d.reference || null, normaliseText(d.note),
     d.approve ? "approved" : "pending",
     d.approve ? userId : null, d.approve ? new Date().toISOString() : null,
     userId]);
  return rows[0];
}

export async function approveExpense(tx: Tx, id: string, userId: string, ok: boolean) {
  const { rows } = await tx.query(
    `UPDATE expenses SET status = $2, approved_by = $3, approved_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, ok ? "approved" : "rejected", userId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------------
export async function byMonth(tx: Tx, months = 12) {
  const { rows } = await tx.query(`SELECT * FROM giving_by_month($1)`, [months]);
  return rows;
}

export async function statement(tx: Tx, personId: string, year: number) {
  const { rows } = await tx.query(`SELECT * FROM giving_statement($1, $2)`, [personId, year]);
  const total = rows.reduce((n: number, r: any) => n + Number(r.amount), 0);
  return { year, lines: rows, total };
}

export async function pledges(tx: Tx) {
  const { rows } = await tx.query(`SELECT * FROM pledge_progress()`);
  return rows;
}

export async function addPledge(tx: Tx, d: {
  person_id: string; fund_id: string; amount: number;
  starts_on?: string; ends_on?: string; note?: string;
}) {
  const { rows } = await tx.query(
    `INSERT INTO pledges (tenant_id, person_id, fund_id, amount, starts_on, ends_on, note)
     VALUES (current_tenant_id(), $1, $2, $3, coalesce($4::date, CURRENT_DATE), $5, $6)
     RETURNING *`,
    [d.person_id, d.fund_id, d.amount, d.starts_on || null, d.ends_on || null,
     normaliseText(d.note)]);
  return rows[0];
}

export async function income(tx: Tx, from: string, to: string) {
  const { rows } = await tx.query(`SELECT * FROM income_statement($1, $2)`, [from, to]);
  return rows;
}

/** Top givers, named only. Anonymous cash is never attributed to anybody. */
export async function topGivers(tx: Tx, limit = 10) {
  const { rows } = await tx.query(`
    SELECT p.id, trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
           sum(c.amount) AS total, count(*)::int AS gifts, max(c.given_on) AS last_gave
      FROM contributions c JOIN persons p ON p.id = c.person_id
     WHERE c.given_on > CURRENT_DATE - interval '12 months'
     GROUP BY p.id, p.first_name, p.last_name
     ORDER BY sum(c.amount) DESC LIMIT $1`, [limit]);
  return rows;
}
