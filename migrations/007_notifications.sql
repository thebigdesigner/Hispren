-- ============================================================================
-- 007 — NOTIFICATIONS, TASKS, CARE, SEGMENTS
--
-- This is the layer the whole product has been building toward. Everything in
-- it is shaped by three Nigerian realities:
--
--   1. 160 GSM-7 characters is one SMS. ONE non-GSM character (a curly quote
--      pasted from Word, a Yoruba diacritic) drops it to 70 and TRIPLES the
--      cost. The counter is not a nicety.
--   2. DND blocks promotional SMS. Church messages sit on the promotional /
--      transactional line. Get the route wrong and half a congregation never
--      hears from you, and the pastor blames the software.
--   3. Most people carry two SIMs. If phone 1 fails, try phone 2.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Templates. A message a church sends more than once.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('sms','email','whatsapp','push')),
  subject     text,                       -- email only
  body        text NOT NULL,              -- {{first_name}}, {{church}}, {{service}}
  kind        text NOT NULL DEFAULT 'custom'
              CHECK (kind IN ('custom','welcome','birthday','anniversary',
                              'service_reminder','missed_attendance','follow_up','receipt')),
  is_system   boolean NOT NULL DEFAULT false,   -- seeded defaults, editable
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON message_templates(tenant_id, kind);

-- ----------------------------------------------------------------------------
-- A message: one send, to many people.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('sms','email','whatsapp','push')),
  subject       text,
  body          text NOT NULL,
  template_id   uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  segment_id    uuid REFERENCES segments(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','queued','sending','sent','failed','cancelled')),
  -- what the composer computed BEFORE sending: units per message, total cost
  units_each    int  NOT NULL DEFAULT 1,
  encoding      text NOT NULL DEFAULT 'GSM-7' CHECK (encoding IN ('GSM-7','UCS-2')),
  total_targets int  NOT NULL DEFAULT 0,
  suppressed    int  NOT NULL DEFAULT 0,
  estimated_cost numeric(12,2) NOT NULL DEFAULT 0,
  sent_count    int  NOT NULL DEFAULT 0,
  failed_count  int  NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES app_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- One row per person per message. This is where delivery truth lives.
--
-- `suppressed_reason` is the important column. When a pastor asks "why didn't
-- Amaka get it?", this answers in one word: consent / dnd / deceased /
-- frequency_cap / quiet_hours / no_number / bounced.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  address       text,                     -- the number/email actually used
  used_fallback boolean NOT NULL DEFAULT false,   -- phone_2 because phone_1 failed
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','delivered','failed','suppressed')),
  suppressed_reason text CHECK (suppressed_reason IN
                ('consent','dnd','deceased','frequency_cap','quiet_hours',
                 'no_number','bounced','no_credit')),
  provider      text,
  provider_ref  text,                     -- for matching the delivery webhook
  units         int NOT NULL DEFAULT 1,
  error         text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  UNIQUE (message_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_recip_message ON message_recipients(message_id, status);
CREATE INDEX IF NOT EXISTS idx_recip_person  ON message_recipients(tenant_id, person_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_recip_ref     ON message_recipients(provider_ref)
  WHERE provider_ref IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Bounces / hard failures. A number that hard-bounces is suppressed until
-- someone verifies it at the gate. Otherwise you burn credits on it weekly.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  address     text NOT NULL,              -- +2348031234567 or an email
  channel     text NOT NULL,
  reason      text NOT NULL,              -- 'hard_bounce','stop_reply','dnd'
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address, channel)
);

-- ----------------------------------------------------------------------------
-- Per-tenant comms settings. Quiet hours and the frequency cap are the two
-- guardrails that stop a church texting a member at 3am, eleven times.
-- ----------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sender_id       text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS quiet_from      time NOT NULL DEFAULT '21:00';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS quiet_to        time NOT NULL DEFAULT '07:00';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS weekly_cap      int  NOT NULL DEFAULT 3;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sms_provider    text NOT NULL DEFAULT 'dry_run'
  CHECK (sms_provider IN ('dry_run','termii','africastalking'));

-- ----------------------------------------------------------------------------
-- FREQUENCY CAP — across ALL messages, not per campaign.
--
-- Without a global cap, three separate workflows each send "reasonably", and
-- a member gets eleven texts in a week and blocks the church's number.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messages_this_week(p uuid)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM message_recipients
   WHERE person_id = p AND status IN ('sent','delivered')
     AND sent_at > now() - interval '7 days'
$$;
GRANT EXECUTE ON FUNCTION messages_this_week(uuid) TO hispren_app;

-- ----------------------------------------------------------------------------
-- SEGMENTS — the dynamic evaluator.
--
-- A dynamic segment is a stored filter, evaluated on read. It is never a raw
-- SQL string: a church admin must not be able to type SQL into a text box.
-- The filter is a small, closed vocabulary compiled here.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eval_segment(seg uuid)
RETURNS TABLE (person_id uuid)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  s record;
  f jsonb;
BEGIN
  SELECT * INTO s FROM segments WHERE id = seg;
  IF NOT FOUND THEN RETURN; END IF;

  IF s.kind = 'static' THEN
    RETURN QUERY SELECT sm.person_id FROM segment_members sm WHERE sm.segment_id = seg;
    RETURN;
  END IF;

  f := s.filter;

  RETURN QUERY
  SELECT p.id FROM persons p
    LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
    LEFT JOIN groups g ON g.id = p.home_group_id
   WHERE p.archived_at IS NULL
     AND NOT p.is_deceased
     -- stage
     AND (f->>'stage' IS NULL OR js.key = f->>'stage')
     -- group (including everything beneath it)
     AND (f->>'group_id' IS NULL OR p.home_group_id IN (
           WITH RECURSIVE d AS (
             SELECT id FROM groups WHERE id = (f->>'group_id')::uuid
             UNION ALL SELECT c.id FROM groups c JOIN d ON c.parent_id = d.id
           ) SELECT id FROM d))
     -- service
     AND (f->>'service' IS NULL OR p.usual_service = f->>'service')
     -- gender
     AND (f->>'gender' IS NULL OR p.gender = f->>'gender')
     -- state of origin
     AND (f->>'state' IS NULL OR p.state_of_origin = f->>'state')
     -- birthday this month
     AND (f->>'birthday_month' IS NULL
          OR p.dob_month = (f->>'birthday_month')::int)
     -- absent for N weeks (the most valuable filter in the product)
     AND (f->>'absent_weeks' IS NULL
          OR (p.last_attended_at IS NOT NULL
              AND p.last_attended_at < now() - ((f->>'absent_weeks')::int * interval '7 days')))
     -- never attended at all
     AND (f->>'never_attended' IS NULL
          OR (f->>'never_attended')::boolean IS NOT TRUE
          OR p.last_attended_at IS NULL)
     -- has a phone we can reach
     AND (f->>'has_phone' IS NULL
          OR (f->>'has_phone')::boolean IS NOT TRUE
          OR (p.phone IS NOT NULL OR p.phone_2 IS NOT NULL));
END $fn$;
GRANT EXECUTE ON FUNCTION eval_segment(uuid) TO hispren_app;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates','messages','message_recipients','suppressions'] LOOP
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
  ON message_templates, messages, message_recipients, suppressions TO hispren_app;

-- The worker needs to read queued messages across tenants to send them.
DROP POLICY IF EXISTS platform_access ON messages;
CREATE POLICY platform_access ON messages FOR ALL TO hispren_platform
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS platform_access ON message_recipients;
CREATE POLICY platform_access ON message_recipients FOR ALL TO hispren_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON messages, message_recipients TO hispren_platform;

-- ----------------------------------------------------------------------------
-- Default templates. Nigerian church voice, and every one fits in ONE SMS.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_templates(t uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO message_templates (tenant_id, name, channel, kind, body, is_system) VALUES
   (t,'Welcome, first timer','sms','welcome',
    'Hello {{first_name}}, thank you for worshipping with us at {{church}} today. We would love to see you again. God bless you.', true),
   (t,'Birthday','sms','birthday',
    'Happy birthday {{first_name}}! Everyone at {{church}} is celebrating with you today. May this new year be full of grace.', true),
   (t,'Service reminder','sms','service_reminder',
    'Good evening {{first_name}}. A reminder that {{service}} holds tomorrow. We look forward to seeing you at {{church}}.', true),
   (t,'We have missed you','sms','missed_attendance',
    'Hello {{first_name}}, we have not seen you at {{church}} in a while and we have been thinking of you. Is everything well?', true),
   (t,'Follow-up call','sms','follow_up',
    'Hello {{first_name}}, this is {{church}}. We would love to know how you are doing. Please expect a call from us.', true)
  ON CONFLICT DO NOTHING;
$$;

COMMIT;
