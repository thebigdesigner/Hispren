-- ============================================================================
-- 005 — ATTENDANCE
--
-- The hard constraint: 3,000 members through the door in 30 minutes is
-- 1.7 scans per SECOND, sustained, on Nigerian mobile data. A round-trip to
-- the database per scan means the gate backs up and the ushers go back to
-- paper by week three.
--
-- So the scanner validates against a CACHED ROSTER on the device, queues the
-- scan locally, and syncs later. This schema is built for that: scans arrive
-- LATE, OUT OF ORDER, and SOMETIMES TWICE.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Services. Nigerian churches run 3+ on a Sunday plus midweek. Attendance is
-- ALWAYS per-service. A single "attendance: 1,284" number tells a pastor
-- nothing — 412/586/286 tells him the 2nd service is carrying the church.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES groups(id) ON DELETE CASCADE,  -- branch/cell it belongs to
  name         text NOT NULL,                 -- '1st Service', 'Ogba House Fellowship'
  kind         text NOT NULL DEFAULT 'sunday'
               CHECK (kind IN ('sunday','midweek','cell','special','crusade')),
  day_of_week  int CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Sunday
  start_time   time,
  position     int NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_tenant ON services(tenant_id, position);

-- ----------------------------------------------------------------------------
-- A session is one service on one date. Opened by an usher, closed after.
-- Attendance hangs off the session, never off a bare date.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id    uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  group_id      uuid REFERENCES groups(id) ON DELETE SET NULL,
  session_date  date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by     uuid REFERENCES app_users(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  -- headcount for people who were never registered — churches always have some
  unregistered_count int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, service_id, session_date)
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_date
  ON attendance_sessions(tenant_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_open
  ON attendance_sessions(tenant_id) WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- Attendance. Designed for a scanner that is OFFLINE.
--
--   recorded_at  = when the person was actually at the gate (device clock)
--   synced_at    = when we found out about it (server clock)
--
-- Those are different, sometimes by hours. Reports must use recorded_at.
--
-- UNIQUE (session_id, person_id) makes a double-scan a NO-OP, not a duplicate.
-- Ushers WILL scan the same person twice. Members WILL hand their phone to a
-- friend. The database absorbs it silently.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  method       text NOT NULL DEFAULT 'qr' CHECK (method IN ('qr','manual','import','self')),
  recorded_at  timestamptz NOT NULL,          -- device clock — the truth about WHEN
  synced_at    timestamptz NOT NULL DEFAULT now(),
  device_id    text,                          -- which gate, which usher's phone
  recorded_by  uuid REFERENCES app_users(id),
  UNIQUE (session_id, person_id)              -- idempotent. Scan twice, counted once.
);
CREATE INDEX IF NOT EXISTS idx_att_tenant_session ON attendance(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_att_tenant_person  ON attendance(tenant_id, person_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_recorded       ON attendance(tenant_id, recorded_at DESC);

-- ----------------------------------------------------------------------------
-- Denormalised attendance state on persons.
--
-- Every absence trigger in Phase 2 ("missed 3 Sundays") reads this. Computing
-- it by scanning the attendance table per member per night will not survive a
-- 20,000-member church. Maintained by trigger, read in O(1).
-- ----------------------------------------------------------------------------
ALTER TABLE persons ADD COLUMN IF NOT EXISTS last_attended_at   timestamptz;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS attendance_streak  int NOT NULL DEFAULT 0;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS missed_streak      int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_persons_last_attended
  ON persons(tenant_id, last_attended_at NULLS FIRST);

CREATE OR REPLACE FUNCTION att_touch_person() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE persons
     SET last_attended_at = GREATEST(coalesce(last_attended_at, NEW.recorded_at), NEW.recorded_at),
         last_activity_at = GREATEST(coalesce(last_activity_at, NEW.recorded_at), NEW.recorded_at),
         missed_streak    = 0,
         attendance_streak = attendance_streak + 1
   WHERE id = NEW.person_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_att_touch ON attendance;
CREATE TRIGGER trg_att_touch AFTER INSERT ON attendance
  FOR EACH ROW EXECUTE FUNCTION att_touch_person();

-- ----------------------------------------------------------------------------
-- Roster snapshot: what the scanner downloads before going offline.
--
-- Deliberately minimal — a 20,000-member roster must fit in a phone's
-- IndexedDB and validate a scan in under a millisecond. No addresses, no
-- genotype, nothing an usher has no business seeing on a gate device.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roster_snapshot()
RETURNS TABLE (qr_token uuid, person_id uuid, name text, service text)
LANGUAGE sql STABLE AS $$
  SELECT p.qr_token, p.id,
         trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         p.usual_service
    FROM persons p
   WHERE p.archived_at IS NULL AND NOT p.is_deceased
$$;
GRANT EXECUTE ON FUNCTION roster_snapshot() TO hispren_app;

-- ----------------------------------------------------------------------------
-- Per-service attendance for a date. This is the dashboard query.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_by_service(d date)
RETURNS TABLE (service text, present int, first_timers int, unregistered int)
LANGUAGE sql STABLE AS $$
  SELECT s.name,
         count(a.id)::int,
         count(a.id) FILTER (WHERE js.key IN ('visitor','first_timer'))::int,
         max(sess.unregistered_count)::int
    FROM services s
    LEFT JOIN attendance_sessions sess
           ON sess.service_id = s.id AND sess.session_date = d
    LEFT JOIN attendance a ON a.session_id = sess.id
    LEFT JOIN persons p    ON p.id = a.person_id
    LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
   WHERE s.archived_at IS NULL
   GROUP BY s.id, s.name, s.position
   ORDER BY s.position
$$;
GRANT EXECUTE ON FUNCTION attendance_by_service(date) TO hispren_app;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['services','attendance_sessions','attendance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON services, attendance_sessions, attendance TO hispren_app;

-- ----------------------------------------------------------------------------
-- Seed the standard Nigerian Sunday for a tenant
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_services(t uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO services (tenant_id, name, kind, day_of_week, start_time, position) VALUES
    (t, '1st Service', 'sunday',  0, '07:00', 1),
    (t, '2nd Service', 'sunday',  0, '09:00', 2),
    (t, '3rd Service', 'sunday',  0, '11:30', 3),
    (t, 'Midweek',     'midweek', 3, '18:00', 4)
  ON CONFLICT DO NOTHING;
$$;

COMMIT;
