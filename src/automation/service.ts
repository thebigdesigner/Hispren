import { Tx, platformQuery } from "../platform/db";
import { normaliseText } from "../members/service";
import { RECIPES, recipe } from "./recipes";
import { TRIGGERS } from "./triggers";
import { ACTIONS } from "./runner";
import { enroll } from "./triggers";

export async function workflows(tx: Tx) {
  const { rows } = await tx.query(`
    SELECT w.*,
      (SELECT count(*)::int FROM workflow_steps s WHERE s.workflow_id = w.id) AS steps,
      (SELECT count(*)::int FROM enrollments e
        WHERE e.workflow_id = w.id AND e.status = 'active') AS in_progress
      FROM workflows w WHERE w.archived_at IS NULL
     ORDER BY w.status = 'active' DESC, w.created_at DESC`);
  return rows;
}

export async function getWorkflow(tx: Tx, id: string) {
  const { rows } = await tx.query(`
    SELECT w.*,
      coalesce((SELECT json_agg(json_build_object(
        'id', s.id, 'position', s.position, 'action_type', s.action_type,
        'action_config', s.action_config, 'delay_minutes', s.delay_minutes,
        'condition', s.condition
      ) ORDER BY s.position) FROM workflow_steps s WHERE s.workflow_id = w.id), '[]') AS steps,
      coalesce((SELECT json_agg(json_build_object(
        'id', e.id, 'status', e.status, 'current_step', e.current_step,
        'wake_at', e.wake_at, 'enrolled_at', e.enrolled_at, 'test_mode', e.test_mode,
        'name', trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,''))
      ) ORDER BY e.enrolled_at DESC)
        FROM enrollments e JOIN persons p ON p.id = e.person_id
       WHERE e.workflow_id = w.id LIMIT 50), '[]') AS enrollments
    FROM workflows w WHERE w.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Install a recipe. One click and it works. */
export async function useRecipe(tx: Tx, key: string, userId: string) {
  const r = recipe(key);
  if (!r) throw new Error("No such recipe.");

  const w = await tx.query(
    `INSERT INTO workflows (tenant_id, name, description, recipe, trigger_type,
        trigger_config, allow_reenrollment, reenroll_after_days, status, created_by)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, 'draft', $8)
     RETURNING *`,
    [r.name, r.why, r.key, r.trigger_type, JSON.stringify(r.trigger_config),
     !!r.allow_reenrollment, r.reenroll_after_days ?? null, userId]);

  const id = w.rows[0].id;
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    await tx.query(
      `INSERT INTO workflow_steps (tenant_id, workflow_id, position, action_type,
          action_config, delay_minutes, condition)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
      [id, i, s.action_type, JSON.stringify(s.action_config),
       s.delay_minutes ?? 0, s.condition ? JSON.stringify(s.condition) : null]);
  }
  // It arrives as a DRAFT. It does not fire until she says so.
  return w.rows[0];
}

export async function setStatus(tx: Tx, id: string, status: string) {
  if (!["draft", "active", "paused"].includes(status)) throw new Error("bad status");

  if (status === "active") {
    const s = await tx.query(
      `SELECT count(*)::int AS n FROM workflow_steps WHERE workflow_id = $1`, [id]);
    if (!s.rows[0].n) throw new Error("It has no steps. It would do nothing.");
  }

  const { rows } = await tx.query(
    `UPDATE workflows SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status]);
  return rows[0] ?? null;
}

/**
 * Editing a LIVE workflow bumps the version.
 *
 * People already halfway through finish on the version they started. Changing
 * the message somebody is due to receive tomorrow, after they were enrolled
 * yesterday, is not an edit — it is a different workflow, and they did not
 * consent to it.
 */
export async function updateWorkflow(tx: Tx, id: string, d: any) {
  const cur = await tx.query(`SELECT status, version FROM workflows WHERE id = $1`, [id]);
  if (!cur.rows[0]) return null;
  const bump = cur.rows[0].status === "active" ? 1 : 0;

  const { rows } = await tx.query(
    `UPDATE workflows
        SET name = coalesce($2, name),
            description = coalesce($3, description),
            trigger_config = coalesce($4::jsonb, trigger_config),
            allow_reenrollment = coalesce($5, allow_reenrollment),
            reenroll_after_days = $6,
            version = version + $7,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, normaliseText(d.name), normaliseText(d.description),
     d.trigger_config ? JSON.stringify(d.trigger_config) : null,
     d.allow_reenrollment ?? null, d.reenroll_after_days ?? null, bump]);
  return rows[0];
}

export async function saveSteps(tx: Tx, id: string, steps: any[]) {
  await tx.query(`DELETE FROM workflow_steps WHERE workflow_id = $1`, [id]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await tx.query(
      `INSERT INTO workflow_steps (tenant_id, workflow_id, position, action_type,
          action_config, delay_minutes, condition)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
      [id, i, s.action_type, JSON.stringify(s.action_config ?? {}),
       Number(s.delay_minutes ?? 0),
       s.condition ? JSON.stringify(s.condition) : null]);
  }
  return { steps: steps.length };
}

export async function archiveWorkflow(tx: Tx, id: string) {
  await tx.query(
    `UPDATE enrollments SET status='cancelled', wake_at=NULL,
            cancelled_reason='the workflow was archived'
      WHERE workflow_id = $1 AND status = 'active'`, [id]);
  const { rows } = await tx.query(
    `UPDATE workflows SET archived_at = now(), status = 'paused'
      WHERE id = $1 RETURNING id`, [id]);
  return rows[0] ?? null;
}

/**
 * TEST MODE.
 *
 * She is about to switch on something that will message 1,832 people. She needs
 * to see WHO, and WHAT THEY WOULD GET, before it fires — not afterwards, in the
 * message log, while her phone rings.
 *
 * Nothing is sent. Nothing is created. It answers one question honestly:
 * "if I turn this on right now, what happens?"
 */
export async function dryRun(tx: Tx, id: string) {
  const w = await getWorkflow(tx, id);
  if (!w) throw new Error("No such workflow.");

  let people: any[] = [];

  if (w.trigger_type === "absence") {
    const weeks = Number(w.trigger_config?.weeks ?? 3);
    const stages: string[] = w.trigger_config?.stages ?? [];
    const r = await tx.query(
      `SELECT p.id, trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
              s.weeks_absent, coalesce(p.phone, p.phone_2) AS phone, p.email,
              g.name AS group_name, js.label AS stage
         FROM person_activity_summary s
         JOIN persons p ON p.id = s.person_id
         LEFT JOIN groups g ON g.id = p.home_group_id
         LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
        WHERE s.weeks_absent >= $1 AND s.weeks_absent IS NOT NULL
          AND p.archived_at IS NULL AND NOT p.is_deceased
          ${stages.length ? `AND js.key = ANY($2::text[])` : ``}
        ORDER BY s.weeks_absent DESC LIMIT 200`,
      stages.length ? [weeks, stages] : [weeks]);
    people = r.rows;

  } else if (w.trigger_type === "date") {
    const field = w.trigger_config?.field ?? "date_of_birth";
    const off = Number(w.trigger_config?.days_offset ?? 0);
    const sql = field === "date_of_birth"
      ? `SELECT id, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) AS name,
                coalesce(phone, phone_2) AS phone, email
           FROM persons WHERE archived_at IS NULL AND NOT is_deceased
             AND dob_month = EXTRACT(MONTH FROM CURRENT_DATE + $1)::smallint
             AND dob_day   = EXTRACT(DAY   FROM CURRENT_DATE + $1)::smallint LIMIT 200`
      : `SELECT id, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) AS name,
                coalesce(phone, phone_2) AS phone, email
           FROM persons WHERE archived_at IS NULL AND NOT is_deceased
             AND ${field}::date = CURRENT_DATE - $1 LIMIT 200`;
    people = (await tx.query(sql, [off])).rows;

  } else {
    // event / property_change / schedule / threshold: nothing is due RIGHT NOW,
    // by definition. Show what it WOULD match instead.
    const r = await tx.query(
      `SELECT id, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) AS name,
              coalesce(phone, phone_2) AS phone, email
         FROM persons WHERE archived_at IS NULL AND NOT is_deceased LIMIT 5`);
    people = r.rows;
  }

  // What each step would actually do to the first person.
  const t = await tx.query(`SELECT name FROM tenants WHERE id = current_tenant_id()`);
  const church = t.rows[0]?.name ?? "";
  const sample = people[0];

  const preview = (w.steps ?? []).map((s: any) => ({
    position: s.position,
    action: s.action_type,
    delay_minutes: s.delay_minutes,
    body: (s.action_config?.body ?? s.action_config?.title ?? "")
      .replace(/\{\{first_name\}\}/g, (sample?.name ?? "Chinedu").split(" ")[0])
      .replace(/\{\{name\}\}/g, sample?.name ?? "Chinedu Okonkwo")
      .replace(/\{\{church\}\}/g, church),
    channel: s.action_config?.channel,
  }));

  return {
    trigger: w.trigger_type,
    would_enroll: people.length,
    people: people.slice(0, 25),
    preview,
    // The honest bit. The suppression layer will still refuse some of these,
    // and she should be told that BEFORE she switches it on.
    note: "Nothing has been sent. Every message would still go through consent, " +
          "quiet hours, frequency caps and the suppression list — some of these " +
          "people will be refused, and you will see exactly why in the run log.",
  };
}

/** Run it against ONE person, for real, so she can see it work. */
export async function testOnce(tx: Tx, id: string, personId: string, tenantId: string) {
  const w = await tx.query(`SELECT version FROM workflows WHERE id = $1`, [id]);
  if (!w.rows[0]) throw new Error("No such workflow.");
  const ok = await enroll(tenantId, id, w.rows[0].version, personId,
                          { test: true }, false);
  return { enrolled: ok };
}

export async function runLog(tx: Tx, workflowId?: string, limit = 100) {
  const p: any[] = [limit];
  let w = "";
  if (workflowId) { p.push(workflowId); w = `AND e.workflow_id = $2`; }
  const { rows } = await tx.query(`
    SELECT x.position, x.action_type, x.status, x.skipped_reason, x.error,
           x.ran_at, x.result,
           trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS person,
           w.name AS workflow
      FROM executions x
      JOIN enrollments e ON e.id = x.enrollment_id
      JOIN persons p ON p.id = e.person_id
      JOIN workflows w ON w.id = e.workflow_id
     WHERE 1=1 ${w}
     ORDER BY x.ran_at DESC LIMIT $1`, p);
  return rows;
}

export const LIBRARY = RECIPES.map(r => ({
  key: r.key, name: r.name, why: r.why,
  trigger_type: r.trigger_type, steps: r.steps.length,
}));

export { TRIGGERS, ACTIONS };
