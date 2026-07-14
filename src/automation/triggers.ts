/**
 * TRIGGERS.
 *
 * Six kinds. Five of them are reactions to something happening. One of them —
 * ABSENCE — is a reaction to nothing happening, and it is the whole reason this
 * phase is hard.
 */
import { Tx, platformQuery, withTenant } from "../platform/db";

export type TriggerType =
  | "event" | "property_change" | "date" | "absence" | "schedule" | "threshold";

export const TRIGGERS: Record<TriggerType, {
  label: string;
  how: string;
  when: string;      // when it is evaluated
}> = {
  event: {
    label: "Something happens",
    how: "A member registers. Somebody is marked present. A gift is recorded.",
    when: "Within seconds.",
  },
  property_change: {
    label: "Something changes",
    how: "A first timer becomes a Member. Somebody joins a cell.",
    when: "Within seconds.",
  },
  date: {
    label: "A date arrives",
    how: "Their birthday. Thirty days after they joined. A wedding anniversary.",
    when: "Every morning at 8am.",
  },
  absence: {
    label: "They stop coming",
    how: "Three weeks without attending. Six weeks. Nobody has contacted them in a month.",
    when: "Every night. This is the one that finds the people a church loses quietly.",
  },
  schedule: {
    label: "On a schedule",
    how: "Every Monday morning. The first of the month.",
    when: "As scheduled.",
  },
  threshold: {
    label: "A number crosses a line",
    how: "Attendance drops below 80% of its average. A cell has not reported in a fortnight.",
    when: "Every night.",
  },
};

// ---------------------------------------------------------------------------
// EVENT triggers — driven off event_outbox. The relay was built in Phase 0 and
// has never had a listener. It has one now.
// ---------------------------------------------------------------------------
export const EVENTS = [
  "member.registered",
  "visitor.registered",
  "member.stage_changed",
  "attendance.recorded",
  "giving.recorded",
  "group.member_added",
  "care.requested",
] as const;

/**
 * Consume the outbox. Every event that has never been relayed is matched
 * against every ACTIVE workflow whose trigger is that event, and the person it
 * happened to is enrolled.
 */
export async function consumeOutbox(limit = 200) {
  const { rows } = await platformQuery<any>(
    `SELECT id, tenant_id, event_type, entity_type, entity_id, payload
       FROM event_outbox
      WHERE relayed_at IS NULL
      ORDER BY occurred_at
      LIMIT $1`, [limit]);

  let enrolled = 0;

  for (const e of rows) {
    try {
      // Only PERSON events can enroll a person. A campaign.queued event has no
      // person to enroll, and pretending otherwise produces silent nonsense.
      if (e.entity_type === "person" && e.entity_id) {
        const wf = await platformQuery<any>(
          `SELECT id, version FROM workflows
            WHERE tenant_id = $1 AND status = 'active' AND archived_at IS NULL
              AND trigger_type = 'event'
              AND trigger_config->>'event' = $2`,
          [e.tenant_id, e.event_type]);

        for (const w of wf.rows) {
          const ok = await enroll(e.tenant_id, w.id, w.version, e.entity_id,
                                  { event: e.event_type, ...(e.payload ?? {}) });
          if (ok) enrolled++;
        }
      }
    } catch (err: any) {
      console.error("outbox event failed:", e.event_type, err.message);
    }
    await platformQuery(
      `UPDATE event_outbox SET relayed_at = now() WHERE id = $1`, [e.id]);
  }
  return { events: rows.length, enrolled };
}

// ---------------------------------------------------------------------------
// ENROLLMENT — with all the rules that stop it from being a spam machine
// ---------------------------------------------------------------------------
export async function enroll(
  tenantId: string, workflowId: string, version: number, personId: string,
  context: any = {}, testMode = false
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const w = await tx.query(
      `SELECT allow_reenrollment, reenroll_after_days, max_per_person
         FROM workflows WHERE id = $1`, [workflowId]);
    if (!w.rows[0]) return false;
    const rules = w.rows[0];

    // Never enroll somebody who has died. This is checked here, at the door,
    // and again at the send boundary. Twice is not paranoid — a "we missed you"
    // text to a widow is damage no feature repays.
    const p = await tx.query(
      `SELECT is_deceased, archived_at FROM persons WHERE id = $1`, [personId]);
    if (!p.rows[0] || p.rows[0].is_deceased || p.rows[0].archived_at) return false;

    // Already in it? The UNIQUE index would refuse anyway, but failing quietly
    // here is better than catching a constraint violation.
    const active = await tx.query(
      `SELECT 1 FROM enrollments
        WHERE workflow_id = $1 AND person_id = $2 AND status = 'active'`,
      [workflowId, personId]);
    if (active.rows[0]) return false;

    // Been through it before?
    const past = await tx.query(
      `SELECT count(*)::int AS n, max(enrolled_at) AS last
         FROM enrollments WHERE workflow_id = $1 AND person_id = $2`,
      [workflowId, personId]);
    const n = past.rows[0].n, last = past.rows[0].last;

    if (n > 0) {
      if (!rules.allow_reenrollment) return false;
      if (rules.max_per_person && n >= rules.max_per_person) return false;
      if (rules.reenroll_after_days && last) {
        const days = (Date.now() - new Date(last).getTime()) / 86400000;
        if (days < rules.reenroll_after_days) return false;
      }
    }

    await tx.query(
      `INSERT INTO enrollments (tenant_id, workflow_id, wf_version, person_id,
          context, test_mode, wake_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, now())
       ON CONFLICT DO NOTHING`,
      [workflowId, version, personId, JSON.stringify(context), testMode]);

    await tx.query(
      `UPDATE workflows SET stats_enrolled = stats_enrolled + 1, last_fired_at = now()
        WHERE id = $1`, [workflowId]);
    return true;
  });
}

// ---------------------------------------------------------------------------
// THE ABSENCE SWEEP — the hard one, and the valuable one
// ---------------------------------------------------------------------------
/**
 * Nightly. For every active absence workflow, find the people who crossed the
 * line TODAY.
 *
 * Note `weeks_absent = N`, not `>= N`. A person is enrolled on the week they
 * cross the threshold, ONCE. With `>=` they would match again every night for
 * the rest of their lives, and only the enrollment guard would be standing
 * between the church and a nightly "we miss you" text to the same person
 * forever.
 *
 * And `weeks_absent IS NOT NULL` — because NULL means they NEVER CAME. Somebody
 * who visited once and never returned is not "absent". They were never ours.
 */
export async function sweepAbsence() {
  const t = await platformQuery<any>(
    `SELECT DISTINCT tenant_id FROM workflows
      WHERE status = 'active' AND trigger_type = 'absence' AND archived_at IS NULL`);

  let total = 0;

  for (const { tenant_id } of t.rows) {
    // Refresh first. Sweeping a stale summary is how a church chases somebody
    // who came back last Sunday.
    await platformQuery(`SELECT refresh_activity_summary($1)`, [tenant_id]);

    const wf = await platformQuery<any>(
      `SELECT id, version, trigger_config FROM workflows
        WHERE tenant_id = $1 AND status = 'active' AND trigger_type = 'absence'
          AND archived_at IS NULL`, [tenant_id]);

    for (const w of wf.rows) {
      const weeks = Number(w.trigger_config?.weeks ?? 3);
      const stages: string[] = w.trigger_config?.stages ?? [];

      const people = await platformQuery<any>(
        `SELECT s.person_id
           FROM person_activity_summary s
           JOIN persons p ON p.id = s.person_id
           LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
          WHERE s.tenant_id = $1
            AND s.weeks_absent = $2          -- exactly the week they cross it
            AND s.weeks_absent IS NOT NULL   -- NULL = never came. Not absent.
            AND p.archived_at IS NULL AND NOT p.is_deceased
            ${stages.length ? `AND js.key = ANY($3::text[])` : ``}`,
        stages.length ? [tenant_id, weeks, stages] : [tenant_id, weeks]);

      for (const p of people.rows) {
        if (await enroll(tenant_id, w.id, w.version, p.person_id,
                         { weeks_absent: weeks })) total++;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// DATE triggers — birthdays, anniversaries, "30 days after they joined"
// ---------------------------------------------------------------------------
export async function sweepDates() {
  const t = await platformQuery<any>(
    `SELECT DISTINCT tenant_id FROM workflows
      WHERE status = 'active' AND trigger_type = 'date' AND archived_at IS NULL`);

  let total = 0;

  for (const { tenant_id } of t.rows) {
    const wf = await platformQuery<any>(
      `SELECT id, version, trigger_config FROM workflows
        WHERE tenant_id = $1 AND status = 'active' AND trigger_type = 'date'
          AND archived_at IS NULL`, [tenant_id]);

    for (const w of wf.rows) {
      const field  = w.trigger_config?.field ?? "date_of_birth";
      const offset = Number(w.trigger_config?.days_offset ?? 0);

      let sql: string;
      if (field === "date_of_birth") {
        // dob_month / dob_day are GENERATED columns — this is an index scan,
        // not a function call on every row.
        sql = `SELECT id AS person_id FROM persons
                WHERE tenant_id = $1 AND archived_at IS NULL AND NOT is_deceased
                  AND dob_month = EXTRACT(MONTH FROM CURRENT_DATE + $2)::smallint
                  AND dob_day   = EXTRACT(DAY   FROM CURRENT_DATE + $2)::smallint`;
      } else {
        sql = `SELECT id AS person_id FROM persons
                WHERE tenant_id = $1 AND archived_at IS NULL AND NOT is_deceased
                  AND ${field}::date = CURRENT_DATE - $2`;
      }

      const people = await platformQuery<any>(sql, [tenant_id, offset]);
      for (const p of people.rows) {
        if (await enroll(tenant_id, w.id, w.version, p.person_id,
                         { field, days_offset: offset })) total++;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// PROPERTY CHANGE — driven off person_stage_history
// ---------------------------------------------------------------------------
export async function sweepChanges() {
  const t = await platformQuery<any>(
    `SELECT DISTINCT tenant_id FROM workflows
      WHERE status = 'active' AND trigger_type = 'property_change' AND archived_at IS NULL`);

  let total = 0;

  for (const { tenant_id } of t.rows) {
    const wf = await platformQuery<any>(
      `SELECT id, version, trigger_config FROM workflows
        WHERE tenant_id = $1 AND status = 'active' AND trigger_type = 'property_change'
          AND archived_at IS NULL`, [tenant_id]);

    for (const w of wf.rows) {
      const to = w.trigger_config?.to_stage;
      if (!to) continue;

      // Only changes we have not already reacted to.
      const people = await platformQuery<any>(
        `SELECT DISTINCT h.person_id
           FROM person_stage_history h
           JOIN journey_stages js ON js.id = h.to_stage_id
           JOIN persons p ON p.id = h.person_id
          WHERE h.tenant_id = $1 AND js.key = $2
            AND h.changed_at > now() - interval '2 days'
            AND p.archived_at IS NULL AND NOT p.is_deceased
            AND NOT EXISTS (SELECT 1 FROM enrollments e
                             WHERE e.workflow_id = $3 AND e.person_id = h.person_id
                               AND e.enrolled_at > h.changed_at)`,
        [tenant_id, to, w.id]);

      for (const p of people.rows) {
        if (await enroll(tenant_id, w.id, w.version, p.person_id,
                         { to_stage: to })) total++;
      }
    }
  }
  return total;
}


// ---------------------------------------------------------------------------
// SCHEDULE — "every Monday at 9am, find everyone who X"
//
// A schedule trigger has no natural subject. "Monday morning" does not happen
// TO anybody. So it must carry a FILTER saying who it is about — and the
// filters are the SAME smart lists the Lists screen already runs, reused, not
// reinvented.
// ---------------------------------------------------------------------------
const FILTERS: Record<string, string> = {
  no_group:        `p.home_group_id IS NULL AND js.key NOT IN ('visitor','first_timer')`,
  never_attended:  `p.last_attended_at IS NULL`,
  first_timers:    `js.key IN ('visitor','first_timer')`,
  no_email:        `p.email IS NULL AND coalesce(p.phone, p.phone_2) IS NOT NULL`,
  unreachable:     `p.phone IS NULL AND p.phone_2 IS NULL AND p.email IS NULL`,
  workers:         `js.key IN ('worker','leader','pastor')`,
  everyone:        `true`,
};

/** A 5-field cron, matched against Africa/Lagos. Minute is ignored — the sweep
 *  runs hourly, and a church does not need a workflow that fires at 09:07. */
function cronDue(spec: string, now: Date): boolean {
  const [, hour, dom, mon, dow] = (spec ?? "0 9 * * 1").trim().split(/\s+/);
  const lagos = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
  const m = (f: string, v: number) => f === "*" || f.split(",").map(Number).includes(v);
  return m(hour, lagos.getHours())
      && m(dom,  lagos.getDate())
      && m(mon,  lagos.getMonth() + 1)
      && m(dow,  lagos.getDay());
}

export async function sweepSchedules() {
  const wf = await platformQuery<any>(
    `SELECT id, tenant_id, version, trigger_config, last_fired_at
       FROM workflows
      WHERE status = 'active' AND trigger_type = 'schedule' AND archived_at IS NULL`);

  const now = new Date();
  let total = 0;

  for (const w of wf.rows) {
    if (!cronDue(w.trigger_config?.cron, now)) continue;

    // Fire once per hour, not once per sweep. Without this, an hourly cron with
    // a one-minute sweeper enrolls everybody sixty times.
    if (w.last_fired_at &&
        Date.now() - new Date(w.last_fired_at).getTime() < 55 * 60_000) continue;

    const where = FILTERS[w.trigger_config?.filter ?? "everyone"] ?? "true";

    const people = await platformQuery<any>(
      `SELECT p.id FROM persons p
         LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
        WHERE p.tenant_id = $1 AND p.archived_at IS NULL AND NOT p.is_deceased
          AND (${where})`, [w.tenant_id]);

    for (const p of people.rows) {
      if (await enroll(w.tenant_id, w.id, w.version, p.id,
                       { schedule: w.trigger_config?.cron })) total++;
    }
    await platformQuery(
      `UPDATE workflows SET last_fired_at = now() WHERE id = $1`, [w.id]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// THRESHOLD — a number crosses a line
//
// A threshold is NOT about a person. "Attendance has dropped 20%" did not
// happen to anybody. But the enrollment model is person-centric, and forcing a
// church-level fact into it would produce nonsense.
//
// So a threshold trigger enrolls the person RESPONSIBLE — the cell leader whose
// cell has gone quiet, the pastor whose attendance is falling. The fact is about
// the church. The JOB is about a person.
// ---------------------------------------------------------------------------
export async function sweepThresholds() {
  const wf = await platformQuery<any>(
    `SELECT id, tenant_id, version, trigger_config FROM workflows
      WHERE status = 'active' AND trigger_type = 'threshold' AND archived_at IS NULL`);

  let total = 0;

  for (const w of wf.rows) {
    const metric = w.trigger_config?.metric ?? "cell_silent";

    if (metric === "cell_silent") {
      // A cell that has recorded no attendance for N weeks. Enroll its LEADER.
      const weeks = Number(w.trigger_config?.weeks ?? 2);
      const leaders = await platformQuery<any>(
        `SELECT DISTINCT g.leader_id AS id
           FROM groups g
          WHERE g.tenant_id = $1 AND g.leader_id IS NOT NULL
            AND g.archived_at IS NULL
            AND g.group_type IN ('cell','fellowship','house_fellowship')
            AND NOT EXISTS (
              SELECT 1 FROM attendance_sessions s
               WHERE s.group_id = g.id
                 AND s.session_date > CURRENT_DATE - ($2 * 7))`,
        [w.tenant_id, weeks]);

      for (const l of leaders.rows) {
        if (await enroll(w.tenant_id, w.id, w.version, l.id,
                         { metric, weeks })) total++;
      }
    }

    if (metric === "attendance_drop") {
      // Sunday attendance below N% of its own 8-week average. Enroll the owner.
      const pct = Number(w.trigger_config?.pct ?? 80);
      const r = await platformQuery<any>(
        `WITH recent AS (
           SELECT s.session_date,
                  (SELECT count(*) FROM attendance a WHERE a.session_id = s.id) AS n
             FROM attendance_sessions s
             JOIN services sv ON sv.id = s.service_id
            WHERE s.tenant_id = $1 AND sv.kind = 'sunday'
              AND s.session_date > CURRENT_DATE - 56
         )
         SELECT (SELECT sum(n) FROM recent WHERE session_date > CURRENT_DATE - 7) AS last_week,
                (SELECT avg(w.total) FROM (
                   SELECT sum(n) AS total FROM recent
                    GROUP BY date_trunc('week', session_date)) w) AS avg_week`,
        [w.tenant_id]);

      const last = Number(r.rows[0]?.last_week ?? 0);
      const avg  = Number(r.rows[0]?.avg_week ?? 0);

      if (avg > 0 && last > 0 && (last / avg) * 100 < pct) {
        const owner = await platformQuery<any>(
          `SELECT p.id FROM persons p
             JOIN journey_stages js ON js.id = p.journey_stage_id
            WHERE p.tenant_id = $1 AND js.key = 'pastor'
              AND p.archived_at IS NULL LIMIT 1`, [w.tenant_id]);
        if (owner.rows[0]) {
          if (await enroll(w.tenant_id, w.id, w.version, owner.rows[0].id,
                           { metric, last, avg, pct })) total++;
        }
      }
    }
  }
  return total;
}
