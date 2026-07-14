-- ============================================================================
-- 014 — PHASE 3: CELLS AND THE MEMBER APP
--
-- ----------------------------------------------------------------------------
-- CELLS
--
-- The recursive `groups` table already IS the cell structure. What is missing is
-- the thing a Nigerian church actually runs on: the WEEKLY REPORT.
--
-- A cell leader meets fifteen people in his sitting room on a Wednesday. On
-- Thursday he sends a WhatsApp message to his zonal leader saying how many came.
-- That message is the entire management system of most Nigerian churches, and it
-- lives in a chat thread nobody can query.
--
-- Two things follow from that, and both are in this migration:
--
--   1. The report must be ONE TAP. If it takes more than fifteen seconds on a
--      phone with bad signal, he will keep using WhatsApp and this table stays
--      empty forever.
--
--   2. A cell that STOPS reporting is the signal. Not the numbers — the silence.
--      A leader who has gone quiet for a fortnight has usually stopped meeting,
--      and nobody upstream knows.
--
-- ----------------------------------------------------------------------------
-- MULTIPLICATION
--
-- A cell that grows past ~15 stops being a cell. It becomes a small
-- congregation, the quiet people go silent, and it stops multiplying. Tracking
-- which cell came from which — and how long it took — is how a church knows
-- whether its cell system is actually working or just accumulating.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Cells get the fields a cell actually has
-- ----------------------------------------------------------------------------
ALTER TABLE groups ADD COLUMN IF NOT EXISTS assistant_leader_id uuid REFERENCES persons(id);
ALTER TABLE groups ADD COLUMN IF NOT EXISTS capacity int DEFAULT 15;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS multiplied_from uuid REFERENCES groups(id);
ALTER TABLE groups ADD COLUMN IF NOT EXISTS multiplied_at date;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS launched_on date;

-- ----------------------------------------------------------------------------
-- THE WEEKLY CELL REPORT.
--
-- One row per cell per week. This is the thing that replaces a WhatsApp message
-- to the zonal leader — and it has to be FASTER than that message, or it will
-- not be used.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  week_of       date NOT NULL,           -- the Monday of that week
  met           boolean NOT NULL DEFAULT true,
  did_not_meet_reason text,

  present       int NOT NULL DEFAULT 0,
  visitors      int NOT NULL DEFAULT 0,
  new_converts  int NOT NULL DEFAULT 0,
  offering      numeric(14,2),

  -- The one thing a zonal leader actually reads.
  note          text,

  reported_by   uuid REFERENCES persons(id),
  reported_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (group_id, week_of)             -- one report per cell per week
);
CREATE INDEX IF NOT EXISTS idx_cellrep_tenant ON cell_reports(tenant_id, week_of DESC);
CREATE INDEX IF NOT EXISTS idx_cellrep_group  ON cell_reports(group_id, week_of DESC);

-- ----------------------------------------------------------------------------
-- Who attended, if the leader bothers to say. Optional — because DEMANDING it
-- is how you get zero reports instead of a headcount.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell_attendance (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES cell_reports(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, person_id)
);

-- ============================================================================
-- THE MEMBER APP
--
-- A member does not have a password, and asking a Nigerian congregation to
-- invent and remember one is how you get 40 downloads and zero logins.
--
-- THEIR QR TOKEN IS THEIR LOGIN.
--
-- persons.qr_token is already a rotatable secret UUID, already on their phone,
-- already printed on their member card, and already the thing an usher scans at
-- the gate. Reusing it means:
--
--   - No password to forget.
--   - No SMS OTP to pay for.
--   - Losing your phone is fixed by rotating the token — which the church can
--     already do from the member's record, and which already invalidates the
--     old card.
--
-- The token grants READ access to their OWN record and the church directory.
-- It cannot see giving, cannot see anybody's genotype, and cannot change
-- anything except a prayer request and their own contact details.
-- ============================================================================
CREATE TABLE IF NOT EXISTS announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  pinned      boolean NOT NULL DEFAULT false,
  publish_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  created_by  uuid REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ann_tenant ON announcements(tenant_id, publish_at DESC);

CREATE TABLE IF NOT EXISTS sermons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  preacher    text,
  preached_on date NOT NULL DEFAULT CURRENT_DATE,
  scripture   text,
  summary     text,
  audio_url   text,
  video_url   text,
  notes_url   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sermon_tenant ON sermons(tenant_id, preached_on DESC);

-- ----------------------------------------------------------------------------
-- PRAYER REQUESTS, from the member's own phone.
--
-- is_private = only the pastoral team see it. That default matters: a member
-- asking for prayer about a marriage, a diagnosis, or a debt must not find it
-- on a noticeboard.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prayer_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id   uuid REFERENCES persons(id) ON DELETE SET NULL,
  body        text NOT NULL,
  is_private  boolean NOT NULL DEFAULT true,
  is_anonymous boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','praying','answered','closed')),
  answered_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prayer_tenant ON prayer_requests(tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- What a member has chosen to let the directory show. Default: almost nothing.
--
-- A church directory that publishes everyone's home address by default is a
-- burglary list. Opt IN, not out.
-- ----------------------------------------------------------------------------
ALTER TABLE persons ADD COLUMN IF NOT EXISTS show_in_directory boolean NOT NULL DEFAULT false;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS directory_phone   boolean NOT NULL DEFAULT false;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS directory_email   boolean NOT NULL DEFAULT false;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS push_token        text;

-- ----------------------------------------------------------------------------
-- REPORTS
-- ----------------------------------------------------------------------------

/** Every cell, and whether it has gone quiet. The zonal leader's whole screen. */
CREATE OR REPLACE FUNCTION cell_health()
RETURNS TABLE (
  id uuid, name text, leader text, members int, capacity int,
  last_report date, weeks_silent int, avg_present numeric, trend text
)
LANGUAGE sql STABLE AS $fn$
  SELECT g.id, g.name,
         trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')),
         (SELECT count(*)::int FROM persons p
           WHERE p.home_group_id = g.id AND p.archived_at IS NULL),
         g.capacity,
         (SELECT max(r.week_of) FROM cell_reports r WHERE r.group_id = g.id),
         -- THE SIGNAL IS THE SILENCE. Not the numbers.
         CASE WHEN (SELECT max(r.week_of) FROM cell_reports r WHERE r.group_id = g.id) IS NULL
              THEN NULL
              ELSE floor((CURRENT_DATE
                   - (SELECT max(r.week_of) FROM cell_reports r WHERE r.group_id = g.id)) / 7)::int
         END,
         (SELECT round(avg(r.present), 1) FROM cell_reports r
           WHERE r.group_id = g.id AND r.week_of > CURRENT_DATE - 56 AND r.met),
         CASE
           WHEN (SELECT avg(r.present) FROM cell_reports r
                  WHERE r.group_id = g.id AND r.week_of > CURRENT_DATE - 28 AND r.met)
              > (SELECT avg(r.present) FROM cell_reports r
                  WHERE r.group_id = g.id AND r.week_of BETWEEN CURRENT_DATE - 56
                                                            AND CURRENT_DATE - 28 AND r.met)
           THEN 'growing'
           WHEN (SELECT avg(r.present) FROM cell_reports r
                  WHERE r.group_id = g.id AND r.week_of > CURRENT_DATE - 28 AND r.met)
              < (SELECT avg(r.present) FROM cell_reports r
                  WHERE r.group_id = g.id AND r.week_of BETWEEN CURRENT_DATE - 56
                                                            AND CURRENT_DATE - 28 AND r.met)
           THEN 'shrinking'
           ELSE 'steady'
         END
    FROM groups g
    LEFT JOIN persons l ON l.id = g.leader_id
   WHERE g.archived_at IS NULL
     AND g.group_type IN ('cell','fellowship','house_fellowship')
   ORDER BY
     -- the ones who have gone quiet, first
     (SELECT max(r.week_of) FROM cell_reports r WHERE r.group_id = g.id) NULLS FIRST,
     g.name
$fn$;
GRANT EXECUTE ON FUNCTION cell_health() TO hispren_app;

/**
 * Multiplication. Which cell came from which, and how long it took.
 *
 * A cell that grows past its capacity and never multiplies is not a success. It
 * has become a small congregation, and the quiet people in it have gone silent.
 */
CREATE OR REPLACE FUNCTION multiplication_tree()
RETURNS TABLE (
  id uuid, name text, parent_cell text, launched date, months_to_multiply int,
  members int, has_multiplied boolean, over_capacity boolean
)
LANGUAGE sql STABLE AS $fn$
  SELECT g.id, g.name, pg.name,
         g.launched_on,
         -- date - date returns an INTEGER (days) in Postgres, not an interval.
         CASE WHEN g.multiplied_at IS NOT NULL AND g.launched_on IS NOT NULL
              THEN ((g.multiplied_at - g.launched_on) / 30)::int
         END,
         (SELECT count(*)::int FROM persons p
           WHERE p.home_group_id = g.id AND p.archived_at IS NULL),
         EXISTS (SELECT 1 FROM groups c WHERE c.multiplied_from = g.id),
         (SELECT count(*) FROM persons p
           WHERE p.home_group_id = g.id AND p.archived_at IS NULL) > coalesce(g.capacity, 15)
    FROM groups g
    LEFT JOIN groups pg ON pg.id = g.multiplied_from
   WHERE g.archived_at IS NULL
     AND g.group_type IN ('cell','fellowship','house_fellowship')
   ORDER BY g.launched_on NULLS LAST
$fn$;
GRANT EXECUTE ON FUNCTION multiplication_tree() TO hispren_app;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cell_reports','cell_attendance','announcements',
                           'sermons','prayer_requests'] LOOP
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
GRANT SELECT, INSERT, UPDATE, DELETE
  ON cell_reports, cell_attendance, announcements, sermons, prayer_requests
  TO hispren_app;

COMMIT;
