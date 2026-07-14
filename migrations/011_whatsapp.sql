-- ============================================================================
-- 011 — WHATSAPP
--
-- The way around bulk SMS, and it is better than bulk SMS.
--
-- No telco. No sender ID. No DND register. No NCC approval. Meta does not care
-- that you are not a bank — and Nigerians LIVE on WhatsApp. A message from the
-- church arrives beside their family, not in the SMS folder they stopped
-- opening in 2019.
--
-- TWO MODES, and the first one works TODAY with zero setup:
--
--   MANUAL   A wa.me link. The secretary taps a name, WhatsApp opens with the
--            message already written, she presses send. It goes from the
--            CHURCH'S OWN number. One tap per person. For the 34 first-timers
--            who need calling this Sunday, that is not a limitation — it is
--            the right way to do it.
--
--   CLOUD    Meta's WhatsApp Cloud API. Real bulk. A Meta business account and
--            template approval, about two days, and no telco is involved at any
--            point. Anything sent inside a 24-hour SERVICE WINDOW — opened when
--            the MEMBER messages the church first — is FREE and needs no
--            template at all.
-- ============================================================================
BEGIN;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_route_check;
ALTER TABLE messages ADD CONSTRAINT messages_route_check
  CHECK (route IN ('generic','dnd','email','whatsapp'));

-- 'sent_by_hand' is not a failure. It is a secretary's thumb, and it is the
-- most reliable delivery channel this product has.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('queued','sent','delivered','failed','suppressed','sent_by_hand'));

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_channel_check;

-- Which WhatsApp number the church sends from, when it is doing it by hand.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp_number text;

COMMIT;
