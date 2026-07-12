/**
 * NOTIFICATIONS.
 *
 * Three Nigerian realities shape every line of this file:
 *
 *  1. 160 GSM-7 characters is ONE SMS. A single non-GSM character — a curly
 *     quote pasted from Word, a Yoruba diacritic — drops the limit to 70 and
 *     TRIPLES the cost. A church sending 2,000 members a "160-character"
 *     message with one smart apostrophe in it pays for 6,000 SMS, not 2,000.
 *
 *  2. DND blocks promotional SMS. Church messages sit right on the
 *     promotional/transactional line. Get the route wrong and a large share of
 *     a congregation silently never hears from you — and the pastor blames the
 *     software, not the NCC.
 *
 *  3. Most people carry two SIMs. If phone 1 fails, try phone 2.
 */
import { Tx, platformQuery } from "../platform/db";
import { publish } from "../platform/outbox";

// ===========================================================================
// GSM-7 — the character set that costs 160 instead of 70
// ===========================================================================
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";   // these cost TWO characters each

/** Word's smart quotes and dashes are the #1 cause of a tripled SMS bill. */
export function normaliseForSms(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

export type SmsCount = {
  chars: number;
  encoding: "GSM-7" | "UCS-2";
  units: number;
  perUnit: number;
  offenders: string[];        // the exact characters that broke GSM-7
};

export function countSms(raw: string): SmsCount {
  const s = normaliseForSms(raw);
  const offenders: string[] = [];
  let chars = 0;
  let gsm = true;

  for (const c of s) {
    if (GSM7.includes(c)) chars += 1;
    else if (GSM7_EXT.includes(c)) chars += 2;
    else { gsm = false; if (!offenders.includes(c)) offenders.push(c); }
  }
  if (!gsm) chars = [...s].length;   // UCS-2 counts code points

  const single = gsm ? 160 : 70;
  const multi  = gsm ? 153 : 67;     // concatenated parts lose 7 chars to a header
  const units  = chars <= single ? 1 : Math.ceil(chars / multi);

  return {
    chars,
    encoding: gsm ? "GSM-7" : "UCS-2",
    units: Math.max(1, units),
    perUnit: single,
    offenders,
  };
}

// ===========================================================================
// TEMPLATES
// ===========================================================================
export function render(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] === undefined || vars[k] === null ? "" : String(vars[k]));
}

// ===========================================================================
// PROVIDERS
//
// An abstraction, NOT a Termii integration. You will switch — on price, on a
// bad delivery week, on an outage during a Sunday service. Adapters, and a
// failover chain.
// ===========================================================================
export type SendResult = {
  ok: boolean;
  ref?: string;
  error?: string;
};

export interface SmsProvider {
  name: string;
  send(to: string, body: string, senderId: string): Promise<SendResult>;
}

/**
 * The default. Does EVERYTHING a real provider does except hand the message to
 * MTN — suppression, counting, wallet debit, delivery records, the lot.
 *
 * This exists because sender-ID registration takes weeks. A church can be
 * onboarded, segmented, and rehearsed today, and the day the sender ID lands
 * you flip one setting.
 */
export const dryRun: SmsProvider = {
  name: "dry_run",
  async send(to) {
    return { ok: true, ref: `dry-${Date.now()}-${to.slice(-4)}` };
  },
};

export const termii: SmsProvider = {
  name: "termii",
  async send(to, body, senderId) {
    const key = process.env.TERMII_API_KEY;
    if (!key) return { ok: false, error: "TERMII_API_KEY not set" };
    try {
      const r = await fetch("https://api.ng.termii.com/api/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to, from: senderId, sms: body,
          type: "plain",
          channel: "dnd",          // <- reaches DND-registered numbers. Not optional.
          api_key: key,
        }),
      });
      const j: any = await r.json();
      if (!r.ok || j.code !== "ok")
        return { ok: false, error: j.message ?? `HTTP ${r.status}` };
      return { ok: true, ref: j.message_id };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

export const africasTalking: SmsProvider = {
  name: "africastalking",
  async send(to, body, senderId) {
    const key = process.env.AT_API_KEY, user = process.env.AT_USERNAME;
    if (!key || !user) return { ok: false, error: "AT credentials not set" };
    try {
      const r = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          apiKey: key,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ username: user, to, message: body, from: senderId }),
      });
      const j: any = await r.json();
      const rec = j?.SMSMessageData?.Recipients?.[0];
      if (!rec || rec.statusCode >= 300)
        return { ok: false, error: rec?.status ?? "send failed" };
      return { ok: true, ref: rec.messageId };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

const PROVIDERS: Record<string, SmsProvider> = {
  dry_run: dryRun, termii, africastalking: africasTalking,
};

/** Primary, then fallback. A provider outage on a Sunday morning is not fatal. */
export async function sendSms(
  primary: string, to: string, body: string, senderId: string
): Promise<SendResult & { provider: string }> {
  const chain = [PROVIDERS[primary] ?? dryRun];
  if (primary !== "dry_run") {
    const fb = primary === "termii" ? africasTalking : termii;
    chain.push(fb);
  }
  let last: SendResult = { ok: false, error: "no provider" };
  for (const p of chain) {
    const r = await p.send(to, body, senderId);
    if (r.ok) return { ...r, provider: p.name };
    last = r;
  }
  return { ...last, provider: chain[chain.length - 1].name };
}

// ===========================================================================
// THE SUPPRESSION LAYER
//
// This is the most important code in the file, and it lives BELOW the composer
// on purpose: an admin must not be *able* to build a send that violates it.
//
// Order matters. Deceased first — nothing is worse than texting a widow's
// husband "we've missed you at church!"
// ===========================================================================
export type Target = {
  person_id: string;
  name: string;
  phone: string | null;
  phone_2: string | null;
  email: string | null;
  is_deceased: boolean;
  consent: boolean;
  weekly_count: number;
};

export type Screened = {
  person_id: string;
  address: string | null;
  used_fallback: boolean;
  suppressed: null | "consent" | "deceased" | "frequency_cap" | "quiet_hours" | "no_number" | "bounced";
};

export function screen(
  t: Target,
  channel: string,
  opts: { weeklyCap: number; quietHours: boolean; bounced: Set<string> }
): Screened {
  // 1. Deceased. Permanent, unconditional, no override anywhere in the product.
  if (t.is_deceased)
    return { person_id: t.person_id, address: null, used_fallback: false, suppressed: "deceased" };

  // 2. Consent. NDPR. Not a preference — a legal basis.
  if (!t.consent)
    return { person_id: t.person_id, address: null, used_fallback: false, suppressed: "consent" };

  // 3. Quiet hours. Nobody gets a church SMS at 3am.
  if (opts.quietHours)
    return { person_id: t.person_id, address: null, used_fallback: false, suppressed: "quiet_hours" };

  // 4. Frequency cap — GLOBAL, across every campaign and every workflow.
  //    Without this, three "reasonable" senders produce eleven texts in a week
  //    and the member blocks the church's number.
  if (t.weekly_count >= opts.weeklyCap)
    return { person_id: t.person_id, address: null, used_fallback: false, suppressed: "frequency_cap" };

  // 5. Pick an address. TWO SIMs — fall back to phone 2.
  let address: string | null = null, fallback = false;
  if (channel === "email") {
    address = t.email;
  } else {
    if (t.phone && !opts.bounced.has(t.phone)) address = t.phone;
    else if (t.phone_2 && !opts.bounced.has(t.phone_2)) { address = t.phone_2; fallback = true; }
    else if (t.phone || t.phone_2)
      return { person_id: t.person_id, address: null, used_fallback: false, suppressed: "bounced" };
  }
  if (!address)
    return { person_id: t.person_id, address: null, used_fallback: false, suppressed: "no_number" };

  return { person_id: t.person_id, address, used_fallback: fallback, suppressed: null };
}

// ===========================================================================
// COMPOSE — screen everyone, cost it, and show the church BEFORE they send
// ===========================================================================
export async function targetsFor(tx: Tx, segmentId?: string, personIds?: string[]) {
  const where = segmentId
    ? `p.id IN (SELECT person_id FROM eval_segment($1))`
    : `p.id = ANY($1::uuid[])`;
  const arg = segmentId ? segmentId : personIds ?? [];

  const { rows } = await tx.query(
    `SELECT p.id AS person_id,
            trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
            p.first_name, p.phone, p.phone_2, p.email, p.is_deceased, p.usual_service,
            coalesce((SELECT c.status = 'granted' FROM consents c
                       WHERE c.person_id = p.id AND c.channel = $2), true) AS consent,
            messages_this_week(p.id) AS weekly_count
       FROM persons p
      WHERE ${where} AND p.archived_at IS NULL`,
    [arg, "sms"]);
  return rows;
}

export async function compose(
  tx: Tx,
  o: { channel: string; body: string; subject?: string; segment_id?: string;
       person_ids?: string[]; template_id?: string; userId: string }
) {
  const t = await tx.query(
    `SELECT name, sender_id, quiet_from, quiet_to, weekly_cap, sms_provider, timezone
       FROM tenants WHERE id = current_tenant_id()`);
  const cfg = t.rows[0];

  const b = await tx.query(
    `SELECT address FROM suppressions WHERE channel = $1`, [o.channel]);
  const bounced = new Set<string>(b.rows.map((r: any) => r.address));

  const now = new Date();
  const hh = now.getUTCHours() + 1;                      // WAT = UTC+1, no DST
  const qf = Number(String(cfg.quiet_from).slice(0, 2));
  const qt = Number(String(cfg.quiet_to).slice(0, 2));
  const quiet = qf > qt ? (hh >= qf || hh < qt) : (hh >= qf && hh < qt);

  const targets = await targetsFor(tx, o.segment_id, o.person_ids);
  const screened = targets.map((x: any) =>
    ({ ...screen(x, o.channel, { weeklyCap: cfg.weekly_cap, quietHours: quiet, bounced }),
       first_name: x.first_name, service: x.usual_service }));

  const count = countSms(o.body);
  const sendable = screened.filter((s) => !s.suppressed);
  const cost = o.channel === "sms" ? sendable.length * count.units * 4.5 : 0;

  const m = await tx.query(
    `INSERT INTO messages (tenant_id, channel, subject, body, template_id, segment_id,
        status, units_each, encoding, total_targets, suppressed, estimated_cost, created_by)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [o.channel, o.subject ?? null, o.body, o.template_id ?? null, o.segment_id ?? null,
     count.units, count.encoding, targets.length,
     screened.length - sendable.length, cost, o.userId]);
  const msg = m.rows[0];

  for (const s of screened) {
    await tx.query(
      `INSERT INTO message_recipients
         (tenant_id, message_id, person_id, address, used_fallback, status,
          suppressed_reason, units)
       VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7)`,
      [msg.id, s.person_id, s.address, s.used_fallback,
       s.suppressed ? "suppressed" : "pending", s.suppressed, count.units]);
  }

  return {
    message: msg,
    count,
    sendable: sendable.length,
    suppressed: screened.length - sendable.length,
    breakdown: screened.reduce((a: any, s) => {
      if (s.suppressed) a[s.suppressed] = (a[s.suppressed] ?? 0) + 1;
      return a;
    }, {}),
    cost,
  };
}

// ===========================================================================
// SEND — debit the wallet FIRST. A church must never run into SMS debt.
// ===========================================================================
export async function send(tx: Tx, messageId: string) {
  const m = await tx.query(
    `SELECT m.*, t.sender_id, t.sms_provider, t.name AS church
       FROM messages m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.id = $1 AND m.status = 'draft'`, [messageId]);
  if (!m.rows[0]) throw new Error("message not found, or already sent");
  const msg = m.rows[0];

  const pend = await tx.query(
    `SELECT r.id, r.person_id, r.address, r.units, p.first_name, p.usual_service
       FROM message_recipients r JOIN persons p ON p.id = r.person_id
      WHERE r.message_id = $1 AND r.status = 'pending'`, [messageId]);

  const units = pend.rows.reduce((a: number, r: any) => a + r.units, 0);

  if (msg.channel === "sms" && units > 0) {
    const w = await tx.query(
      `UPDATE credit_wallets SET balance = balance - $2, updated_at = now()
        WHERE tenant_id = current_tenant_id() AND credit_type = 'sms'
          AND balance >= $2
       RETURNING balance`, [messageId, units]);
    if (!w.rows[0]) {
      await tx.query(
        `UPDATE message_recipients SET status='suppressed', suppressed_reason='no_credit'
          WHERE message_id=$1 AND status='pending'`, [messageId]);
      await tx.query(`UPDATE messages SET status='failed' WHERE id=$1`, [messageId]);
      throw new Error("not_enough_sms_credit");
    }
    await tx.query(
      `INSERT INTO credit_ledger (tenant_id, credit_type, delta, reason)
       VALUES (current_tenant_id(),'sms',$1,$2)`, [-units, `send:${messageId}`]);
  }

  await tx.query(`UPDATE messages SET status='sending' WHERE id=$1`, [messageId]);
  await publish(tx, {
    type: "message.queued", entityType: "message", entityId: messageId,
    payload: { channel: msg.channel, recipients: pend.rows.length },
  });

  return { queued: pend.rows.length, units };
}

/** Run by the worker. Actually hits the provider. */
export async function deliver(messageId: string) {
  const m = await platformQuery<any>(
    `SELECT m.*, t.sender_id, t.sms_provider, t.name AS church
       FROM messages m JOIN tenants t ON t.id = m.tenant_id WHERE m.id = $1`, [messageId]);
  if (!m.rows[0]) return;
  const msg = m.rows[0];

  const rec = await platformQuery<any>(
    `SELECT r.id, r.address, p.first_name, p.usual_service
       FROM message_recipients r JOIN persons p ON p.id = r.person_id
      WHERE r.message_id = $1 AND r.status = 'pending'`, [messageId]);

  let sent = 0, failed = 0;
  for (const r of rec.rows) {
    const body = render(normaliseForSms(msg.body), {
      first_name: r.first_name, church: msg.church, service: r.usual_service,
    });
    const res = await sendSms(
      msg.sms_provider, r.address, body, msg.sender_id ?? "Church");

    if (res.ok) {
      sent++;
      await platformQuery(
        `UPDATE message_recipients SET status='sent', provider=$2, provider_ref=$3,
                sent_at=now() WHERE id=$1`, [r.id, res.provider, res.ref]);
    } else {
      failed++;
      await platformQuery(
        `UPDATE message_recipients SET status='failed', provider=$2, error=$3
          WHERE id=$1`, [r.id, res.provider, res.error]);
    }
  }

  await platformQuery(
    `UPDATE messages SET status=$2, sent_count=$3, failed_count=$4, sent_at=now()
      WHERE id=$1`,
    [messageId, failed && !sent ? "failed" : "sent", sent, failed]);
  return { sent, failed };
}

/**
 * Delivery webhook. The provider tells us it actually landed — or bounced.
 * A hard bounce is suppressed, or you burn credits on that number every week.
 */
export async function receipt(ref: string, status: string) {
  const r = await platformQuery<any>(
    `UPDATE message_recipients
        SET status = CASE WHEN $2 IN ('delivered','DELIVERED') THEN 'delivered'
                          ELSE 'failed' END,
            delivered_at = CASE WHEN $2 IN ('delivered','DELIVERED') THEN now() END
      WHERE provider_ref = $1
      RETURNING tenant_id, address, status`, [ref, status]);
  const row = r.rows[0];
  if (row && row.status === "failed" && row.address) {
    await platformQuery(
      `INSERT INTO suppressions (tenant_id, address, channel, reason)
       VALUES ($1,$2,'sms','hard_bounce') ON CONFLICT DO NOTHING`,
      [row.tenant_id, row.address]);
  }
  return row ?? null;
}
