-- ============================================================================
-- 002 — PLATFORM: sessions, event outbox, files, billing
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Sessions (opaque tokens, hashed; bound to user+tenant)
-- Platform-scope: consulted BEFORE tenant context exists. No RLS; app role
-- touches it only through auth.ts.
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at); -- purge sweep

-- ----------------------------------------------------------------------------
-- Event outbox (transactional event bus)
-- Writers INSERT events in the SAME transaction as their data change; a relay
-- worker publishes to the queue and marks published_at. Exactly-once-ish with
-- consumer idempotency keys. This is the substrate the automation engine
-- consumes in Phase 2 — build it right now, cheap forever after.
-- ----------------------------------------------------------------------------
CREATE TABLE event_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  event_type   text NOT NULL,          -- 'visitor.registered','attendance.recorded',...
  entity_type  text NOT NULL,
  entity_id    uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX idx_outbox_unpublished ON event_outbox(id) WHERE published_at IS NULL;
CREATE INDEX idx_outbox_tenant_type ON event_outbox(tenant_id, event_type, occurred_at DESC);

ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox FORCE ROW LEVEL SECURITY;
-- Tenant code may write/read its own events; the relay uses a privileged role.
CREATE POLICY outbox_tenant ON event_outbox
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ----------------------------------------------------------------------------
-- Files (S3-compatible object storage; DB stores metadata + keys only)
-- ----------------------------------------------------------------------------
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key  text NOT NULL UNIQUE,   -- '<tenant_id>/<uuid>/<filename>' — tenant prefix mandatory
  filename     text NOT NULL,
  content_type text NOT NULL,
  byte_size    bigint NOT NULL,
  entity_type  text,                   -- optional attachment target
  entity_id    uuid,
  uploaded_by  uuid REFERENCES app_users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE INDEX idx_files_tenant ON files(tenant_id);
CREATE INDEX idx_files_tenant_entity ON files(tenant_id, entity_type, entity_id);
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
CREATE POLICY files_tenant ON files
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ----------------------------------------------------------------------------
-- BILLING
-- Model: plan tier (core|growth|ministry) × member band. Metering = ACTIVE
-- members (nightly snapshot). Band crossings bill at RENEWAL, not mid-term
-- (growth protection). Onboarding fee is a one-time invoice line.
-- Platform-scope tables (Hispren bills the tenant): no tenant RLS; guarded by
-- app-layer platform authz + read-own via explicit policies where useful.
-- ----------------------------------------------------------------------------

CREATE TABLE plan_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_tier   text NOT NULL CHECK (plan_tier IN ('core','growth','ministry')),
  member_band text NOT NULL CHECK (member_band IN
                ('b0_250','b251_750','b751_2000','b2001_5000','b5000_plus')),
  monthly_ngn numeric(14,2) NOT NULL,
  annual_ngn  numeric(14,2) NOT NULL,          -- ~2 months free
  onboarding_ngn numeric(14,2) NOT NULL,
  active_from date NOT NULL DEFAULT CURRENT_DATE,
  active_to   date,
  UNIQUE (plan_tier, member_band, active_from)
);

CREATE TABLE subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_tier     text NOT NULL,
  member_band   text NOT NULL,                 -- band LOCKED until renewal
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly','annual')),
  status        text NOT NULL DEFAULT 'trialing'
                CHECK (status IN ('trialing','active','past_due','paused','cancelled')),
  current_period_start date NOT NULL,
  current_period_end   date NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_sub_one_active_per_tenant ON subscriptions(tenant_id)
  WHERE status IN ('trialing','active','past_due');
CREATE TRIGGER trg_subs_updated BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Nightly active-member snapshot. "Active" = communicated-with in the last 90d
-- OR holds a member-app account. Definition lives in the metering job; the
-- snapshot is the auditable record the invoice references.
CREATE TABLE member_metering_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  active_members  int NOT NULL,
  total_persons   int NOT NULL,
  computed_band text NOT NULL,
  UNIQUE (tenant_id, snapshot_date)
);
CREATE INDEX idx_metering_tenant_date ON member_metering_snapshots(tenant_id, snapshot_date DESC);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        text NOT NULL UNIQUE,           -- HSP-2026-000123
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','open','paid','void','uncollectible')),
  currency      text NOT NULL DEFAULT 'NGN',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  due_at        timestamptz,
  paid_at       timestamptz,
  period_start  date,
  period_end    date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id, created_at DESC);
CREATE INDEX idx_invoices_open_due ON invoices(due_at) WHERE status = 'open'; -- dunning sweep

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN
                ('subscription','onboarding','sms_credits','whatsapp_credits',
                 'email_credits','ai_credits','adjustment')),
  description text NOT NULL,
  quantity    numeric(12,2) NOT NULL DEFAULT 1,
  unit_ngn    numeric(14,2) NOT NULL,
  amount_ngn  numeric(14,2) NOT NULL
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- Dunning state machine: open invoice past due → reminders → suspend.
-- NOTE: churches get grace + human contact before suspension. Suspension kills
-- every member's comms — treat as last resort, owner-approved in app.
CREATE TABLE dunning_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  step        text NOT NULL CHECK (step IN
                ('reminder_3d','reminder_7d','reminder_14d','final_notice','suspended')),
  executed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, step)
);

-- Credit wallets (prepaid; NEVER allow negative balance)
CREATE TABLE credit_wallets (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_type text NOT NULL CHECK (credit_type IN ('sms','whatsapp','email','ai')),
  balance     numeric(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, credit_type)
);
CREATE TABLE credit_ledger (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_type text NOT NULL,
  delta       numeric(14,2) NOT NULL,           -- +purchase / -consumption
  reason      text NOT NULL,                    -- 'purchase:inv_x','send:msg_y'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_ledger_tenant ON credit_ledger(tenant_id, created_at DESC);

-- Tenant may READ its own billing objects (billing page); writes are platform-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscriptions','member_metering_snapshots','invoices',
    'credit_wallets','credit_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_read ON %I FOR SELECT
        USING (tenant_id = current_tenant_id())
    $p$, t);
  END LOOP;
END $$;
-- invoice_lines has no tenant_id; readable via join under invoices policy in
-- app queries executed platform-side, or add tenant_id later if needed.

-- Seed launch pricing (anchoring hypotheses — validate with design partners)
INSERT INTO plan_prices (plan_tier, member_band, monthly_ngn, annual_ngn, onboarding_ngn) VALUES
 ('core','b0_250',      20000,  200000,  75000),
 ('core','b251_750',    45000,  450000, 150000),
 ('core','b751_2000',   90000,  900000, 350000),
 ('core','b2001_5000', 180000, 1800000, 650000),
 ('growth','b0_250',    40000,  400000,  75000),
 ('growth','b251_750',  90000,  900000, 150000),
 ('growth','b751_2000',180000, 1800000, 350000),
 ('growth','b2001_5000',360000,3600000, 650000),
 ('ministry','b251_750',190000,1900000, 150000),
 ('ministry','b751_2000',380000,3800000,350000),
 ('ministry','b2001_5000',760000,7600000,650000);

COMMIT;
