-- ============================================================================
-- 013 — THE AUTOMATION ENGINE
--
-- Everything Hispren has built so far EMITS events into event_outbox, and
-- nothing has ever listened. This is the listener.
--
-- ----------------------------------------------------------------------------
-- THE ONE THING THAT IS GENUINELY HARD
--
-- An ABSENCE IS NOT AN EVENT.
--
-- "Chinedu has not come for three weeks" means NOTHING HAPPENED. There is no
-- message on the bus, because nobody did anything. Every other trigger in this
-- system is a reaction to something. This one is a reaction to the absence of
-- something, and you cannot subscribe to silence.
--
-- So it must be SWEPT for. And you cannot sweep by scanning the attendance
-- table per member per night — a 20,000-member church would be doing twenty
-- thousand range scans every evening to ask a question whose answer changed for
-- about nine people.
--
-- Hence person_activity_summary: one row per person, refreshed nightly, holding
-- the answers the sweeps need. It is the price of admission for the single most
-- valuable feature in the product — the church noticing that somebody has
-- quietly stopped coming.
--
-- ----------------------------------------------------------------------------
-- THE PRINCIPLE
--
-- The ENGINE decides WHEN. A human — or, later, an LLM — decides WHAT TO SAY.
-- Never the reverse. A birthday is a WHERE clause and a date. Routing it
-- through a language model would mean paying tokens for a database query and
-- introducing hallucination into a feature that must never fail.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- WORKFLOWS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  recipe      text,                       -- which recipe it came from, if any

  -- WHAT STARTS IT
  trigger_type text NOT NULL CHECK (trigger_type IN (
    'event',           -- something happened          (member.registered)
    'property_change', -- a field changed             (stage: first_timer -> member)
    'date',            -- a date field is N days away (birthday, joined + 30d)
    'absence',         -- NOTHING happened for N days (the hard one)
    'schedule',        -- cron                        (every Monday 09:00)
    'threshold'        -- a count crossed a line      (attendance below 80%)
  )),
  trigger_config jsonb NOT NULL DEFAULT '{}',

  -- A DRAFT NEVER FIRES. That is the whole point of a draft: a church admin
  -- must be able to build something that would text 1,832 people and NOT have
  -- it go out while she is still thinking about it.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),

  -- Editing a live workflow must not corrupt the people already halfway through
  -- it. An enrollment remembers the version it started on, and finishes on that
  -- version. Changing the message somebody is due to receive tomorrow, after
  -- they were enrolled yesterday, is not an edit — it is a different workflow.
  version int NOT NULL DEFAULT 1,

  -- ENROLLMENT RULES
  allow_reenrollment  boolean NOT NULL DEFAULT false,
  reenroll_after_days int,                     -- and not before this many days
  max_per_person      int,                     -- ever, in total

  -- SAFETY. Defaults are the safe ones, deliberately.
  respect_quiet_hours boolean NOT NULL DEFAULT true,
  respect_freq_cap    boolean NOT NULL DEFAULT true,

  stats_enrolled  int NOT NULL DEFAULT 0,
  stats_completed int NOT NULL DEFAULT 0,
  last_fired_at   timestamptz,

  created_by  uuid REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_wf_tenant ON workflows(tenant_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wf_active ON workflows(trigger_type)
  WHERE status = 'active' AND archived_at IS NULL;

-- ----------------------------------------------------------------------------
-- STEPS — an ordered list. No graph, no canvas, no arrows.
--
-- A church administrator is a volunteer, not an automation engineer. A
-- node-graph builder with branching arrows is a beautiful thing that will be
-- used exactly once, by you, in a demo.
--
-- A LIST of steps, each with an optional delay and an optional condition, does
-- everything a church actually needs and can be understood by a human being in
-- fifteen seconds.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position    int NOT NULL,

  action_type text NOT NULL CHECK (action_type IN (
    'send_message',   -- through the FULL suppression layer. Always.
    'create_task',    -- give a HUMAN a job
    'notify_leader',  -- tell their cell leader, not them
    'change_stage',
    'add_to_list',
    'add_to_group',
    'wait'            -- a pure delay
  )),
  action_config jsonb NOT NULL DEFAULT '{}',

  -- Wait this long BEFORE running this step. This is what makes a workflow a
  -- workflow rather than a trigger: "welcome them now, and if nobody has called
  -- in 72 hours, tell the pastor."
  delay_minutes int NOT NULL DEFAULT 0,

  -- Only run if... e.g. {"field":"stage_key","op":"eq","value":"first_timer"}
  condition jsonb,

  UNIQUE (workflow_id, position)
);
CREATE INDEX IF NOT EXISTS idx_step_wf ON workflow_steps(workflow_id, position);

-- ----------------------------------------------------------------------------
-- ENROLLMENTS — one person's journey through one workflow.
--
-- wake_at is the whole runner. The sweeper asks one question, once a minute:
-- "which enrollments are due?" It is an index scan, and it is the only thing
-- standing between this design and a cron job per workflow per church.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrollments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  wf_version  int NOT NULL,               -- finish on the version you started on
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled','failed')),
  current_step int NOT NULL DEFAULT 0,

  -- When the runner should look at this again. NULL = never (done).
  wake_at timestamptz,

  context jsonb NOT NULL DEFAULT '{}',     -- data carried from the trigger
  test_mode boolean NOT NULL DEFAULT false,

  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_reason text
);
-- THE SWEEP. Everything the runner does starts here.
CREATE INDEX IF NOT EXISTS idx_enr_due ON enrollments(wake_at)
  WHERE status = 'active' AND wake_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enr_person ON enrollments(tenant_id, person_id);
CREATE INDEX IF NOT EXISTS idx_enr_wf ON enrollments(workflow_id, status);

-- IDEMPOTENCY. A person cannot be in the same workflow twice at once.
--
-- Without this, an event that fires twice — a retried webhook, a double-clicked
-- button, a relay that redelivers — enrolls them twice, and they get the welcome
-- message twice. The database refuses.
CREATE UNIQUE INDEX IF NOT EXISTS uq_enr_active
  ON enrollments(workflow_id, person_id)
  WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- EXECUTIONS — every step that ran, and every step we REFUSED to run.
--
-- A skipped step is not a silent no-op. It is a row, with a reason. When a
-- pastor asks "why did she never get the welcome message?", the answer is one
-- query away: she had opted out, on the 14th of March.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS executions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step_id       uuid REFERENCES workflow_steps(id) ON DELETE SET NULL,
  position      int NOT NULL,
  action_type   text NOT NULL,

  status text NOT NULL CHECK (status IN ('done','skipped','failed')),
  skipped_reason text,                    -- consent | frequency_cap | quiet_hours
                                          -- | deceased | condition | test_mode
  result jsonb,
  error  text,
  attempts int NOT NULL DEFAULT 1,
  ran_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exec_enr ON executions(enrollment_id, position);
CREATE INDEX IF NOT EXISTS idx_exec_tenant ON executions(tenant_id, ran_at DESC);

-- ============================================================================
-- person_activity_summary
--
-- ONE ROW PER PERSON. Refreshed nightly. This is what absence triggers scan.
--
-- Without it, "who has not come for three weeks?" is a correlated subquery
-- across the whole attendance table, per member, per night. With it, it is a
-- single indexed scan of one integer column.
--
-- This table is the price of admission for the most valuable feature in the
-- product: the church noticing that somebody has quietly stopped coming.
-- ============================================================================
CREATE TABLE IF NOT EXISTS person_activity_summary (
  person_id  uuid PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  last_attended_at   timestamptz,
  weeks_absent       int,          -- NULL = never attended (NOT the same as absent)
  attendances_90d    int NOT NULL DEFAULT 0,
  attendance_streak  int NOT NULL DEFAULT 0,

  last_gave_at       timestamptz,
  gifts_90d          int NOT NULL DEFAULT 0,
  total_given_90d    numeric(14,2) NOT NULL DEFAULT 0,

  last_contacted_at  timestamptz,
  messages_30d       int NOT NULL DEFAULT 0,

  refreshed_at timestamptz NOT NULL DEFAULT now()
);
-- the absence sweep
CREATE INDEX IF NOT EXISTS idx_pas_absent
  ON person_activity_summary(tenant_id, weeks_absent)
  WHERE weeks_absent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pas_tenant ON person_activity_summary(tenant_id);

/**
 * Rebuild it. Nightly, for one tenant.
 *
 * weeks_absent is NULL for somebody who has NEVER attended. That distinction is
 * the feature: a visitor who came once and never returned is not "absent for 40
 * weeks" — they were never ours. Chasing them with a "we miss you" text is how
 * a church looks like a machine.
 */
CREATE OR REPLACE FUNCTION refresh_activity_summary(t uuid)
RETURNS int LANGUAGE plpgsql AS $fn$
DECLARE n int;
BEGIN
  INSERT INTO person_activity_summary AS s (
    person_id, tenant_id, last_attended_at, weeks_absent, attendances_90d,
    attendance_streak, last_gave_at, gifts_90d, total_given_90d,
    last_contacted_at, messages_30d, refreshed_at)
  SELECT
    p.id, p.tenant_id,
    p.last_attended_at,
    -- NULL if they never came. Otherwise, whole weeks since.
    CASE WHEN p.last_attended_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM (now() - p.last_attended_at)) / 604800)::int
    END,
    (SELECT count(*)::int FROM attendance a
      WHERE a.person_id = p.id AND a.recorded_at > now() - interval '90 days'),
    p.attendance_streak,
    (SELECT max(c.given_on)::timestamptz FROM contributions c WHERE c.person_id = p.id),
    (SELECT count(*)::int FROM contributions c
      WHERE c.person_id = p.id AND c.given_on > CURRENT_DATE - 90),
    coalesce((SELECT sum(c.amount) FROM contributions c
      WHERE c.person_id = p.id AND c.given_on > CURRENT_DATE - 90), 0),
    (SELECT max(m.sent_at) FROM messages m
      WHERE m.person_id = p.id AND m.status IN ('sent','delivered','sent_by_hand')),
    (SELECT count(*)::int FROM messages m
      WHERE m.person_id = p.id AND m.queued_at > now() - interval '30 days'
        AND m.status IN ('sent','delivered','sent_by_hand')),
    now()
  FROM persons p
  WHERE p.tenant_id = t AND p.archived_at IS NULL AND NOT p.is_deceased
  ON CONFLICT (person_id) DO UPDATE SET
    last_attended_at  = EXCLUDED.last_attended_at,
    weeks_absent      = EXCLUDED.weeks_absent,
    attendances_90d   = EXCLUDED.attendances_90d,
    attendance_streak = EXCLUDED.attendance_streak,
    last_gave_at      = EXCLUDED.last_gave_at,
    gifts_90d         = EXCLUDED.gifts_90d,
    total_given_90d   = EXCLUDED.total_given_90d,
    last_contacted_at = EXCLUDED.last_contacted_at,
    messages_30d      = EXCLUDED.messages_30d,
    refreshed_at      = now();

  GET DIAGNOSTICS n = ROW_COUNT;

  -- Somebody archived or deceased must fall out of every sweep, immediately.
  DELETE FROM person_activity_summary s
   WHERE s.tenant_id = t
     AND NOT EXISTS (SELECT 1 FROM persons p
                      WHERE p.id = s.person_id
                        AND p.archived_at IS NULL AND NOT p.is_deceased);
  RETURN n;
END $fn$;
GRANT EXECUTE ON FUNCTION refresh_activity_summary(uuid) TO hispren_app, hispren_platform;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows','workflow_steps','enrollments','executions',
                           'person_activity_summary'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
    -- the runner sweeps across every tenant
    EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', t);
    EXECUTE format($p$
      CREATE POLICY platform_access ON %I FOR ALL TO hispren_platform
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workflows, workflow_steps, enrollments, executions, person_activity_summary
  TO hispren_app, hispren_platform;

COMMIT;
