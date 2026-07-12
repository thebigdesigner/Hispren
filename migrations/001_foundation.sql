-- ============================================================================
-- HISPREN CHURCH OS — PHASE 0 FOUNDATION SCHEMA
-- Postgres 16+
--
-- SECURITY-CRITICAL FILE. Human line-by-line review required before running.
-- Invariants (see CLAUDE.md):
--   * every tenant table: tenant_id NOT NULL, indexed, RLS ENABLED + FORCED
--   * tenant resolved at edge, injected via: SET LOCAL app.tenant_id = '<uuid>'
--   * app connects as a NON-superuser role (hispren_app); RLS does not apply
--     to table owners/superusers, so migrations run as a separate role.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy name search / dup detection

-- ----------------------------------------------------------------------------
-- 0. Tenant context helper
-- ----------------------------------------------------------------------------
-- The edge resolves hostname -> tenant and the API sets, per transaction:
--     SET LOCAL app.tenant_id = '<uuid>';
-- current_tenant_id() returns NULL if unset -> RLS predicates fail closed.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Tenants & domains  (NOT tenant-scoped; guarded by app-layer authz only)
-- ----------------------------------------------------------------------------

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  subdomain      citext NOT NULL UNIQUE,            -- dominion.hispren.com
  timezone       text NOT NULL DEFAULT 'Africa/Lagos',
  locale         text NOT NULL DEFAULT 'en-NG',
  brand_color    text,                              -- optional accent override
  plan_tier      text NOT NULL DEFAULT 'core'
                 CHECK (plan_tier IN ('core','growth','ministry')),
  member_band    text NOT NULL DEFAULT 'b0_250'
                 CHECK (member_band IN
                   ('b0_250','b251_750','b751_2000','b2001_5000','b5000_plus')),
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','trial','suspended','churned')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Reserved subdomains (www, api, rccg, ...) enforced in app + seed table
CREATE TABLE reserved_subdomains (
  subdomain citext PRIMARY KEY
);
INSERT INTO reserved_subdomains VALUES
  ('www'),('app'),('api'),('admin'),('mail'),('portal'),('status'),
  ('help'),('docs'),('blog'),('staging'),('billing'),('hispren');

CREATE TABLE tenant_domains (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostname      citext NOT NULL UNIQUE,             -- portal.dominionchapel.org
  verified_at   timestamptz,                        -- TXT record verified
  cert_issued_at   timestamptz,
  cert_expires_at  timestamptz,                     -- monitor: alert 30/14/7 days
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tenant_domains_tenant ON tenant_domains(tenant_id);

-- ----------------------------------------------------------------------------
-- 2. Admin users & RBAC  (users are global; membership binds them to tenants)
-- ----------------------------------------------------------------------------

CREATE TABLE app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  phone         text,
  full_name     text NOT NULL,
  password_hash text,                               -- null if SSO-only later
  is_platform_admin boolean NOT NULL DEFAULT false, -- Hispren staff only
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_app_users_updated BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'staff'
              CHECK (role IN ('owner','admin','pastor','finance','staff','leader','readonly')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_memberships_tenant ON tenant_memberships(tenant_id);
CREATE INDEX idx_memberships_user   ON tenant_memberships(user_id);

-- ----------------------------------------------------------------------------
-- 3. Journey (lifecycle pipeline) — tenant-configurable stages
-- ----------------------------------------------------------------------------

CREATE TABLE journey_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,          -- 'visitor','first_timer','convert',...
  label       text NOT NULL,
  position    int  NOT NULL,
  is_billable_default boolean NOT NULL DEFAULT true, -- visitors usually not billed
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, position)
);
CREATE INDEX idx_journey_stages_tenant ON journey_stages(tenant_id);
-- Seed per-tenant on provisioning:
-- visitor(0,false) first_timer(1,false) convert(2) member(3) worker(4) leader(5) pastor(6)

-- ----------------------------------------------------------------------------
-- 4. Households & Persons
-- ----------------------------------------------------------------------------

CREATE TABLE households (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,                        -- "The Okafor Family"
  address     text,
  area        text,                                 -- neighbourhood, for cell assignment
  custom      jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_households_tenant ON households(tenant_id);
CREATE TRIGGER trg_households_updated BEFORE UPDATE ON households
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE persons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  household_id     uuid REFERENCES households(id) ON DELETE SET NULL,
  household_role   text CHECK (household_role IN
                     ('head','spouse','child','dependent','other')),
  first_name       text NOT NULL,
  last_name        text,
  gender           text CHECK (gender IN ('male','female')),
  date_of_birth    date,
  -- Birthday triggers scan these. to_char() is NOT immutable (depends on
  -- DateStyle) so it cannot back a generated column; EXTRACT is immutable.
  dob_month        smallint GENERATED ALWAYS AS
                     (EXTRACT(MONTH FROM date_of_birth)::smallint) STORED,
  dob_day          smallint GENERATED ALWAYS AS
                     (EXTRACT(DAY FROM date_of_birth)::smallint) STORED,
  phone            text,                             -- E.164 normalised in app
  email            citext,
  photo_url        text,
  address          text,
  area             text,
  marital_status   text CHECK (marital_status IN
                     ('single','married','widowed','divorced')),
  wedding_anniversary date,
  journey_stage_id uuid REFERENCES journey_stages(id),
  member_code      text,                             -- printed/QR identity
  qr_token         uuid NOT NULL DEFAULT gen_random_uuid(), -- rotatable scan token
  joined_at        date,
  baptized_at      date,
  is_deceased      boolean NOT NULL DEFAULT false,   -- HARD comm suppression
  is_billable      boolean NOT NULL DEFAULT false,   -- derived nightly (active-member metering)
  last_activity_at timestamptz,                      -- maintained by activity writers
  custom           jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_persons_tenant          ON persons(tenant_id);
CREATE INDEX idx_persons_tenant_stage    ON persons(tenant_id, journey_stage_id);
CREATE INDEX idx_persons_tenant_household ON persons(tenant_id, household_id);
CREATE INDEX idx_persons_tenant_dob      ON persons(tenant_id, dob_month, dob_day);
CREATE INDEX idx_persons_tenant_billable ON persons(tenant_id) WHERE is_billable;
CREATE INDEX idx_persons_name_trgm       ON persons
  USING gin ((first_name || ' ' || coalesce(last_name,'')) gin_trgm_ops); -- dup detection
CREATE UNIQUE INDEX idx_persons_qr       ON persons(qr_token);
CREATE UNIQUE INDEX idx_persons_member_code ON persons(tenant_id, member_code)
  WHERE member_code IS NOT NULL;
CREATE TRIGGER trg_persons_updated BEFORE UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stage history (powers conversion analytics + journey automation triggers)
CREATE TABLE person_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  from_stage_id uuid REFERENCES journey_stages(id),
  to_stage_id   uuid NOT NULL REFERENCES journey_stages(id),
  changed_by    uuid REFERENCES app_users(id),
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stage_history_tenant_person ON person_stage_history(tenant_id, person_id);

-- Milestones (baptism, dedication, wedding, ordination, ...) — automation triggers
CREATE TABLE person_milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  kind        text NOT NULL,          -- 'baptism','dedication','wedding','ordination',...
  occurred_on date NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_milestones_tenant_person ON person_milestones(tenant_id, person_id);
CREATE INDEX idx_milestones_tenant_kind_date ON person_milestones(tenant_id, kind, occurred_on);

-- ----------------------------------------------------------------------------
-- 5. Groups — ONE recursive table for branch → zone → department → unit → cell
-- ----------------------------------------------------------------------------

CREATE TABLE groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES groups(id) ON DELETE RESTRICT,
  group_type  text NOT NULL CHECK (group_type IN
                ('branch','zone','department','unit','team','cell')),
  name        text NOT NULL,
  leader_id   uuid REFERENCES persons(id) ON DELETE SET NULL,
  area        text,                                  -- cells: geographic anchor
  meets_on    text,                                  -- 'wednesday', ...
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX idx_groups_tenant        ON groups(tenant_id);
CREATE INDEX idx_groups_tenant_parent ON groups(tenant_id, parent_id);
CREATE INDEX idx_groups_tenant_type   ON groups(tenant_id, group_type);
CREATE TRIGGER trg_groups_updated BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cycle guard: reject any parent chain that loops back (depth-capped walk)
CREATE OR REPLACE FUNCTION groups_no_cycles() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cur uuid := NEW.parent_id; depth int := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN RAISE EXCEPTION 'group hierarchy cycle detected'; END IF;
    SELECT parent_id INTO cur FROM groups WHERE id = cur;
    depth := depth + 1;
    IF depth > 50 THEN RAISE EXCEPTION 'group hierarchy too deep'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_groups_no_cycles BEFORE INSERT OR UPDATE OF parent_id ON groups
  FOR EACH ROW EXECUTE FUNCTION groups_no_cycles();

CREATE TABLE group_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member'
              CHECK (role IN ('member','worker','assistant_leader','leader')),
  joined_at   date NOT NULL DEFAULT CURRENT_DATE,
  left_at     date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, group_id, person_id)
);
CREATE INDEX idx_gm_tenant_group  ON group_memberships(tenant_id, group_id)
  WHERE left_at IS NULL;
CREATE INDEX idx_gm_tenant_person ON group_memberships(tenant_id, person_id)
  WHERE left_at IS NULL;

-- ----------------------------------------------------------------------------
-- 6. Care Requests
-- ----------------------------------------------------------------------------

CREATE TABLE care_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id    uuid REFERENCES persons(id) ON DELETE SET NULL, -- may be anonymous
  kind         text NOT NULL CHECK (kind IN
                 ('prayer','counselling','hospital_visit','bereavement','benevolence','other')),
  summary      text NOT NULL,
  detail       text,
  is_confidential boolean NOT NULL DEFAULT false,   -- restricts visibility to pastors
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','assigned','in_progress','resolved','closed')),
  assigned_to  uuid REFERENCES app_users(id) ON DELETE SET NULL,
  due_at       timestamptz,                          -- SLA
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_care_tenant_status ON care_requests(tenant_id, status);
CREATE INDEX idx_care_tenant_assignee ON care_requests(tenant_id, assigned_to)
  WHERE status IN ('open','assigned','in_progress');
CREATE TRIGGER trg_care_updated BEFORE UPDATE ON care_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. Tasks (generic assignment object; follow-ups are tasks)
-- ----------------------------------------------------------------------------

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        text NOT NULL,
  detail       text,
  kind         text NOT NULL DEFAULT 'general'
               CHECK (kind IN ('general','follow_up','care','duty','finance_approval')),
  subject_type text CHECK (subject_type IN ('person','household','group','care_request')),
  subject_id   uuid,                                 -- validated in app layer
  assigned_to_user   uuid REFERENCES app_users(id) ON DELETE SET NULL,
  assigned_to_person uuid REFERENCES persons(id)  ON DELETE SET NULL, -- e.g. cell leader
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','done','cancelled')),
  due_at       timestamptz,
  completed_at timestamptz,
  source       text NOT NULL DEFAULT 'manual'        -- 'manual' | 'automation:<workflow_id>'
               ,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_tenant_status ON tasks(tenant_id, status);
CREATE INDEX idx_tasks_tenant_open_due ON tasks(tenant_id, due_at)
  WHERE status IN ('open','in_progress');            -- escalation sweeps
CREATE INDEX idx_tasks_tenant_subject ON tasks(tenant_id, subject_type, subject_id);
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 8. Custom properties engine
--    Definitions per tenant + JSONB `custom` column on person/household/group.
-- ----------------------------------------------------------------------------

CREATE TABLE custom_property_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity       text NOT NULL CHECK (entity IN ('person','household','group')),
  key          text NOT NULL,                        -- snake_case, immutable
  label        text NOT NULL,
  field_type   text NOT NULL CHECK (field_type IN
                 ('text','number','date','boolean','select','multiselect','phone','email')),
  options      jsonb,                                -- for select/multiselect
  is_required  boolean NOT NULL DEFAULT false,
  position     int NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key)
);
CREATE INDEX idx_cpd_tenant_entity ON custom_property_definitions(tenant_id, entity);
-- Values live in the entity's `custom` jsonb column, keyed by definition key.
-- App layer validates against definitions on write. Add GIN index per hot key
-- pattern later if dynamic-segment filters need it:
--   CREATE INDEX ... ON persons USING gin (custom jsonb_path_ops);

-- ----------------------------------------------------------------------------
-- 9. Segments — static (explicit) + dynamic (stored filter)
-- ----------------------------------------------------------------------------

CREATE TABLE segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('static','dynamic')),
  entity       text NOT NULL DEFAULT 'person' CHECK (entity IN ('person','household')),
  -- Dynamic: a filter AST the app compiles to SQL. Versioned shape:
  -- { "version":1, "op":"and", "conditions":[
  --     {"field":"journey_stage.key","cmp":"eq","value":"member"},
  --     {"field":"group_membership.group_type","cmp":"eq","value":"cell","negate":true} ] }
  filter       jsonb,
  is_suppression boolean NOT NULL DEFAULT false,     -- usable as never-contact list
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ( (kind = 'dynamic') = (filter IS NOT NULL) )
);
CREATE INDEX idx_segments_tenant ON segments(tenant_id);
CREATE TRIGGER trg_segments_updated BEFORE UPDATE ON segments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE segment_members (                        -- static segments only
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id  uuid NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, person_id)
);
CREATE INDEX idx_segment_members_tenant ON segment_members(tenant_id);
CREATE INDEX idx_segment_members_person ON segment_members(tenant_id, person_id);

-- ----------------------------------------------------------------------------
-- 10. Consent — current state + append-only audit (NDPR)
-- ----------------------------------------------------------------------------

CREATE TABLE consents (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('sms','email','whatsapp','push','call')),
  status      text NOT NULL DEFAULT 'granted'
              CHECK (status IN ('granted','revoked','unset')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, person_id, channel)
);
CREATE INDEX idx_consents_person ON consents(tenant_id, person_id);

CREATE TABLE consent_events (                         -- append-only; never update
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  action      text NOT NULL CHECK (action IN ('granted','revoked')),
  source      text NOT NULL,      -- 'registration_form','stop_reply','admin','import','member_app'
  actor_user  uuid REFERENCES app_users(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_events_person ON consent_events(tenant_id, person_id);

-- ----------------------------------------------------------------------------
-- 11. Audit log (platform-wide write trail)
-- ----------------------------------------------------------------------------

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  actor_user  uuid,
  action      text NOT NULL,          -- 'person.create','consent.revoke',...
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  ip          inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log(tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_tenant_entity ON audit_log(tenant_id, entity_type, entity_id);

-- ============================================================================
-- 12. ROW-LEVEL SECURITY
--     ENABLE + FORCE on every tenant-scoped table. Fail-closed: if
--     app.tenant_id is unset, current_tenant_id() IS NULL and nothing matches.
-- ============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'journey_stages','households','persons','person_stage_history',
    'person_milestones','groups','group_memberships','care_requests','tasks',
    'custom_property_definitions','segments','segment_members',
    'consents','consent_events','audit_log','tenant_memberships','tenant_domains'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',  t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
  END LOOP;
END $$;

-- tenants table itself: app role may only see the current tenant's row
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant_id());

-- app_users is global (login precedes tenant context); guard in app layer.
-- Platform-admin surfaces use a separate privileged role, never hispren_app.

-- ----------------------------------------------------------------------------
-- 13. Application role
-- ----------------------------------------------------------------------------
-- Run migrations as the owner role; the API must connect as hispren_app.
-- RLS DOES NOT APPLY to superusers or table owners — connecting the API as
-- the owner silently disables every policy above.

-- CREATE ROLE hispren_app LOGIN PASSWORD '...';
-- GRANT USAGE ON SCHEMA public TO hispren_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hispren_app;
-- REVOKE ALL ON reserved_subdomains FROM hispren_app;
-- GRANT SELECT ON reserved_subdomains TO hispren_app;

COMMIT;

-- ============================================================================
-- POST-DEPLOY CHECKLIST (do not skip)
-- [ ] API connects as hispren_app, NOT the migration owner
-- [ ] Every request wraps queries in a transaction that runs
--       SET LOCAL app.tenant_id = '<uuid-from-edge>'
-- [ ] Two-tenant adversarial suite green before first endpoint ships
-- [ ] Seed journey_stages on tenant provisioning
-- [ ] Nightly job derives persons.is_billable (active-member metering)
-- ============================================================================
