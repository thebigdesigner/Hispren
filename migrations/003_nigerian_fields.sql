-- ============================================================================
-- 003 — NIGERIAN CHURCH FIELDS  (denomination-neutral, Pentecostal-first)
--
-- Every field here is one that essentially EVERY Nigerian church collects,
-- regardless of denomination. Nothing here is Catholic-specific.
-- Denominational fields (born again date, Holy Ghost baptism, sacraments)
-- go in custom_property_definitions and person_milestones — per tenant.
--
-- SECURITY-CRITICAL: introduces special-category health data. Read section 3.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- 1. PERSON — names, origin, contact, work
-- ----------------------------------------------------------------------------

-- Nigerian names are three-part: Name / Surname / Other Name.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS middle_name text;

-- TWO phone numbers. Not redundancy — multi-SIM. MTN + Airtel, because one
-- network does not reach everywhere. The notification service MUST fall back
-- to phone_2 when phone_1 fails. This is a delivery-rate feature.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS phone_2 text;

-- Origin is ANCESTRAL and distinct from residence. A man born and living in
-- Lagos may have Anambra as his state of origin. Both LGAs get collected and
-- they are usually different. No US church product has these fields.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS country         text NOT NULL DEFAULT 'Nigeria';
ALTER TABLE persons ADD COLUMN IF NOT EXISTS state_of_origin text;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS lga_of_origin   text;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS lga             text;   -- residential
ALTER TABLE persons ADD COLUMN IF NOT EXISTS town            text;   -- residential

ALTER TABLE persons ADD COLUMN IF NOT EXISTS occupation      text;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS workplace       text;   -- work OR school

-- Office held: "Assistant Secretary", "Choir Leader", "Cell Coordinator"
ALTER TABLE persons ADD COLUMN IF NOT EXISTS post_held       text;

-- Which branch/station/campus this person actually attends.
-- Points into `groups`, which is recursive.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS home_group_id uuid
  REFERENCES groups(id) ON DELETE SET NULL;

-- Which Sunday service they attend. Nigerian churches run 3+ services and
-- attendance MUST be per-service, not per-day.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS usual_service text;

-- Where the record came from. Churches will use paper for years yet — the
-- admin needs to know what to trust and what to verify.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','paper_form','bulk_import','self_service','qr_signup','visitor_card'));
ALTER TABLE persons ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES app_users(id);

CREATE INDEX IF NOT EXISTS idx_persons_tenant_home_group ON persons(tenant_id, home_group_id);
CREATE INDEX IF NOT EXISTS idx_persons_tenant_origin     ON persons(tenant_id, state_of_origin);
CREATE INDEX IF NOT EXISTS idx_persons_tenant_service    ON persons(tenant_id, usual_service);

-- Search + duplicate detection across the full three-part name
CREATE INDEX IF NOT EXISTS idx_persons_fullname_trgm ON persons
  USING gin ((coalesce(first_name,'') || ' ' || coalesce(middle_name,'') || ' '
              || coalesce(last_name,'')) gin_trgm_ops);

-- Phone lookup must cover BOTH numbers: inbound "STOP", caller ID, dedupe
CREATE INDEX IF NOT EXISTS idx_persons_phone1 ON persons(tenant_id, phone)   WHERE phone   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_persons_phone2 ON persons(tenant_id, phone_2) WHERE phone_2 IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. GROUPS — one recursive table, every denomination's hierarchy
--
--   Pentecostal:  headquarters -> region -> zone -> area -> branch -> cell
--   Catholic:     diocese -> parish -> station
--   Independent:  church -> department -> unit
--
-- All of it is parent_id. This is why the recursive table exists.
-- ----------------------------------------------------------------------------
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_group_type_check;
ALTER TABLE groups ADD CONSTRAINT groups_group_type_check CHECK (group_type IN (
  'headquarters','region','province','zone','area','branch','campus',
  'department','unit','team',
  'cell','fellowship','house_fellowship','society',
  'diocese','parish','station'
));

-- ----------------------------------------------------------------------------
-- 3. SPECIAL-CATEGORY HEALTH DATA — blood group + genotype
--
-- WHY IT EXISTS:
--   Nigerian churches counsel couples before marriage, and genotype
--   compatibility is a standard part of that. AS x AS carries a 1-in-4 risk of
--   a child with sickle cell disease. Pentecostal churches run this counselling
--   MORE intensively than Catholic ones, not less. A pastor who marries an
--   AS couple without checking has failed them.
--
--   No US church platform has this field. It is not a nice-to-have here.
--
-- WHY IT IS NOT A COLUMN ON `persons`:
--   It is health data — special-category under NDPR. It must not sit in the
--   same row as the phone number every usher can read.
--
-- RULES (app layer enforces; the DB cannot see your RBAC roles):
--   * Only roles 'pastor' and 'admin' may read this table.
--   * Every read writes an audit_log row. No exceptions.
--   * OPT-IN per tenant (tenants.collects_health_data). Default OFF.
--   * Consent is recorded here explicitly. It is never implied by the row.
-- ----------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS collects_health_data boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS person_health (
  person_id     uuid PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  blood_group   text CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  genotype      text CHECK (genotype IN ('AA','AS','SS','AC','SC','CC')),
  consent_given boolean NOT NULL DEFAULT false,
  consent_at    timestamptz,
  recorded_by   uuid REFERENCES app_users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT consent_given OR consent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_person_health_tenant ON person_health(tenant_id);

ALTER TABLE person_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_health FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON person_health;
CREATE POLICY tenant_isolation ON person_health
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Deliberately NO platform_access policy: hispren_platform runs billing and the
-- event relay. It has no business reading anyone's genotype, ever.

-- ----------------------------------------------------------------------------
-- 4. MILESTONES — spiritual history, whatever the denomination calls it
--
--   Pentecostal:  new_birth, water_baptism, holy_ghost_baptism,
--                 foundation_school, child_dedication, wedding, ordination
--   Catholic:     baptism, holy_communion, confirmation, wedding
--
-- `kind` is free text, so any denomination fits. What every one of them has in
-- common: a DATE, a CHURCH, and an officiating MINISTER. Often the date is
-- unknown (a baptism 40 years ago in a village church) — so it is nullable.
-- ----------------------------------------------------------------------------
ALTER TABLE person_milestones ADD COLUMN IF NOT EXISTS church   text;
ALTER TABLE person_milestones ADD COLUMN IF NOT EXISTS minister text;
ALTER TABLE person_milestones ALTER COLUMN occurred_on DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- 5. Nigerian reference data — shared, read-only
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ng_states (code text PRIMARY KEY, name text NOT NULL);
INSERT INTO ng_states (code, name) VALUES
 ('AB','Abia'),('AD','Adamawa'),('AK','Akwa Ibom'),('AN','Anambra'),('BA','Bauchi'),
 ('BY','Bayelsa'),('BE','Benue'),('BO','Borno'),('CR','Cross River'),('DE','Delta'),
 ('EB','Ebonyi'),('ED','Edo'),('EK','Ekiti'),('EN','Enugu'),('GO','Gombe'),
 ('IM','Imo'),('JI','Jigawa'),('KD','Kaduna'),('KN','Kano'),('KT','Katsina'),
 ('KE','Kebbi'),('KO','Kogi'),('KW','Kwara'),('LA','Lagos'),('NA','Nasarawa'),
 ('NI','Niger'),('OG','Ogun'),('ON','Ondo'),('OS','Osun'),('OY','Oyo'),
 ('PL','Plateau'),('RI','Rivers'),('SO','Sokoto'),('TA','Taraba'),('YO','Yobe'),
 ('ZA','Zamfara'),('FC','FCT Abuja')
ON CONFLICT (code) DO NOTHING;
GRANT SELECT ON ng_states TO hispren_app, hispren_platform;

-- ----------------------------------------------------------------------------
-- 6. Default Pentecostal custom properties, seeded per tenant on provisioning.
--    THIS is where denomination lives. Not in the core schema.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_pentecostal_properties(t uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO custom_property_definitions (tenant_id, entity, key, label, field_type, options, position)
  VALUES
   (t,'person','born_again','Are you born again?','boolean',NULL,1),
   (t,'person','new_birth_date','Date of new birth','date',NULL,2),
   (t,'person','water_baptism','Water baptised?','boolean',NULL,3),
   (t,'person','holy_ghost_baptism','Baptised in the Holy Spirit?','boolean',NULL,4),
   (t,'person','foundation_school','Foundation school completed?','boolean',NULL,5),
   (t,'person','how_did_you_hear','How did you hear about us?','select',
      '["Friend or family","Crusade or outreach","Social media","Radio or TV","Walked in","Other"]'::jsonb,6),
   (t,'person','prev_church','Previous church','text',NULL,7)
  ON CONFLICT (tenant_id, entity, key) DO NOTHING;
$$;

COMMIT;

-- ============================================================================
-- THE LINE THIS MIGRATION DRAWS
--
-- CORE SCHEMA  = what every Nigerian church collects:
--   three-part names, two phones, state of origin + LGA, occupation,
--   genotype, recursive hierarchy, per-service attendance.
--
-- CUSTOM PROPS = what a denomination collects:
--   born again, Holy Ghost baptism, foundation school  (Pentecostal)
--   baptismal name, confirmation name, sacraments      (Catholic)
--
-- Getting this line right is the whole reason the custom-properties engine
-- exists. Put a denominational field in the core schema and you have built a
-- product for one denomination.
-- ============================================================================
