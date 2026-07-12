-- ============================================================================
-- 004 — BULK IMPORT + DUPLICATE MERGE
--
-- Churches arrive with paper registers, a decade of Excel, and three WhatsApp
-- groups. The import path is not a nice-to-have — it IS the onboarding fee.
-- 20-40 hours of human labour per church, and this is what compresses it.
--
-- And the moment you allow bulk import + QR self-signup + manual registration,
-- you have the same person three times. Guaranteed. Dedupe is core.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Import batches — every import is reversible until committed, and auditable
-- forever after. A church that loses 2,000 records to a bad import never
-- trusts you again.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  status        text NOT NULL DEFAULT 'previewing'
                CHECK (status IN ('previewing','committed','failed','reverted')),
  column_map    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- csv header -> person field
  total_rows    int  NOT NULL DEFAULT 0,
  valid_rows    int  NOT NULL DEFAULT 0,
  error_rows    int  NOT NULL DEFAULT 0,
  dupe_rows     int  NOT NULL DEFAULT 0,
  imported_rows int  NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{row, field, message}]
  created_by    uuid REFERENCES app_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant
  ON import_batches(tenant_id, created_at DESC);

-- Which persons came from which batch. Makes a bad import revertible.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS import_batch_id uuid
  REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_persons_import_batch
  ON persons(tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Duplicate review queue
--
-- NEVER auto-merge. "Chinedu Okafor" and "Chinedu Okonkwo" are different people
-- and merging them destroys two records. A human confirms. Always.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_a     uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  person_b     uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  score        numeric(4,3) NOT NULL,            -- 0.000 - 1.000
  reasons      jsonb NOT NULL DEFAULT '[]'::jsonb, -- ["exact phone","name 0.91"]
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','merged','dismissed')),
  resolved_by  uuid REFERENCES app_users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (person_a <> person_b)
);
-- One pair, once — in either direction. (least,greatest) makes the pair canonical.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dupe_pair ON duplicate_candidates
  (tenant_id, least(person_a, person_b), greatest(person_a, person_b));
CREATE INDEX IF NOT EXISTS idx_dupe_open ON duplicate_candidates(tenant_id, score DESC)
  WHERE status = 'open';

-- Merge audit. A merge destroys a record — it must be explainable a year later.
CREATE TABLE IF NOT EXISTS merge_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kept_id     uuid NOT NULL,
  merged_id   uuid NOT NULL,
  merged_snapshot jsonb NOT NULL,   -- the full losing record, verbatim
  merged_by   uuid REFERENCES app_users(id),
  merged_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_merge_log_tenant ON merge_log(tenant_id, merged_at DESC);

-- ----------------------------------------------------------------------------
-- Duplicate detection
--
-- Signals, in order of trust:
--   1. Exact phone match (either number against either number) -> near-certain
--   2. Exact email match                                       -> near-certain
--   3. Fuzzy full-name similarity + same DOB                   -> strong
--   4. Fuzzy full-name similarity alone                        -> weak, review
--
-- Nigerian names repeat heavily. "Chinedu Okafor" alone is NOT a duplicate
-- signal — there are hundreds in a 3,000-member church. Name similarity only
-- counts when something else corroborates it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_duplicates(p_id uuid)
RETURNS TABLE (candidate_id uuid, score numeric, reasons jsonb)
LANGUAGE sql STABLE AS $fn$
  WITH me AS (
    SELECT id, phone, phone_2, email, date_of_birth,
           lower(coalesce(first_name,'')||' '||coalesce(middle_name,'')||' '||coalesce(last_name,'')) AS fullname
    FROM persons WHERE id = p_id
  ),
  scored AS (
    SELECT p.id,
      (p.phone IS NOT NULL AND p.phone IN (me.phone, me.phone_2))
        OR (p.phone_2 IS NOT NULL AND p.phone_2 IN (me.phone, me.phone_2)) AS phone_hit,
      (p.email IS NOT NULL AND p.email = me.email) AS email_hit,
      (p.date_of_birth IS NOT NULL AND p.date_of_birth = me.date_of_birth) AS dob_hit,
      similarity(lower(coalesce(p.first_name,'')||' '||coalesce(p.middle_name,'')||' '
                 ||coalesce(p.last_name,'')), me.fullname) AS name_sim
    FROM persons p CROSS JOIN me
    WHERE p.id <> me.id AND p.archived_at IS NULL
  )
  SELECT s.id,
    GREATEST(
      CASE WHEN s.phone_hit THEN 0.95 ELSE 0 END,
      CASE WHEN s.email_hit THEN 0.90 ELSE 0 END,
      CASE WHEN s.dob_hit AND s.name_sim > 0.45 THEN 0.85 ELSE 0 END,
      CASE WHEN s.name_sim > 0.80 THEN 0.60 ELSE 0 END
    )::numeric(4,3),
    (SELECT coalesce(jsonb_agg(r),'[]'::jsonb) FROM (
        SELECT 'same phone number' r WHERE s.phone_hit
        UNION ALL SELECT 'same email'         WHERE s.email_hit
        UNION ALL SELECT 'same date of birth' WHERE s.dob_hit
        UNION ALL SELECT 'similar name ('||round(s.name_sim::numeric,2)||')' WHERE s.name_sim > 0.45
     ) x)
  FROM scored s
$fn$;

GRANT EXECUTE ON FUNCTION find_duplicates(uuid) TO hispren_app;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batches','duplicate_candidates','merge_log'] LOOP
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
  ON import_batches, duplicate_candidates, merge_log TO hispren_app;

COMMIT;
