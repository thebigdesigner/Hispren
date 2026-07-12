-- ============================================================================
-- 007 — NOTIFICATIONS
--
-- THE TWO ROUTES. Every Nigerian gateway works this way.
--
--   generic  Promotional. Does NOT deliver to DND-registered numbers at all.
--            MTN blocks it entirely between 8pm and 8am WAT.
--            A Saturday-evening service reminder simply never arrives.
--
--   dnd      Transactional. Reaches DND numbers. No time restriction.
--            Must be activated by the provider; sender ID whitelisted for it.
--
-- DND registration is widespread in Nigeria. On the generic route a large share
-- of a congregation receives NOTHING, silently, and the pastor blames Hispren.
-- The DND route is not an optimisation. It is the product.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Sender IDs — a church sends as "DOMINION", not as a phone number.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sender_ids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_id    text NOT NULL,                    -- max 11 chars, alphanumeric
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','active','blocked','rejected')),
  dnd_approved boolean NOT NULL DEFAULT false,   -- whitelisted for the DND route?
  use_case     text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz,
  is_default   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_sender_tenant ON sender_ids(tenant_id);

-- ----------------------------------------------------------------------------
-- Templates. Merge fields: {{first_name}} {{church}} {{service}}
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  channel     text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','whatsapp','email')),
  subject     text,
  body        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON message_templates(tenant_id);

-- ----------------------------------------------------------------------------
-- Campaigns — one bulk send
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  channel      text NOT NULL DEFAULT 'sms',
  template_id  uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','queued','sending','sent','cancelled','failed')),
  recipients   int NOT NULL DEFAULT 0,
  suppressed   int NOT NULL DEFAULT 0,
  queued       int NOT NULL DEFAULT 0,
  delivered    int NOT NULL DEFAULT 0,
  failed       int NOT NULL DEFAULT 0,
  units        int NOT NULL DEFAULT 0,           -- SMS pages, not messages
  cost         numeric(14,2) NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES app_users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Messages. Every single one — INCLUDING the ones we refused to send.
--
-- A suppressed message is not a silent no-op. It is a row with a reason.
-- When a pastor says "she never got it", the answer is one query away:
-- she opted out on 14 March, or she is on DND and you used the generic route.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id     uuid REFERENCES persons(id) ON DELETE SET NULL,
  channel       text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','whatsapp','email','push')),
  to_address    text NOT NULL,
  sender_id     text,
  body          text NOT NULL,
  units         int NOT NULL DEFAULT 1,
  encoding      text NOT NULL DEFAULT 'GSM7' CHECK (encoding IN ('GSM7','UCS2')),
  route         text CHECK (route IN ('generic','dnd','whatsapp','email')),
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','delivered','failed','suppressed')),
  suppressed_by text,
  provider      text,
  provider_id   text,
  error         text,
  cost          numeric(10,4) NOT NULL DEFAULT 0,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  delivered_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_msg_tenant_time ON messages(tenant_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_person      ON messages(tenant_id, person_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_campaign    ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_msg_queued      ON messages(tenant_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_msg_provider_id ON messages(provider_id) WHERE provider_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Suppression list — STOP replies, hard bounces, dead numbers.
-- Checked at the SEND layer. An admin must not be able to compose around it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  address     text NOT NULL,
  channel     text NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address, channel)
);

-- ----------------------------------------------------------------------------
-- DND status, cached. Checking costs an API call — a 3,000-member church would
-- burn 3,000 calls per campaign. DND status changes rarely; a stale week is fine.
-- Deliberately NOT tenant-scoped: a phone number's DND status is a fact about
-- the number, not about the church.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dnd_status (
  phone       text PRIMARY KEY,
  is_dnd      boolean NOT NULL,
  network     text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON dnd_status TO hispren_app, hispren_platform;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sender_ids','message_templates','campaigns','messages','suppressions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
    -- the worker drains the send queue across every tenant
    EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', t);
    EXECUTE format($p$
      CREATE POLICY platform_access ON %I FOR ALL TO hispren_platform
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON sender_ids, message_templates, campaigns, messages, suppressions
  TO hispren_app, hispren_platform;

-- ----------------------------------------------------------------------------
-- THE WALLET.
--
-- Sending a campaign must DEBIT the church's SMS credit — and that happens
-- inside the tenant's own transaction, as hispren_app.
--
-- But if hispren_app can UPDATE credit_wallets, it can also set its own balance
-- to a million and send free SMS forever. A bug, or a compromised dependency,
-- becomes unlimited spending on someone else's gateway account.
--
-- So: hispren_app may DECREASE the balance. Any attempt to INCREASE it is
-- refused by the database. Top-ups are a PLATFORM operation — they follow money
-- actually arriving, and they run as hispren_platform.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_debit ON credit_wallets;
CREATE POLICY tenant_debit ON credit_wallets FOR UPDATE TO hispren_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT UPDATE ON credit_wallets TO hispren_app;
GRANT INSERT ON credit_ledger TO hispren_app;

DROP POLICY IF EXISTS tenant_ledger_write ON credit_ledger;
CREATE POLICY tenant_ledger_write ON credit_ledger FOR INSERT TO hispren_app
  WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION wallet_no_self_topup() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.balance > OLD.balance AND current_user = 'hispren_app' THEN
    RAISE EXCEPTION 'the app role may spend credit, never add it. Top-ups are a platform operation.';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_wallet_no_topup ON credit_wallets;
CREATE TRIGGER trg_wallet_no_topup BEFORE UPDATE ON credit_wallets
  FOR EACH ROW EXECUTE FUNCTION wallet_no_self_topup();

-- ----------------------------------------------------------------------------
-- Frequency cap: how many messages has this person had recently, across EVERY
-- campaign and every automation? One indexed lookup.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messages_in_window(p uuid, days int DEFAULT 7)
RETURNS int LANGUAGE sql STABLE AS $fn$
  SELECT count(*)::int FROM messages
   WHERE person_id = p
     AND status IN ('queued','sent','delivered')
     AND queued_at > now() - (days * interval '1 day')
$fn$;
GRANT EXECUTE ON FUNCTION messages_in_window(uuid, int) TO hispren_app, hispren_platform;

-- ----------------------------------------------------------------------------
-- Seed the templates a church actually needs.
--
-- Written in GSM-7 ONLY. No curly quotes, no em dashes, no diacritics.
-- One smart apostrophe pasted from Word turns a 160-character message into a
-- 70-character one and triples what the church pays. Every one of these is
-- deliberately plain.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_templates(t uuid) RETURNS void
LANGUAGE sql AS $fn$
  INSERT INTO message_templates (tenant_id, key, name, channel, body, is_system) VALUES
   (t,'welcome_first_timer','Welcome a first timer','sms',
    'Hello {{first_name}}, thank you for worshipping with us at {{church}} today. We would love to see you again. God bless you.', true),
   (t,'follow_up','Follow up','sms',
    'Hello {{first_name}}, this is {{church}}. We have not seen you in a while and wanted to check on you. Is all well?', true),
   (t,'birthday','Birthday','sms',
    'Happy birthday {{first_name}}! Everyone at {{church}} is celebrating with you today. May this new year be full of grace.', true),
   (t,'service_reminder','Service reminder','sms',
    'Hello {{first_name}}, a reminder that {{service}} holds tomorrow. We look forward to worshipping with you at {{church}}.', true),
   (t,'missed_you','We missed you','sms',
    'Hello {{first_name}}, we missed you at {{church}} on Sunday. You are in our prayers. Please tell us if there is any way we can help.', true)
  ON CONFLICT (tenant_id, key) DO NOTHING;
$fn$;

COMMIT;
