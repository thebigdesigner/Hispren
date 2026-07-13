-- ============================================================
-- 08 — GO LIVE WITH SMS
-- Paste into the Neon SQL Editor and Run.
--
-- Prereq: 007_notifications.sql has been applied.
--
-- Two things Hispren cannot do for itself:
--   1. A wallet top-up. hispren_app is DENIED any balance increase at the
--      database level — otherwise a bug becomes unlimited spending on your
--      gateway account. Top-ups are a platform operation, and this is it.
--   2. Seeding the message templates for a church.
-- ============================================================

DO $$
DECLARE t uuid := 'aaaa0000-0000-0000-0000-000000000001';  -- Dominion Chapel
BEGIN
  SET LOCAL ROLE hispren_platform;

  -- SMS wallet. Units = PAGES, not messages. A 2-page message costs 2 units.
  INSERT INTO credit_wallets (tenant_id, credit_type, balance)
  VALUES (t, 'sms', 1000)
  ON CONFLICT (tenant_id, credit_type) DO UPDATE SET balance = 1000;

  RESET ROLE;

  -- Templates. Deliberately written in plain GSM-7 — no curly quotes, no
  -- em dashes. One smart apostrophe doubles what the church pays.
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', t::text, true);
  PERFORM seed_templates(t);

  -- The Nigerian Sunday: three services plus midweek. Without these, Attendance
  -- has nothing to open and the scanner has nothing to scan into.
  PERFORM seed_services(t);

  -- The funds a Nigerian church actually keeps, with the categories each
  -- restricted fund may be spent on. The database refuses everything else.
  PERFORM seed_funds(t);
  RESET ROLE;
END $$;

-- What you should see
SET ROLE hispren_app;
SELECT set_config('app.tenant_id', 'aaaa0000-0000-0000-0000-000000000001', false);

SELECT 'sms credit'  AS item, balance::text AS value FROM credit_wallets WHERE credit_type='sms'
UNION ALL
SELECT 'templates',  count(*)::text FROM message_templates
UNION ALL
SELECT 'sender ids', count(*)::text FROM sender_ids
UNION ALL
SELECT 'services',   count(*)::text FROM services
UNION ALL
SELECT 'funds',      count(*)::text FROM funds;

RESET ROLE;
