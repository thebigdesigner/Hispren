/**
 * NOTIFICATIONS.
 *
 * The heart of this file is the SUPPRESSION LAYER, and it sits at the SEND
 * boundary — not in the compose screen, not in the automation builder.
 *
 * That placement is the entire design. A church admin must not be ABLE to
 * produce a message that reaches someone who opted out, or someone who died,
 * or a member who has already had four texts this week. Not "should not" —
 * must not be able to. So the check lives below every path that can create one.
 *
 * And a suppressed message is never a silent no-op. It is a row, with a reason.
 * When a pastor says "she never got it", the answer is one query away.
 */
import { Tx, platformQuery } from "../platform/db";
import { publish } from "../platform/outbox";
import { count, render, toGsm7 } from "./gsm";
import { provider } from "./providers";
import { emailProvider, renderEmail } from "./providers/email";

const QUIET_START = 21;   // 21:00 WAT
const QUIET_END = 7;      // 07:00 WAT
const FREQ_CAP = 4;       // per person per week, across EVERY campaign and automation

export type Suppression =
  | "consent" | "deceased" | "no_number" | "bounced"
  | "quiet_hours" | "frequency_cap" | "dnd_no_route" | "no_credit";

export type Candidate = {
  person_id: string; name: string; first_name: string;
  phone: string | null; phone_2: string | null;
  email: string | null;
  is_deceased: boolean;
  consent: boolean;        // SMS
  email_consent: boolean;
  suppressed: boolean;     // SMS
  email_suppressed: boolean;
  recent: number; is_dnd: boolean | null;
};

/**
 * THE CHANNEL CASCADE.
 *
 * Email first, SMS only for the people who have no email. That single rule is
 * the difference between NGN 8,244 and NGN 3,000 for one message to 1,832
 * members — and it costs the church nothing to adopt, because the member gets
 * the message either way.
 */
export type Channel = "sms" | "email" | "cascade";

/**
 * Everyone, with every fact the suppression layer needs, in ONE query.
 * A 3,000-member campaign must not become 3,000 round-trips.
 */
export async function candidates(tx: Tx, personIds?: string[]): Promise<Candidate[]> {
  const filter = personIds && personIds.length ? `AND p.id = ANY($1::uuid[])` : "";
  const { rows } = await tx.query(
    `SELECT p.id AS person_id,
            trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
            coalesce(p.first_name,'') AS first_name,
            p.phone, p.phone_2, p.email, p.is_deceased,
            coalesce(c.status,'granted')  <> 'revoked' AS consent,
            coalesce(ce.status,'granted') <> 'revoked' AS email_consent,
            EXISTS (SELECT 1 FROM suppressions s
                     WHERE s.address IN (p.phone, p.phone_2) AND s.channel='sms') AS suppressed,
            EXISTS (SELECT 1 FROM suppressions s
                     WHERE s.address = p.email::text AND s.channel='email') AS email_suppressed,
            messages_in_window(p.id, 7) AS recent,
            d.is_dnd
       FROM persons p
       LEFT JOIN consents c   ON c.person_id = p.id AND c.channel = 'sms'
       LEFT JOIN consents ce  ON ce.person_id = p.id AND ce.channel = 'email'
       LEFT JOIN dnd_status d ON d.phone = coalesce(p.phone, p.phone_2)
      WHERE p.archived_at IS NULL ${filter}`,
    personIds && personIds.length ? [personIds] : []);
  return rows;
}

/**
 * Decide, per person, whether this may go — and if not, exactly why.
 * Nothing is sent here. This produces the DECISION, and the decision is stored.
 */
export function decide(
  c: Candidate,
  opts: { hasDndRoute: boolean; channel?: Channel; now?: Date; ignoreQuietHours?: boolean }
): { send: boolean; reason?: Suppression; to?: string;
     channel?: "sms" | "email"; route?: "generic" | "dnd" | "email" } {

  // A "we missed you!" message to someone who died last week is damage no
  // feature repays. This is checked before ANY channel.
  if (c.is_deceased) return { send: false, reason: "deceased" };

  const want = opts.channel ?? "cascade";

  // ---- EMAIL ----------------------------------------------------------
  // Free, no DND, no character tax, no time window. Where a member has an
  // email address, this is the correct channel and SMS is a waste of money.
  const emailOk = !!c.email && c.email_consent && !c.email_suppressed;

  if (want === "email") {
    if (!c.email) return { send: false, reason: "no_number" };
    if (!c.email_consent) return { send: false, reason: "consent" };
    if (c.email_suppressed) return { send: false, reason: "bounced" };
    return { send: true, to: c.email, channel: "email", route: "email" };
  }

  if (want === "cascade" && emailOk) {
    return { send: true, to: c.email!, channel: "email", route: "email" };
  }

  // ---- SMS ------------------------------------------------------------
  // Falls through to here when: SMS was asked for explicitly, or the cascade
  // found no usable email address.

  // NDPR. Not a preference — a lawful basis.
  if (!c.consent) return { send: false, reason: "consent" };

  // STOP reply, hard bounce, dead number.
  if (c.suppressed) return { send: false, reason: "bounced" };

  // Two SIMs is the Nigerian norm. Try the second before giving up on them.
  const to = c.phone || c.phone_2;
  if (!to) return { send: false, reason: "no_number" };

  // Nobody should get five texts in a week from four automations that do not
  // know about each other. The cap is global, across everything.
  if (c.recent >= FREQ_CAP) return { send: false, reason: "frequency_cap" };

  const now = opts.now ?? new Date();
  const hour = Number(now.toLocaleString("en-GB",
    { timeZone: "Africa/Lagos", hour: "2-digit", hour12: false }));
  const quiet = hour >= QUIET_START || hour < QUIET_END;

  // A DND-registered number CANNOT be reached on the generic route. At all.
  // Not "less reliably" — not at all. Without the DND route, this person is
  // unreachable by SMS, and the church needs to know that.
  if (c.is_dnd) {
    if (!opts.hasDndRoute) return { send: false, reason: "dnd_no_route" };
    return { send: true, to, channel: "sms", route: "dnd" };  // no time limit
  }

  // On the generic route this is not our policy — it is MTN's. They refuse
  // delivery 8pm–8am. Sending anyway means it silently vanishes.
  if (quiet && !opts.ignoreQuietHours) return { send: false, reason: "quiet_hours" };

  return { send: true, to, channel: "sms",
           route: opts.hasDndRoute ? "dnd" : "generic" };
}

export async function senderFor(tx: Tx): Promise<{ id: string | null; dnd: boolean }> {
  const { rows } = await tx.query(
    `SELECT sender_id, dnd_approved FROM sender_ids
      WHERE status = 'active' ORDER BY is_default DESC, approved_at LIMIT 1`);
  if (!rows[0]) return { id: null, dnd: false };
  return { id: rows[0].sender_id, dnd: rows[0].dnd_approved };
}

/**
 * Compose: who gets it, who does not and why, what it costs — and write ALL of
 * it down BEFORE a single message leaves. The pastor sees the whole picture,
 * then presses send. Or does not.
 */
export async function prepare(
  tx: Tx,
  opts: { name: string; body: string; subject?: string; channel?: Channel;
          personIds?: string[]; userId: string;
          templateId?: string | null; ignoreQuietHours?: boolean }
) {
  const sender = await senderFor(tx);
  const people = await candidates(tx, opts.personIds);
  const channel: Channel = opts.channel ?? "cascade";
  const t = await tx.query(
    `SELECT name, sms_opt_out_text FROM tenants WHERE id = current_tenant_id()`);
  const church = t.rows[0]?.name ?? "";
  const optOut = (t.rows[0]?.sms_opt_out_text ?? "Reply STOP to opt out.").trim();

  // Normalise BEFORE counting. One curly apostrophe from Word turns a
  // 160-character message into a 70-character one and doubles the bill.
  const clean = toGsm7(opts.body);

  // The NCC requires an opt-out instruction at the end of every SMS. Appended
  // HERE, at the send layer — an admin cannot forget it and cannot remove it.
  // It is counted, so the page count the pastor sees is the truth.
  //
  // Email does NOT get it: the HTML footer carries its own, and "Reply STOP"
  // in an email is nonsense.
  const smsBody = (optOut && !/\bSTOP\b/i.test(clean))
    ? clean.trimEnd() + " " + optOut
    : clean;
  const body = smsBody;   // campaigns store the SMS form; email strips it back off

  const camp = await tx.query(
    `INSERT INTO campaigns (tenant_id, name, channel, body, template_id, created_by, status)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, 'draft') RETURNING id`,
    [opts.name, channel === "cascade" ? "sms" : channel, body,
     opts.templateId ?? null, opts.userId]);
  const campaignId = camp.rows[0].id;

  const subject = opts.subject?.trim() || church;

  let bySms = 0, byEmail = 0, suppressed = 0, units = 0;
  const reasons: Record<string, number> = {};

  for (const p of people) {
    const vars = { first_name: p.first_name, church, name: p.name };
    const rendered = render(smsBody, vars);
    const emailBody = render(clean, vars);     // no "Reply STOP" in an email
    const k = count(rendered);
    const d = decide(p, { hasDndRoute: sender.dnd, channel,
                          ignoreQuietHours: opts.ignoreQuietHours });

    if (!d.send) {
      suppressed++;
      reasons[d.reason!] = (reasons[d.reason!] ?? 0) + 1;
      await tx.query(
        `INSERT INTO messages (tenant_id, campaign_id, person_id, channel, to_address,
           body, units, encoding, status, suppressed_by)
         VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,'suppressed',$8)`,
        [campaignId, p.person_id, channel === "email" ? "email" : "sms",
         p.email || p.phone || p.phone_2 || '-', rendered,
         k.units, k.encoding, d.reason]);
      continue;
    }

    if (d.channel === "email") {
      byEmail++;
      await tx.query(
        `INSERT INTO messages (tenant_id, campaign_id, person_id, channel, to_address,
           sender_id, body, units, encoding, route, status)
         VALUES (current_tenant_id(),$1,$2,'email',$3,$4,$5,1,'GSM7','email','queued')`,
        [campaignId, p.person_id, d.to, subject, emailBody]);
    } else {
      bySms++;
      units += k.units;   // only SMS costs units
      await tx.query(
        `INSERT INTO messages (tenant_id, campaign_id, person_id, channel, to_address,
           sender_id, body, units, encoding, route, status)
         VALUES (current_tenant_id(),$1,$2,'sms',$3,$4,$5,$6,$7,$8,'queued')`,
        [campaignId, p.person_id, d.to, sender.id, rendered,
         k.units, k.encoding, d.route]);
    }
  }

  const queued = bySms + byEmail;
  await tx.query(
    `UPDATE campaigns SET recipients=$2, suppressed=$3, queued=$4, units=$5 WHERE id=$1`,
    [campaignId, people.length, suppressed, queued, units]);

  // What the church would have paid on SMS alone — this is the number that
  // makes the cascade obvious, and it belongs in front of the pastor.
  const smsOnlyUnits = people
    .filter(p => decide(p, { hasDndRoute: sender.dnd, channel: "sms",
                             ignoreQuietHours: opts.ignoreQuietHours }).send)
    .reduce((n, p) => n + count(render(body,
      { first_name: p.first_name, church, name: p.name })).units, 0);

  return {
    campaign_id: campaignId,
    channel,
    sender_id: sender.id,
    has_dnd_route: sender.dnd,
    recipients: people.length,
    queued, suppressed, units, reasons,
    by_sms: bySms,
    by_email: byEmail,
    sms_only_units: smsOnlyUnits,        // the counterfactual
    counted: count(render(body, { first_name: "Chinedu", church })),
    subject,
    sample: render(body, { first_name: people[0]?.first_name ?? "Chinedu", church }),
  };
}

/** Charge the wallet, then hand the queue to the worker. */
export async function dispatch(tx: Tx, campaignId: string, unitPrice = 4.5) {
  const c = await tx.query(
    `SELECT queued, units, status FROM campaigns WHERE id = $1`, [campaignId]);
  if (!c.rows[0]) throw new Error("campaign not found");
  if (c.rows[0].status !== "draft") throw new Error("this campaign has already been sent");

  const cost = Number(c.rows[0].units) * unitPrice;

  // A church must never go into SMS debt. The wallet's CHECK (balance >= 0)
  // refuses at the database level, so this fails loudly instead of quietly.
  let balance: number | null = null;
  try {
    const w = await tx.query(
      `UPDATE credit_wallets SET balance = balance - $1, updated_at = now()
        WHERE tenant_id = current_tenant_id() AND credit_type = 'sms'
        RETURNING balance`, [cost]);
    balance = w.rows[0] ? Number(w.rows[0].balance) : null;
  } catch { balance = null; }

  if (balance === null) {
    await tx.query(
      `UPDATE messages SET status='suppressed', suppressed_by='no_credit'
        WHERE campaign_id=$1 AND status='queued'`, [campaignId]);
    await tx.query(`UPDATE campaigns SET status='failed' WHERE id=$1`, [campaignId]);
    throw new Error(`Not enough SMS credit. This campaign needs ${cost.toFixed(2)} units.`);
  }

  await tx.query(
    `INSERT INTO credit_ledger (tenant_id, credit_type, delta, reason)
     VALUES (current_tenant_id(), 'sms', $1, $2)`, [-cost, `campaign:${campaignId}`]);
  await tx.query(
    `UPDATE campaigns SET status='queued', cost=$2, sent_at=now() WHERE id=$1`,
    [campaignId, cost]);
  await publish(tx, { type: "campaign.queued", entityType: "campaign",
    entityId: campaignId, payload: { units: c.rows[0].units, cost } });

  return { queued: c.rows[0].queued, units: c.rows[0].units, cost, balance };
}

// ---------------------------------------------------------------------------
// WORKER SIDE — drains the queue across every tenant
// ---------------------------------------------------------------------------
export async function drainQueue(batch = 50) {
  const sms = provider();
  const mail = emailProvider();
  const from = process.env.EMAIL_FROM ?? "Hispren <onboarding@resend.dev>";

  const { rows } = await platformQuery<any>(
    `SELECT m.id, m.channel, m.to_address, m.sender_id, m.body, m.route,
            t.name AS church, t.brand_color
       FROM messages m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.status = 'queued' ORDER BY m.queued_at LIMIT $1`, [batch]);

  for (const m of rows) {
    let ok = false, providerId: string | undefined, error: string | undefined;
    let providerName: string;

    if (m.channel === "email") {
      // sender_id carries the subject for an email row
      const { html, text } = renderEmail(m.church, m.body, m.brand_color || "#00C389");
      const r = await mail.send(m.to_address, from, m.sender_id || m.church, html, text);
      ok = r.ok; providerId = r.providerId; error = r.error;
      providerName = mail.name;
    } else {
      const r = await sms.send(m.to_address, m.sender_id ?? "Hispren", m.body,
                               (m.route ?? "generic") as any);
      ok = r.ok; providerId = r.providerId; error = r.error;
      providerName = sms.name;
    }

    await platformQuery(
      `UPDATE messages SET status=$2, provider=$3, provider_id=$4, error=$5, sent_at=now()
        WHERE id=$1`,
      [m.id, ok ? "sent" : "failed", providerName, providerId ?? null, error ?? null]);
  }
  return rows.length;
}

/** Nightly. Checking DND costs an API call — cache it, it changes rarely. */
export async function refreshDnd(limit = 200) {
  const p = provider();
  if (!p.checkDnd) return 0;
  const { rows } = await platformQuery<any>(
    `SELECT DISTINCT coalesce(p.phone, p.phone_2) AS phone
       FROM persons p
       LEFT JOIN dnd_status d ON d.phone = coalesce(p.phone, p.phone_2)
      WHERE coalesce(p.phone, p.phone_2) IS NOT NULL AND p.archived_at IS NULL
        AND (d.phone IS NULL OR d.checked_at < now() - interval '30 days')
      LIMIT $1`, [limit]);
  for (const r of rows) {
    const s = await p.checkDnd(r.phone);
    await platformQuery(
      `INSERT INTO dnd_status (phone, is_dnd, network, checked_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (phone) DO UPDATE SET is_dnd=$2, network=$3, checked_at=now()`,
      [r.phone, s.isDnd, s.network ?? null]);
  }
  return rows.length;
}

/** Inbound STOP. The member has opted out. That is final, and it is instant. */
export async function handleStop(phone: string) {
  await platformQuery(
    `INSERT INTO suppressions (tenant_id, address, channel, reason)
     SELECT p.tenant_id, $1, 'sms', 'stop_reply' FROM persons p
      WHERE p.phone = $1 OR p.phone_2 = $1
     ON CONFLICT DO NOTHING`, [phone]);
  await platformQuery(
    `INSERT INTO consents (tenant_id, person_id, channel, status)
     SELECT p.tenant_id, p.id, 'sms', 'revoked' FROM persons p
      WHERE p.phone = $1 OR p.phone_2 = $1
     ON CONFLICT (tenant_id, person_id, channel)
       DO UPDATE SET status='revoked', updated_at=now()`, [phone]);
  await platformQuery(
    `INSERT INTO consent_events (tenant_id, person_id, channel, action, source)
     SELECT p.tenant_id, p.id, 'sms', 'revoked', 'stop_reply' FROM persons p
      WHERE p.phone = $1 OR p.phone_2 = $1`, [phone]);
}
