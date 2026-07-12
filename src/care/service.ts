/**
 * TASKS + PASTORAL CARE.
 *
 * The dashboard's "needs a call" list has been a lie until now — it just
 * filtered by lifecycle stage. Nobody OWNED the call. Nobody knew if it
 * happened. A first-timer could sit there for six weeks looking urgent while
 * everyone assumed someone else had rung.
 *
 * A follow-up is a TASK: it has an owner, a due date, and a state. That is the
 * difference between a list and a system.
 */
import { Tx } from "../platform/db";
import { publish } from "../platform/outbox";
import { normaliseText } from "../members/service";

// ===========================================================================
// TASKS
// ===========================================================================
export async function listTasks(
  tx: Tx, q: { status?: string; mine?: string; userId: string }
) {
  const params: unknown[] = [];
  const w: string[] = [];
  if (q.status) { params.push(q.status); w.push(`t.status = $${params.length}`); }
  else w.push(`t.status IN ('open','in_progress')`);
  if (q.mine === "true") { params.push(q.userId); w.push(`t.assigned_to_user = $${params.length}`); }

  const { rows } = await tx.query(
    `SELECT t.*,
            u.full_name AS owner,
            trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS subject_name,
            p.phone AS subject_phone,
            (t.due_at IS NOT NULL AND t.due_at < now()
              AND t.status IN ('open','in_progress')) AS overdue
       FROM tasks t
       LEFT JOIN app_users u ON u.id = t.assigned_to_user
       LEFT JOIN persons p   ON p.id = t.subject_id AND t.subject_type = 'person'
      WHERE ${w.join(" AND ")}
      ORDER BY (t.due_at IS NULL), t.due_at, t.created_at
      LIMIT 200`, params);
  return rows;
}

export async function createTask(
  tx: Tx,
  t: { title: string; detail?: string; kind?: string; subject_type?: string;
       subject_id?: string; assigned_to_user?: string; assigned_to_person?: string;
       due_at?: string; source?: string }
) {
  const { rows } = await tx.query(
    `INSERT INTO tasks (tenant_id, title, detail, kind, subject_type, subject_id,
                        assigned_to_user, assigned_to_person, due_at, source)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [normaliseText(t.title), normaliseText(t.detail), t.kind ?? "general",
     t.subject_type ?? null, t.subject_id ?? null,
     t.assigned_to_user ?? null, t.assigned_to_person ?? null,
     t.due_at ?? null, t.source ?? "manual"]);
  await publish(tx, { type: "task.created", entityType: "task", entityId: rows[0].id,
    payload: { kind: rows[0].kind } });
  return rows[0];
}

export async function updateTask(tx: Tx, id: string, patch: any) {
  const cols: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    if (!["title","detail","status","assigned_to_user","due_at"].includes(k)) continue;
    vals.push(typeof v === "string" ? normaliseText(v) : v);
    cols.push(`${k} = $${vals.length}`);
  }
  if (patch.status === "done") cols.push(`completed_at = now()`);
  if (!cols.length) return null;
  const { rows } = await tx.query(
    `UPDATE tasks SET ${cols.join(", ")} WHERE id = $1 RETURNING *`, vals);
  if (rows[0] && patch.status === "done") {
    await publish(tx, { type: "task.completed", entityType: "task", entityId: id });
  }
  return rows[0] ?? null;
}

/**
 * Generate follow-up tasks for every first-timer nobody has claimed.
 *
 * The 72-hour window is not arbitrary. A first-timer contacted within three
 * days comes back at a far higher rate than one contacted on day ten. This is
 * the single highest-leverage automation in the entire product.
 */
export async function generateFollowUps(tx: Tx) {
  const { rows } = await tx.query(`
    INSERT INTO tasks (tenant_id, title, kind, subject_type, subject_id,
                       assigned_to_user, due_at, source)
    SELECT current_tenant_id(),
           'Call ' || trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
           'follow_up', 'person', p.id,
           (SELECT user_id FROM tenant_memberships
             WHERE tenant_id = current_tenant_id()
               AND role IN ('pastor','admin','owner') LIMIT 1),
           p.created_at + interval '72 hours',
           'auto:first_timer'
      FROM persons p
      JOIN journey_stages js ON js.id = p.journey_stage_id
     WHERE p.archived_at IS NULL
       AND js.key IN ('visitor','first_timer')
       AND (p.phone IS NOT NULL OR p.phone_2 IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
          WHERE t.subject_id = p.id AND t.kind = 'follow_up'
            AND t.status IN ('open','in_progress','done'))
    RETURNING id`);
  return { created: rows.length };
}

// ===========================================================================
// PASTORAL CARE
//
// Prayer, counselling, hospital, bereavement, benevolence. A pastor cares
// about this more than any dashboard — it is the actual job.
// ===========================================================================
export async function listCare(tx: Tx, status?: string) {
  const { rows } = await tx.query(
    `SELECT c.*, u.full_name AS owner,
            trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS person_name,
            p.phone AS person_phone,
            (c.due_at IS NOT NULL AND c.due_at < now()
              AND c.status NOT IN ('resolved','closed')) AS overdue
       FROM care_requests c
       LEFT JOIN app_users u ON u.id = c.assigned_to
       LEFT JOIN persons p   ON p.id = c.person_id
      WHERE ($1::text IS NULL OR c.status = $1)
        AND ($1::text IS NOT NULL OR c.status NOT IN ('resolved','closed'))
      ORDER BY (c.due_at IS NULL), c.due_at, c.created_at DESC
      LIMIT 200`, [status ?? null]);
  return rows;
}

export async function createCare(
  tx: Tx,
  c: { person_id?: string; kind: string; summary: string; detail?: string;
       is_confidential?: boolean; assigned_to?: string; due_at?: string }
) {
  const { rows } = await tx.query(
    `INSERT INTO care_requests (tenant_id, person_id, kind, summary, detail,
                                is_confidential, assigned_to, due_at)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [c.person_id ?? null, c.kind, normaliseText(c.summary), normaliseText(c.detail),
     !!c.is_confidential, c.assigned_to ?? null, c.due_at ?? null]);
  await publish(tx, { type: "care.created", entityType: "care_request",
    entityId: rows[0].id, payload: { kind: c.kind } });
  return rows[0];
}

export async function updateCare(tx: Tx, id: string, patch: any) {
  const cols: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    if (!["status","assigned_to","detail","due_at","is_confidential"].includes(k)) continue;
    vals.push(typeof v === "string" ? normaliseText(v) : v);
    cols.push(`${k} = $${vals.length}`);
  }
  if (patch.status === "resolved") cols.push(`resolved_at = now()`);
  if (!cols.length) return null;
  const { rows } = await tx.query(
    `UPDATE care_requests SET ${cols.join(", ")} WHERE id = $1 RETURNING *`, vals);
  return rows[0] ?? null;
}

// ===========================================================================
// HOUSEHOLDS
// ===========================================================================
export async function createHousehold(tx: Tx, name: string, address?: string) {
  const { rows } = await tx.query(
    `INSERT INTO households (tenant_id, name, address)
     VALUES (current_tenant_id(),$1,$2) RETURNING *`,
    [normaliseText(name), normaliseText(address)]);
  return rows[0];
}
