-- ============================================================================
-- 012 — TWO REAL HOLES
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- 1. THE FREQUENCY CAP WAS BLIND TO WHATSAPP.
--
-- The cap exists so nobody gets five messages in a week from four automations
-- that do not know about each other. It counted 'queued', 'sent', 'delivered'.
--
-- A WhatsApp message a secretary actually tapped through is 'sent_by_hand' —
-- which was in NONE of those. So a member could receive four SMS AND unlimited
-- WhatsApp, and the protection I built for them would never once fire.
--
-- The cap must count EVERY message a person actually received, by whatever
-- means it left the building.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messages_in_window(p uuid, days int DEFAULT 7)
RETURNS int LANGUAGE sql STABLE AS $fn$
  SELECT count(*)::int FROM messages
   WHERE person_id = p
     AND status IN ('queued','sent','delivered','sent_by_hand')
     AND queued_at > now() - (days * interval '1 day')
$fn$;
GRANT EXECUTE ON FUNCTION messages_in_window(uuid, int) TO hispren_app, hispren_platform;

-- ----------------------------------------------------------------------------
-- 2. The tap-through list is read on every paint, and it filters on
--    (campaign_id, channel, status). Without this index, a 1,832-person
--    WhatsApp campaign scans the whole messages table on every single tap.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_msg_tap
  ON messages(campaign_id, channel, status)
  WHERE channel = 'whatsapp';

COMMIT;
