/**
 * REMINDERS — cron, not AI.
 *
 * Birthdays, service reminders, missed-attendance alerts. These are database
 * queries on a schedule. Routing them through a language model would pay tokens
 * for a WHERE clause and introduce hallucination into a feature that must never
 * fail.
 *
 * Every one of these composes a DRAFT and stops. A human sends. Always.
 * An automation that autonomously texts "we've missed you at church!" to a
 * member who died last week does damage no feature can repay — and church data
 * is ALWAYS stale.
 */
import { platformQuery, withTenant } from "../platform/db";
import { compose } from "./service";

async function activeTenants() {
  const { rows } = await platformQuery<{ id: string }>(
    `SELECT id FROM tenants WHERE status IN ('active','trial')`);
  return rows;
}

/** Draft a birthday message for everyone whose birthday is today. */
export async function birthdayReminders() {
  const today = new Date();
  const m = today.getMonth() + 1, d = today.getDate();

  for (const t of await activeTenants()) {
    await withTenant(t.id, async (tx) => {
      const tpl = await tx.query(
        `SELECT id, body FROM message_templates
          WHERE kind = 'birthday' AND archived_at IS NULL LIMIT 1`);
      if (!tpl.rows[0]) return;

      const people = await tx.query(
        `SELECT id FROM persons
          WHERE dob_month = $1 AND dob_day = $2
            AND archived_at IS NULL AND NOT is_deceased
            AND (phone IS NOT NULL OR phone_2 IS NOT NULL)`, [m, d]);
      if (!people.rows.length) return;

      const owner = await tx.query(
        `SELECT user_id FROM tenant_memberships
          WHERE tenant_id = current_tenant_id() AND role IN ('owner','admin') LIMIT 1`);

      await compose(tx, {
        channel: "sms",
        body: tpl.rows[0].body,
        template_id: tpl.rows[0].id,
        person_ids: people.rows.map((r: any) => r.id),
        userId: owner.rows[0]?.user_id,
      });
      // DRAFT. It sits in Messages waiting for a human to press send.
    });
  }
}

/** Saturday evening: draft a reminder for tomorrow's service. */
export async function serviceReminders() {
  const tomorrow = (new Date().getDay() + 1) % 7;

  for (const t of await activeTenants()) {
    await withTenant(t.id, async (tx) => {
      const svc = await tx.query(
        `SELECT name FROM services
          WHERE day_of_week = $1 AND archived_at IS NULL AND event_date IS NULL
          ORDER BY position LIMIT 1`, [tomorrow]);
      if (!svc.rows[0]) return;

      const tpl = await tx.query(
        `SELECT id, body FROM message_templates
          WHERE kind = 'service_reminder' AND archived_at IS NULL LIMIT 1`);
      if (!tpl.rows[0]) return;

      const people = await tx.query(
        `SELECT id FROM persons
          WHERE archived_at IS NULL AND NOT is_deceased
            AND (phone IS NOT NULL OR phone_2 IS NOT NULL)`);
      if (!people.rows.length) return;

      const owner = await tx.query(
        `SELECT user_id FROM tenant_memberships
          WHERE tenant_id = current_tenant_id() AND role IN ('owner','admin') LIMIT 1`);

      await compose(tx, {
        channel: "sms",
        body: tpl.rows[0].body,
        template_id: tpl.rows[0].id,
        person_ids: people.rows.map((r: any) => r.id),
        userId: owner.rows[0]?.user_id,
      });
    });
  }
}

/**
 * Missed attendance. THE most valuable automation in the product, and the one
 * most likely to cause harm if it fires blind.
 *
 * A person who came, then stopped, is a person you are losing. A person who
 * never came is not "missing" — they were never yours. The query knows the
 * difference. And it still only DRAFTS.
 */
export async function missedAttendanceReminders(weeks = 3) {
  for (const t of await activeTenants()) {
    await withTenant(t.id, async (tx) => {
      const tpl = await tx.query(
        `SELECT id, body FROM message_templates
          WHERE kind = 'missed_attendance' AND archived_at IS NULL LIMIT 1`);
      if (!tpl.rows[0]) return;

      const people = await tx.query(`SELECT id FROM at_risk($1)`, [weeks]);
      if (!people.rows.length) return;

      const owner = await tx.query(
        `SELECT user_id FROM tenant_memberships
          WHERE tenant_id = current_tenant_id() AND role IN ('owner','admin') LIMIT 1`);

      await compose(tx, {
        channel: "sms",
        body: tpl.rows[0].body,
        template_id: tpl.rows[0].id,
        person_ids: people.rows.map((r: any) => r.id),
        userId: owner.rows[0]?.user_id,
      });
    });
  }
}

/** Sweep uncontacted first-timers into owned, dated follow-up tasks. */
export async function followUpTasks() {
  const { generateFollowUps } = await import("../care/service");
  for (const t of await activeTenants()) {
    await withTenant(t.id, (tx) => generateFollowUps(tx));
  }
}
