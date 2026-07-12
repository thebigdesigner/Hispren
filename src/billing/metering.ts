/**
 * Billing jobs. ACTIVE-member metering — the pricing model's load-bearing wall.
 *
 * "Active" (v1 definition, keep in ONE place):
 *   communicated-with in the last 90 days (any channel, delivered)
 *   OR holds a member-app account
 *   AND NOT deceased AND NOT archived.
 * Visitors/first-timers are never billable (journey stage default).
 *
 * Growth protection: computed_band is RECORDED nightly but the subscription's
 * member_band only changes at RENEWAL. Nobody is re-billed mid-term for
 * growing. This is a sales promise — do not "fix" it.
 */
import { platformQuery, withTenant } from "../platform/db";

const BANDS: Array<{ key: string; max: number }> = [
  { key: "b0_250", max: 250 },
  { key: "b251_750", max: 750 },
  { key: "b751_2000", max: 2000 },
  { key: "b2001_5000", max: 5000 },
  { key: "b5000_plus", max: Infinity },
];
export const bandFor = (n: number) => BANDS.find((b) => n <= b.max)!.key;

export async function runMeteringSnapshot(): Promise<void> {
  const tenants = await platformQuery<{ id: string }>(
    `SELECT id FROM tenants WHERE status IN ('active','trial')`
  );
  for (const t of tenants.rows) {
    await withTenant(t.id, async (tx) => {
      // Derive is_billable first (also powers UI badges)
      await tx.query(`
        UPDATE persons p SET is_billable = q.active
        FROM (
          SELECT p2.id,
                 ( (p2.last_activity_at > now() - interval '90 days'
                    OR p2.custom ? 'app_account_id')
                   AND NOT p2.is_deceased
                   AND p2.archived_at IS NULL
                   AND coalesce(js.is_billable_default, true)
                 ) AS active
          FROM persons p2
          LEFT JOIN journey_stages js ON js.id = p2.journey_stage_id
        ) q WHERE q.id = p.id AND p.is_billable IS DISTINCT FROM q.active
      `);
      const { rows } = await tx.query(`
        SELECT count(*) FILTER (WHERE is_billable) AS active,
               count(*) AS total
        FROM persons WHERE archived_at IS NULL
      `);
      const active = Number(rows[0].active), total = Number(rows[0].total);
      await tx.query(
        `INSERT INTO member_metering_snapshots
           (tenant_id, snapshot_date, active_members, total_persons, computed_band)
         VALUES (current_tenant_id(), CURRENT_DATE, $1, $2, $3)
         ON CONFLICT (tenant_id, snapshot_date) DO UPDATE
           SET active_members = $1, total_persons = $2, computed_band = $3`,
        [active, total, bandFor(active)]
      );
    });
  }
}

/** Renewal: generate the next period's invoice; apply band change HERE only. */
export async function runRenewals(): Promise<void> {
  const due = await platformQuery<any>(`
    SELECT s.*, t.name AS tenant_name
      FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.status = 'active' AND s.current_period_end <= CURRENT_DATE
       AND NOT s.cancel_at_period_end
  `);
  for (const sub of due.rows) {
    const snap = await platformQuery<{ computed_band: string }>(
      `SELECT computed_band FROM member_metering_snapshots
        WHERE tenant_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [sub.tenant_id]
    );
    const newBand = snap.rows[0]?.computed_band ?? sub.member_band;
    const price = await platformQuery<any>(
      `SELECT * FROM plan_prices
        WHERE plan_tier = $1 AND member_band = $2
          AND active_from <= CURRENT_DATE
          AND (active_to IS NULL OR active_to > CURRENT_DATE)
        ORDER BY active_from DESC LIMIT 1`,
      [sub.plan_tier, newBand]
    );
    if (!price.rows[0]) continue; // e.g. ministry×b0_250 not sold — flag for sales
    const p = price.rows[0];
    const amount = sub.billing_cycle === "annual" ? p.annual_ngn : p.monthly_ngn;
    const number = `HSP-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

    const inv = await platformQuery<{ id: string }>(
      `INSERT INTO invoices (tenant_id, number, status, subtotal, total, due_at,
                             period_start, period_end)
       VALUES ($1,$2,'open',$3,$3, now() + interval '7 days',
               $4, $4::date + CASE WHEN $5 = 'annual'
                                   THEN interval '1 year' ELSE interval '1 month' END)
       RETURNING id`,
      [sub.tenant_id, number, amount, sub.current_period_end, sub.billing_cycle]
    );
    await platformQuery(
      `INSERT INTO invoice_lines (invoice_id, kind, description, unit_ngn, amount_ngn)
       VALUES ($1,'subscription',$2,$3,$3)`,
      [inv.rows[0].id,
       `${sub.plan_tier} plan · ${newBand} · ${sub.billing_cycle}`, amount]
    );
    await platformQuery(
      `UPDATE subscriptions
          SET member_band = $2,
              current_period_start = current_period_end,
              current_period_end = current_period_end +
                CASE WHEN billing_cycle='annual' THEN interval '1 year'
                     ELSE interval '1 month' END
        WHERE id = $1`,
      [sub.id, newBand]
    );
  }
}

/**
 * Dunning. Steps: reminder at +3d, +7d, +14d, final notice, THEN 'suspended'
 * step is only RECORDED — actual suspension requires a human platform-admin
 * action in the UI. Suspending a church kills every member's communications;
 * a machine must never do it alone.
 */
export async function runDunningSweep(): Promise<void> {
  const steps = [
    { step: "reminder_3d", days: 3 },
    { step: "reminder_7d", days: 7 },
    { step: "reminder_14d", days: 14 },
    { step: "final_notice", days: 21 },
  ] as const;
  for (const s of steps) {
    const { rows } = await platformQuery<{ id: string }>(
      `SELECT i.id FROM invoices i
        WHERE i.status = 'open' AND i.due_at < now() - ($1 || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM dunning_events d
                           WHERE d.invoice_id = i.id AND d.step = $2)`,
      [s.days, s.step]
    );
    for (const r of rows) {
      await platformQuery(
        `INSERT INTO dunning_events (invoice_id, step) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [r.id, s.step]
      );
      // notification to church owner sent via jobsQueue → notification service
    }
  }
}
