-- ============================================================================
-- 006 — EVENTS, GROUP METADATA, SERVICE EXTENSIONS
--
-- A church calendar has two shapes and they must not be forced into one table
-- badly:
--   RECURRING  — 1st/2nd/3rd Sunday service, Wednesday midweek. day_of_week.
--   ONE-OFF    — a crusade, a conference, a wedding, a burial. A DATE.
--
-- Both take attendance identically, so both live in `services` and hang off the
-- same attendance_sessions. `event_date` is what distinguishes them: NULL means
-- it repeats, a date means it happens once.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Services become the whole calendar
-- ----------------------------------------------------------------------------
ALTER TABLE services ADD COLUMN IF NOT EXISTS event_date   date;      -- NULL = recurring
ALTER TABLE services ADD COLUMN IF NOT EXISTS end_time     time;
ALTER TABLE services ADD COLUMN IF NOT EXISTS location     text;
ALTER TABLE services ADD COLUMN IF NOT EXISTS description  text;
ALTER TABLE services ADD COLUMN IF NOT EXISTS colour       text NOT NULL DEFAULT '#4338CA';
ALTER TABLE services ADD COLUMN IF NOT EXISTS expected     int;       -- capacity planning

ALTER TABLE services DROP CONSTRAINT IF EXISTS services_kind_check;
ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN (
  'sunday','midweek','cell','prayer','vigil',          -- recurring
  'special','crusade','conference','convention',        -- one-off
  'wedding','burial','dedication','training'
));

-- A recurring service needs a weekday. A one-off needs a date. Not both, not neither.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_when_check;
ALTER TABLE services ADD CONSTRAINT services_when_check
  CHECK (day_of_week IS NOT NULL OR event_date IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_services_event_date
  ON services(tenant_id, event_date) WHERE event_date IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Groups get the metadata a cell leader actually needs
-- ----------------------------------------------------------------------------
ALTER TABLE groups ADD COLUMN IF NOT EXISTS description  text;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS meets_at     time;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS meets_where  text;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS colour       text NOT NULL DEFAULT '#4338CA';

-- ----------------------------------------------------------------------------
-- The hierarchy, flattened. Used by every group screen and every export.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION group_tree()
RETURNS TABLE (
  id uuid, parent_id uuid, name text, group_type text, depth int, path text,
  leader_id uuid, leader_name text, direct_members int, total_members int,
  colour text, meets_on text, meets_at time, meets_where text
)
LANGUAGE sql STABLE AS $fn$
  WITH RECURSIVE t AS (
    SELECT g.id, g.parent_id, g.name, g.group_type, 0 AS depth,
           g.name::text AS path, g.leader_id, g.colour, g.meets_on, g.meets_at, g.meets_where
      FROM groups g WHERE g.parent_id IS NULL AND g.archived_at IS NULL
    UNION ALL
    SELECT g.id, g.parent_id, g.name, g.group_type, t.depth + 1,
           t.path || ' / ' || g.name, g.leader_id, g.colour, g.meets_on, g.meets_at, g.meets_where
      FROM groups g JOIN t ON g.parent_id = t.id WHERE g.archived_at IS NULL
  ),
  -- every group plus all of its descendants, so a branch can report its
  -- whole zone's headcount, not just the people pinned directly to it
  subtree AS (
    SELECT a.id AS root, b.id AS node
      FROM t a JOIN t b ON b.path = a.path OR b.path LIKE a.path || ' / %'
  )
  SELECT t.id, t.parent_id, t.name, t.group_type, t.depth, t.path,
         t.leader_id,
         trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')),
         (SELECT count(*)::int FROM persons p
           WHERE p.home_group_id = t.id AND p.archived_at IS NULL),
         (SELECT count(*)::int FROM persons p
           WHERE p.home_group_id IN (SELECT node FROM subtree WHERE root = t.id)
             AND p.archived_at IS NULL),
         t.colour, t.meets_on, t.meets_at, t.meets_where
    FROM t LEFT JOIN persons l ON l.id = t.leader_id
   ORDER BY t.path
$fn$;
GRANT EXECUTE ON FUNCTION group_tree() TO hispren_app;

-- ----------------------------------------------------------------------------
-- Attendance trend — the report a pastor actually reads
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_trend(weeks int DEFAULT 12)
RETURNS TABLE (session_date date, service text, present int, first_timers int, unregistered int)
LANGUAGE sql STABLE AS $fn$
  SELECT s.session_date, sv.name,
         (SELECT count(*)::int FROM attendance a WHERE a.session_id = s.id),
         (SELECT count(*)::int FROM attendance a
            JOIN persons p ON p.id = a.person_id
            JOIN journey_stages j ON j.id = p.journey_stage_id
           WHERE a.session_id = s.id AND j.key IN ('visitor','first_timer')),
         s.unregistered_count
    FROM attendance_sessions s JOIN services sv ON sv.id = s.service_id
   WHERE s.session_date > CURRENT_DATE - (weeks * 7)
   ORDER BY s.session_date, sv.position
$fn$;
GRANT EXECUTE ON FUNCTION attendance_trend(int) TO hispren_app;

-- ----------------------------------------------------------------------------
-- Growth: new registrations by month, and the conversion funnel
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_by_month(months int DEFAULT 12)
RETURNS TABLE (month date, registered int, converted int)
LANGUAGE sql STABLE AS $fn$
  SELECT date_trunc('month', p.created_at)::date,
         count(*)::int,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM person_stage_history h
             JOIN journey_stages j ON j.id = h.to_stage_id
            WHERE h.person_id = p.id AND j.key IN ('convert','member')))::int
    FROM persons p
   WHERE p.created_at > CURRENT_DATE - (months * 31)
     AND p.archived_at IS NULL
   GROUP BY 1 ORDER BY 1
$fn$;
GRANT EXECUTE ON FUNCTION growth_by_month(int) TO hispren_app;

CREATE OR REPLACE FUNCTION funnel()
RETURNS TABLE (stage text, label text, pos int, people int)
LANGUAGE sql STABLE AS $fn$
  SELECT js.key, js.label, js.position,
         (SELECT count(*)::int FROM persons p
           WHERE p.journey_stage_id = js.id AND p.archived_at IS NULL)
    FROM journey_stages js ORDER BY js.position
$fn$;
GRANT EXECUTE ON FUNCTION funnel() TO hispren_app;

-- ----------------------------------------------------------------------------
-- At risk: attended before, but not lately. Phase 2's automation reads this.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION at_risk(weeks int DEFAULT 3)
RETURNS TABLE (id uuid, name text, phone text, group_name text,
               last_attended timestamptz, weeks_away int)
LANGUAGE sql STABLE AS $fn$
  SELECT p.id,
         trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         coalesce(p.phone, p.phone_2),
         g.name,
         p.last_attended_at,
         (extract(epoch FROM (now() - p.last_attended_at)) / 604800)::int
    FROM persons p
    LEFT JOIN groups g ON g.id = p.home_group_id
    LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
   WHERE p.archived_at IS NULL
     AND NOT p.is_deceased
     AND p.last_attended_at IS NOT NULL              -- they DID come once
     AND p.last_attended_at < now() - (weeks * interval '7 days')
     AND js.key NOT IN ('visitor','first_timer')     -- a visitor is not "at risk"
   ORDER BY p.last_attended_at
$fn$;
GRANT EXECUTE ON FUNCTION at_risk(int) TO hispren_app;

COMMIT;
