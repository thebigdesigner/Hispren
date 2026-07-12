/**
 * REMINDERS — cron jobs, not AI.
 *
 * Birthdays, service reminders, and missed-attendance alerts are a WHERE clause
 * and a date. Routing them through an LLM would mean paying tokens for a database
 * query, and introducing hallucination and latency into features that must never
 * fail.
 *
 * The engine decides WHEN. The AI (Phase 2) decides what to SAY. Not the reverse.
 *
 * Every one of these goes through prepare() — so consent, quiet hours, frequency
 * caps, DND routing and the deceased flag all apply. A birthday message cannot
 * reach someone who opted out. The suppression layer has no exceptions.
 */
import { withTenant, platformQuery } from "../platform/db";
import { prepare, dispatch } from "./service";

async function eachTenant(fn: (tenantId: string) => Promise<void>) {
  const { rows } = await platformQuery<{ id: string }>(
    `SELECT id FROM tenants WHERE status IN ('active','trial')`);
  for (const t of rows) {
    try { await fn(t.id); }
    catch (e: any) { console.error(`reminder failed for tenant ${t.id}:`, e.message); }
  }
}

/** Birthdays. dob_month / dob_day are generated columns — this is an index scan. */
export async function runBirthdays() {
  const now = new Date();
  const m = now.getMonth() + 1, d = now.getDate();

  await eachTenant(async (tenantId) => {
    await withTenant(tenantId, async (tx) => {
      const t = await tx.query(
        `SELECT id FROM message_templates WHERE key='birthday' AND archived_at IS NULL`);
      if (!t.rows[0]) return;
      const body = (await tx.query(
        `SELECT body FROM message_templates WHERE id=$1`, [t.rows[0].id])).rows[0].body;

      const people = await tx.query(
        `SELECT id FROM persons
          WHERE dob_month = $1 AND dob_day = $2
            AND archived_at IS NULL AND NOT is_deceased`, [m, d]);
      if (!people.rows.length) return;

      const p = await prepare(tx, {
        name: `Birthdays — ${now.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`,
        body,
        personIds: people.rows.map((r: any) => r.id),
        userId: "00000000-0000-0000-0000-000000000000",
        templateId: t.rows[0].id,
      });
      if (p.queued) await dispatch(tx, p.campaign_id).catch(() => {});
      console.log(`birthdays ${tenantId}: ${p.queued} queued, ${p.suppressed} suppressed`);
    });
  });
}

/**
 * Service reminder — the day BEFORE.
 *
 * Note the timing problem this exists to dodge: on the GENERIC route, MTN
 * refuses delivery between 8pm and 8am. A Saturday-evening reminder for Sunday
 * morning would silently never arrive. So we send in the afternoon.
 */
export async function runServiceReminders() {
  const tomorrow = (new Date().getDay() + 1) % 7;

  await eachTenant(async (tenantId) => {
    await withTenant(tenantId, async (tx) => {
      const svc = await tx.query(
        `SELECT name FROM services
          WHERE day_of_week = $1 AND archived_at IS NULL AND event_date IS NULL
          ORDER BY position LIMIT 1`, [tomorrow]);
      if (!svc.rows[0]) return;

      const t = await tx.query(
        `SELECT id, body FROM message_templates
          WHERE key='service_reminder' AND archived_at IS NULL`);
      if (!t.rows[0]) return;

      const body = t.rows[0].body.replace(/\{\{\s*service\s*\}\}/g, svc.rows[0].name);
      const p = await prepare(tx, {
        name: `Reminder — ${svc.rows[0].name}`,
        body, userId: "00000000-0000-0000-0000-000000000000",
        templateId: t.rows[0].id,
      });
      if (p.queued) await dispatch(tx, p.campaign_id).catch(() => {});
      console.log(`service reminder ${tenantId}: ${p.queued} queued`);
    });
  });
}

/**
 * Missed attendance. They CAME, then stopped — that is the whole point. A
 * visitor who never returned is not "missing", they were never ours.
 */
export async function runMissedAttendance(weeks = 3) {
  await eachTenant(async (tenantId) => {
    await withTenant(tenantId, async (tx) => {
      const t = await tx.query(
        `SELECT id, body FROM message_templates
          WHERE key='missed_you' AND archived_at IS NULL`);
      if (!t.rows[0]) return;

      const risk = await tx.query(`SELECT id FROM at_risk($1)`, [weeks]);
      if (!risk.rows.length) return;

      const p = await prepare(tx, {
        name: `Missed you — ${weeks}+ weeks away`,
        body: t.rows[0].body,
        personIds: risk.rows.map((r: any) => r.id),
        userId: "00000000-0000-0000-0000-000000000000",
        templateId: t.rows[0].id,
      });
      // DO NOT auto-send this one. A "we missed you" text to someone whose
      // mother just died, or who left the church deliberately, is worse than
      // silence. It goes to the pastor as a DRAFT. A human presses send.
      console.log(`missed-attendance ${tenantId}: ${p.queued} drafted for the pastor to approve`);
    });
  });
}
