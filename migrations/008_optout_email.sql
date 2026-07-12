-- ============================================================================
-- 008 — THE MANDATORY OPT-OUT LINE
--
-- The NCC requires an opt-out instruction at the END of every commercial SMS.
-- Not a best practice. A requirement — and the thing that gets a sender ID
-- BLOCKED when it is missing.
--
-- A blocked sender ID does not take one church down. It takes EVERY church on
-- the platform down at once, because they all send through it.
--
-- So Hispren appends it automatically, and COUNTS it, so the pastor sees the
-- true page count before he pays. A church admin cannot forget it, because a
-- church admin is never asked.
-- ============================================================================
BEGIN;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sms_opt_out_text text
  NOT NULL DEFAULT 'Reply STOP to opt out.';

-- ----------------------------------------------------------------------------
-- Templates are stored WITHOUT the opt-out line. It is appended at send time,
-- and only if the body does not already contain "STOP".
--
-- Why not bake it into the templates? Because a church that edits a template
-- would strip it without realising, and the platform would be non-compliant on
-- that church's traffic. Appending at the send boundary means it cannot be
-- edited out.
--
-- Every one of these is deliberately plain GSM-7 — no curly quotes, no dashes.
-- One smart apostrophe pasted from Word turns 160 characters into 70 and
-- doubles what the church pays.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_templates(t uuid) RETURNS void
LANGUAGE sql AS $fn$
  INSERT INTO message_templates (tenant_id, key, name, channel, subject, body, is_system) VALUES
   (t,'welcome_first_timer','Welcome a first timer','sms', NULL,
    'Hello {{first_name}}, thank you for worshipping with us at {{church}} today. We would love to see you again. God bless you.', true),
   (t,'follow_up','Follow up','sms', NULL,
    'Hello {{first_name}}, this is {{church}}. We have not seen you in a while and wanted to check on you. Is all well?', true),
   (t,'birthday','Birthday','sms', NULL,
    'Happy birthday {{first_name}}! Everyone at {{church}} is celebrating with you today. May this new year be full of grace.', true),
   (t,'service_reminder','Service reminder','sms', NULL,
    'Hello {{first_name}}, a reminder that {{service}} holds tomorrow. We look forward to worshipping with you at {{church}}.', true),
   (t,'missed_you','We missed you','sms', NULL,
    'Hello {{first_name}}, we missed you at {{church}} on Sunday. You are in our prayers. Please tell us if there is any way we can help.', true),

   -- Email templates. Longer, because email has no 160-character tax and costs
   -- nothing. This is where a church should say what it actually wants to say.
   (t,'email_welcome','Welcome (email)','email','Welcome to {{church}}',
    'Dear {{first_name}},

Thank you for worshipping with us today. It was a joy to have you.

We would love to see you again, and to know you better. If there is anything at
all we can pray about with you, simply reply to this email.

You are always welcome here.

The pastoral team
{{church}}', true),

   (t,'email_announcement','Announcement (email)','email','A word from {{church}}',
    'Dear {{first_name}},

[Write your announcement here.]

God bless you.

{{church}}', true)
  ON CONFLICT (tenant_id, key) DO NOTHING;
$fn$;

COMMIT;
