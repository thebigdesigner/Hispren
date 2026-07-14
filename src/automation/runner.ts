/**
 * ACTIONS, AND THE RUNNER.
 *
 * THE SAFETY LAYER IS NOT HERE.
 *
 * That is the entire point. Every message this engine sends goes through
 * prepare() — the same function the compose screen uses — and therefore through
 * consent, deceased, quiet hours, frequency caps, DND routing and the
 * suppression list, without a single line of automation-specific safety code.
 *
 * If the safety layer lived in the automation engine, then every OTHER path
 * that can produce a message would need its own copy, and one of them would be
 * wrong. It lives at the send boundary. Nothing gets past it. Not the composer,
 * not a reminder, not a workflow, not Phase 4's AI.
 */
import { Tx, platformQuery, withTenant } from "../platform/db";
import { prepare, dispatch } from "../notify/service";

export type ActionType =
  | "send_message" | "create_task" | "notify_leader" | "change_stage"
  | "add_to_list" | "add_to_group" | "wait";

export const ACTIONS: Record<ActionType, { label: string; what: string }> = {
  send_message: {
    label: "Send them a message",
    what: "WhatsApp, email or SMS. Goes through every consent check, every " +
          "frequency cap, and every quiet-hours rule. You cannot build a " +
          "workflow that reaches somebody who opted out.",
  },
  notify_leader: {
    label: "Tell their cell leader",
    what: "Not the member — the HUMAN responsible for them. For a member who " +
          "has stopped coming, this is almost always the right action. A " +
          "machine-generated 'we missed you' to somebody whose mother just " +
          "died is worse than silence.",
  },
  create_task: {
    label: "Give somebody a job",
    what: "A named person, with a due date. Chase them if it is not done.",
  },
  change_stage: { label: "Move them along", what: "First timer -> Convert -> Member." },
  add_to_list:  { label: "Add them to a list", what: "So a human can act on them together." },
  add_to_group: { label: "Put them in a cell", what: "Assign them to a group." },
  wait:         { label: "Wait", what: "Do nothing for a while." },
};

// ---------------------------------------------------------------------------
// THE RUNNER
// ---------------------------------------------------------------------------

/**
 * Sweep the enrollments that are due.
 *
 * One indexed query, once a minute:  WHERE status='active' AND wake_at <= now()
 *
 * That index is the entire architecture. The alternative — a cron per workflow
 * per church — does not survive a hundred churches, and there is no version of
 * it that a single person can reason about.
 */
export async function runDue(limit = 100) {
  const { rows } = await platformQuery<any>(
    `SELECT e.id, e.tenant_id, e.workflow_id, e.wf_version, e.person_id,
            e.current_step, e.context, e.test_mode
       FROM enrollments e
      WHERE e.status = 'active' AND e.wake_at IS NOT NULL AND e.wake_at <= now()
      ORDER BY e.wake_at
      LIMIT $1`, [limit]);

  let ran = 0;
  for (const e of rows) {
    try { await step(e); ran++; }
    catch (err: any) { await retryOrFail(e, err); }
  }
  return ran;
}

const MAX_ATTEMPTS = 4;
const BACKOFF = [1, 5, 30, 120];   // minutes

/**
 * RETRIES.
 *
 * A step that failed because the network blinked is not a reason to abandon a
 * person mid-journey. That is the difference between a system and a fragile
 * script: the first one assumes things will go wrong and carries on anyway.
 *
 * Exponential-ish backoff: 1 minute, 5, 30, 120. Four attempts across two
 * hours. If it is still failing after that, it is not a blip — it is broken,
 * and a human needs to look at it.
 */
async function retryOrFail(e: any, err: any) {
  const prior = await platformQuery<any>(
    `SELECT count(*)::int AS n FROM executions
      WHERE enrollment_id = $1 AND position = $2 AND status = 'failed'`,
    [e.id, e.current_step]);
  const attempt = prior.rows[0].n + 1;

  await platformQuery(
    `INSERT INTO executions (tenant_id, enrollment_id, position, action_type,
        status, error, attempts)
     VALUES ($1, $2, $3, 'retry', 'failed', $4, $5)`,
    [e.tenant_id, e.id, e.current_step, err.message, attempt]);

  if (attempt >= MAX_ATTEMPTS) {
    console.error(`enrollment ${e.id} failed after ${attempt} attempts:`, err.message);
    await platformQuery(
      `UPDATE enrollments SET status='failed', wake_at=NULL, cancelled_reason=$2
        WHERE id=$1`,
      [e.id, `Failed ${attempt} times: ${err.message}`]);
    return;
  }

  const wait = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
  console.warn(`enrollment ${e.id} attempt ${attempt} failed, retrying in ${wait}m`);
  await platformQuery(
    `UPDATE enrollments SET wake_at = now() + ($2 || ' minutes')::interval
      WHERE id = $1`, [e.id, String(wait)]);
}

/** Run ONE step of ONE enrollment, then decide when to wake up again. */
async function step(e: any) {
  await withTenant(e.tenant_id, async (tx) => {
    const s = await tx.query(
      `SELECT * FROM workflow_steps
        WHERE workflow_id = $1 AND position = $2`,
      [e.workflow_id, e.current_step]);

    // No step at this position -> the journey is over.
    if (!s.rows[0]) {
      await tx.query(
        `UPDATE enrollments SET status='completed', completed_at=now(), wake_at=NULL
          WHERE id=$1`, [e.id]);
      await tx.query(
        `UPDATE workflows SET stats_completed = stats_completed + 1 WHERE id = $1`,
        [e.workflow_id]);
      return;
    }

    const st = s.rows[0];

    // The person may have died, been archived, or left since they were enrolled.
    // A workflow that started three weeks ago has NO IDEA what has happened since.
    const p = await tx.query(
      `SELECT p.*, js.key AS stage_key,
              trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name
         FROM persons p LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
        WHERE p.id = $1`, [e.person_id]);

    if (!p.rows[0] || p.rows[0].is_deceased || p.rows[0].archived_at) {
      await tx.query(
        `UPDATE enrollments SET status='cancelled', wake_at=NULL,
                cancelled_reason='the person is no longer with the church'
          WHERE id=$1`, [e.id]);
      return;
    }
    const person = p.rows[0];

    // Conditions. "Only if they are still a first timer" — because if a human
    // already reached them and moved them along, the automation must get out
    // of the way.
    if (st.condition && !meets(person, st.condition)) {
      await log(tx, e, st, "skipped", "condition");
      await advance(tx, e, st);
      return;
    }

    if (e.test_mode) {
      await log(tx, e, st, "skipped", "test_mode",
        { would_have: st.action_type, config: st.action_config });
      await advance(tx, e, st);
      return;
    }

    const r = await act(tx, e, st, person);
    await log(tx, e, st, r.ok ? "done" : "skipped", r.reason, r.result);
    await advance(tx, e, st);
  });
}

/** Move to the next step, and work out when to wake up for it. */
async function advance(tx: Tx, e: any, st: any) {
  const next = await tx.query(
    `SELECT delay_minutes FROM workflow_steps
      WHERE workflow_id = $1 AND position = $2`,
    [e.workflow_id, e.current_step + 1]);

  if (!next.rows[0]) {
    await tx.query(
      `UPDATE enrollments SET status='completed', completed_at=now(),
              wake_at=NULL, current_step=$2 WHERE id=$1`,
      [e.id, e.current_step + 1]);
    await tx.query(
      `UPDATE workflows SET stats_completed = stats_completed + 1 WHERE id = $1`,
      [e.workflow_id]);
    return;
  }

  const wait = Number(next.rows[0].delay_minutes ?? 0);
  await tx.query(
    `UPDATE enrollments
        SET current_step = $2,
            wake_at = now() + ($3 || ' minutes')::interval
      WHERE id = $1`,
    [e.id, e.current_step + 1, String(wait)]);
}

async function log(
  tx: Tx, e: any, st: any, status: string, reason?: string, result?: any
) {
  await tx.query(
    `INSERT INTO executions (tenant_id, enrollment_id, step_id, position,
        action_type, status, skipped_reason, result)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [e.id, st.id, st.position, st.action_type, status,
     reason ?? null, result ? JSON.stringify(result) : null]);
}

function meets(person: any, cond: any): boolean {
  const v = person[cond.field];
  switch (cond.op) {
    case "eq":  return v == cond.value;
    case "ne":  return v != cond.value;
    case "in":  return Array.isArray(cond.value) && cond.value.includes(v);
    case "set": return v !== null && v !== undefined && v !== "";
    case "unset": return v === null || v === undefined || v === "";
    default: return true;
  }
}

// ---------------------------------------------------------------------------
// THE ACTIONS
// ---------------------------------------------------------------------------
async function act(tx: Tx, e: any, st: any, person: any):
  Promise<{ ok: boolean; reason?: string; result?: any }> {

  const cfg = st.action_config ?? {};

  switch (st.action_type as ActionType) {

    // ── the one that matters ───────────────────────────────────────────────
    case "send_message": {
      // THROUGH prepare(). Not around it, not beside it — through it.
      //
      // Consent, deceased, quiet hours, frequency caps, DND routing, the
      // suppression list: all of it applies, automatically, because this is the
      // same code path the compose screen uses.
      //
      // It is not possible to build a workflow in this product that reaches
      // somebody who opted out. Not "difficult". Not possible.
      const p = await prepare(tx, {
        name: `Automation: ${cfg.name ?? "workflow"}`,
        body: cfg.body ?? "",
        subject: cfg.subject,
        channel: cfg.channel ?? "whatsapp",
        personIds: [person.id],
        userId: "00000000-0000-0000-0000-000000000000",
      });

      if (!p.queued) {
        // The suppression layer refused. Say exactly why — that reason is the
        // answer when a pastor asks why she never got it.
        const why = Object.keys(p.reasons)[0] ?? "suppressed";
        return { ok: false, reason: why, result: { campaign_id: p.campaign_id } };
      }

      await dispatch(tx, p.campaign_id).catch(() => {});
      return { ok: true, result: { campaign_id: p.campaign_id, channel: p.by_email ? "email" : "whatsapp" } };
    }

    // ── the pastorally correct one ─────────────────────────────────────────
    case "notify_leader": {
      // For a member who has stopped coming, this is almost always the right
      // action — and "send_message" is almost always the wrong one.
      //
      // A machine-generated "we missed you!" to somebody whose mother died last
      // week, or who left the church deliberately after an argument, is worse
      // than silence. So the machine tells a HUMAN, and the human decides.
      const leader = await tx.query(
        `SELECT g.leader_id, g.name AS group_name
           FROM groups g WHERE g.id = $1`, [person.home_group_id]);

      const leaderId = leader.rows[0]?.leader_id;
      if (!leaderId) return { ok: false, reason: "no_leader" };

      // assigned_to_person = the LEADER (who does the work)
      // subject_id         = the MEMBER (who it is about)
      // Those are two different people, and confusing them is how a cell leader
      // gets a task telling him to ring himself.
      await tx.query(
        `INSERT INTO tasks (tenant_id, title, detail, kind,
            subject_type, subject_id, assigned_to_person, status, due_at, source)
         VALUES (current_tenant_id(), $1, $2, 'follow_up',
                 'person', $3, $4, 'open', now() + ($5 || ' days')::interval, 'automation')`,
        [(cfg.title ?? "Check on {{name}}").replace(/\{\{name\}\}/g, person.name),
         (cfg.body ?? "").replace(/\{\{name\}\}/g, person.name),
         person.id,          // WHO it is about
         leaderId,           // WHO must do it
         String(cfg.due_days ?? 2)]);

      return { ok: true, result: { told: leaderId, group: leader.rows[0].group_name } };
    }

    case "create_task": {
      await tx.query(
        `INSERT INTO tasks (tenant_id, title, detail, kind,
            subject_type, subject_id, assigned_to_user, status, due_at, source)
         VALUES (current_tenant_id(), $1, $2, 'follow_up',
                 'person', $3, $4, 'open', now() + ($5 || ' days')::interval, 'automation')`,
        [(cfg.title ?? "Follow up with {{name}}").replace(/\{\{name\}\}/g, person.name),
         (cfg.body ?? "").replace(/\{\{name\}\}/g, person.name),
         person.id,
         cfg.assignee ?? null,
         String(cfg.due_days ?? 2)]);
      return { ok: true };
    }

    case "change_stage": {
      const s = await tx.query(
        `SELECT id FROM journey_stages WHERE key = $1`, [cfg.stage]);
      if (!s.rows[0]) return { ok: false, reason: "no_such_stage" };

      await tx.query(
        `INSERT INTO person_stage_history (tenant_id, person_id, from_stage_id, to_stage_id)
         VALUES (current_tenant_id(), $1, $2, $3)`,
        [person.id, person.journey_stage_id, s.rows[0].id]);
      await tx.query(
        `UPDATE persons SET journey_stage_id = $2 WHERE id = $1`,
        [person.id, s.rows[0].id]);
      return { ok: true, result: { stage: cfg.stage } };
    }

    case "add_to_list": {
      await tx.query(
        `INSERT INTO segment_members (tenant_id, segment_id, person_id)
         VALUES (current_tenant_id(), $1, $2) ON CONFLICT DO NOTHING`,
        [cfg.list_id, person.id]);
      return { ok: true };
    }

    case "add_to_group": {
      await tx.query(
        `INSERT INTO group_memberships (tenant_id, group_id, person_id, role)
         VALUES (current_tenant_id(), $1, $2, 'member')
         ON CONFLICT DO NOTHING`, [cfg.group_id, person.id]);
      await tx.query(
        `UPDATE persons SET home_group_id = $2
          WHERE id = $1 AND home_group_id IS NULL`, [person.id, cfg.group_id]);
      return { ok: true };
    }

    case "wait":
      return { ok: true };

    default:
      return { ok: false, reason: "unknown_action" };
  }
}
