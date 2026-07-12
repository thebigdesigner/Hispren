/**
 * LISTS.
 *
 * Breeze's single most-praised feature, and the `segments` table has sat unused
 * since Phase 0. Tag people, then message that tag directly.
 *
 * TWO KINDS, and the difference matters:
 *
 *   SAVED   You picked these people by hand. It never changes on its own.
 *           "Ushers", "Choir alto", "Baptism class 2026".
 *
 *   SMART   A question, answered fresh every time you open it. It has no
 *           members — it has a definition. "Everyone who has missed 3 Sundays"
 *           is not a list you maintain, it is a query you run.
 *
 * A church admin will maintain a hand-picked list of at-risk members for
 * exactly one week, and then it is stale and wrong and worse than nothing.
 * Smart lists are the ones that stay true.
 */
import { Tx } from "../platform/db";
import { normaliseText } from "../members/service";

/**
 * The smart lists a church actually needs. Each is a SQL fragment, run live.
 * These are the questions a pastor asks on a Monday morning.
 */
export const SMART: Record<string, { label: string; why: string; sql: string }> = {
  first_timers: {
    label: "First timers",
    why: "They came once. The next 72 hours decide whether they come again.",
    sql: `js.key IN ('visitor','first_timer')`,
  },
  at_risk: {
    label: "At risk",
    why: "They came, then stopped. These are people you HAD, and are losing.",
    sql: `p.last_attended_at IS NOT NULL
          AND p.last_attended_at < now() - interval '21 days'
          AND js.key NOT IN ('visitor','first_timer')`,
  },
  never_attended: {
    label: "Never marked present",
    why: "On the roll, but never once scanned in. Are they real?",
    sql: `p.last_attended_at IS NULL`,
  },
  no_group: {
    label: "In no cell or department",
    why: "They attend faithfully and belong to nothing. Churches lose these people and never notice.",
    sql: `p.home_group_id IS NULL AND js.key NOT IN ('visitor','first_timer')`,
  },
  unreachable: {
    label: "Cannot be contacted",
    why: "No phone, no email. You cannot reach them at all.",
    sql: `p.phone IS NULL AND p.phone_2 IS NULL AND p.email IS NULL`,
  },
  no_email: {
    label: "No email address",
    why: "Every one of these costs money to reach. Get an email and it costs nothing.",
    sql: `p.email IS NULL AND coalesce(p.phone, p.phone_2) IS NOT NULL`,
  },
  birthdays_this_month: {
    label: "Birthdays this month",
    why: "",
    sql: `p.dob_month = EXTRACT(MONTH FROM CURRENT_DATE)::smallint`,
  },
  workers: {
    label: "Workers and leaders",
    why: "The people who make Sunday happen.",
    sql: `js.key IN ('worker','leader','pastor')`,
  },
  opted_out: {
    label: "Opted out of SMS",
    why: "They replied STOP. They will never receive a text — email them instead.",
    sql: `EXISTS (SELECT 1 FROM consents c2 WHERE c2.person_id = p.id
                   AND c2.channel='sms' AND c2.status='revoked')`,
  },
};

/** Resolve a smart list to actual people, right now. */
export async function runSmart(tx: Tx, key: string) {
  const s = SMART[key];
  if (!s) throw new Error("No such list.");
  const { rows } = await tx.query(`
    SELECT p.id,
           trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
           p.phone, p.phone_2, p.email,
           js.label AS stage, g.name AS group_name,
           p.last_attended_at
      FROM persons p
      LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
      LEFT JOIN groups g          ON g.id  = p.home_group_id
     WHERE p.archived_at IS NULL AND NOT p.is_deceased AND (${s.sql})
     ORDER BY p.last_name NULLS LAST, p.first_name`);
  return rows;
}

/** How many are in each smart list, without fetching them all. */
export async function smartCounts(tx: Tx) {
  const parts = Object.entries(SMART).map(([k, s]) =>
    `(SELECT count(*)::int FROM persons p
       LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
      WHERE p.archived_at IS NULL AND NOT p.is_deceased AND (${s.sql})) AS "${k}"`);
  const { rows } = await tx.query(`SELECT ${parts.join(", ")}`);
  return Object.entries(SMART).map(([k, s]) => ({
    key: k, label: s.label, why: s.why, people: rows[0][k],
  }));
}

// ---------------------------------------------------------------------------
// SAVED lists — hand-picked
// ---------------------------------------------------------------------------
export async function listSaved(tx: Tx) {
  const { rows } = await tx.query(`
    SELECT s.id, s.name, s.created_at,
           (SELECT count(*)::int FROM segment_members m
             JOIN persons p ON p.id = m.person_id AND p.archived_at IS NULL
            WHERE m.segment_id = s.id) AS people
      FROM segments s
     WHERE s.kind = 'static' AND s.archived_at IS NULL
     ORDER BY s.name`);
  return rows;
}

export async function createSaved(tx: Tx, name: string, personIds: string[] = []) {
  const { rows } = await tx.query(
    `INSERT INTO segments (tenant_id, name, kind, entity)
     VALUES (current_tenant_id(), $1, 'static', 'person') RETURNING id, name`,
    [normaliseText(name)]);
  const id = rows[0].id;
  if (personIds.length) await addToList(tx, id, personIds);
  return rows[0];
}

export async function addToList(tx: Tx, id: string, personIds: string[]) {
  await tx.query(
    `INSERT INTO segment_members (tenant_id, segment_id, person_id)
     SELECT current_tenant_id(), $1, unnest($2::uuid[])
     ON CONFLICT DO NOTHING`, [id, personIds]);
  return { added: personIds.length };
}

export async function removeFromList(tx: Tx, id: string, personId: string) {
  await tx.query(
    `DELETE FROM segment_members WHERE segment_id = $1 AND person_id = $2`,
    [id, personId]);
  return { removed: true };
}

export async function getSaved(tx: Tx, id: string) {
  const { rows } = await tx.query(`
    SELECT s.id, s.name,
      coalesce((SELECT json_agg(json_build_object(
        'id', p.id,
        'name', trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
        'phone', coalesce(p.phone, p.phone_2), 'email', p.email,
        'stage', js.label
      ) ORDER BY p.last_name, p.first_name)
        FROM segment_members m
        JOIN persons p ON p.id = m.person_id AND p.archived_at IS NULL
        LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
       WHERE m.segment_id = s.id), '[]') AS people
    FROM segments s WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function archiveList(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `UPDATE segments SET archived_at = now() WHERE id = $1 RETURNING id`, [id]);
  return rows[0] ?? null;
}
