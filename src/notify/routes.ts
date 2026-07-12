import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as n from "./service";
import { count, toGsm7, render } from "./gsm";
import { provider } from "./providers";
import { emailProvider } from "./providers/email";

export function registerNotifyRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };
  const admin = { preHandler: [authenticate, requireRole("admin")] };

  /** Live GSM-7 counter for the composer. This is what stops the church overpaying. */
  app.post<{ Body: { body: string } }>("/api/notify/count", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const t = await tx.query(
        `SELECT sms_opt_out_text FROM tenants WHERE id = current_tenant_id()`);
      const optOut = (t.rows[0]?.sms_opt_out_text ?? "Reply STOP to opt out.").trim();

      const raw = req.body.body ?? "";
      // Count what will ACTUALLY be sent — including the mandatory opt-out.
      // Counting without it would understate the cost, which is the same as lying.
      const withOptOut = (s: string) =>
        optOut && !/\bSTOP\b/i.test(s) ? s.trimEnd() + " " + optOut : s;

      return {
        raw: count(withOptOut(raw)),
        normalised: count(withOptOut(toGsm7(raw))),
        fixed: toGsm7(raw),
        opt_out: optOut,
      };
    }));

  app.get("/api/notify/templates", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT id, key, name, channel, body, is_system FROM message_templates
        WHERE archived_at IS NULL ORDER BY is_system DESC, name`)).rows));

  app.get("/api/notify/sender-ids", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT id, sender_id, status, dnd_approved, is_default FROM sender_ids
        ORDER BY is_default DESC, requested_at DESC`)).rows));

  app.post<{ Body: { sender_id: string; use_case?: string; dnd_approved?: boolean } }>(
    "/api/notify/sender-ids", admin, async (req, reply) => {
      const s = await tenantTx(req, async (tx) => (await tx.query(
        `INSERT INTO sender_ids (tenant_id, sender_id, use_case, status, dnd_approved, is_default)
         VALUES (current_tenant_id(), $1, $2, 'active', $3,
                 NOT EXISTS (SELECT 1 FROM sender_ids WHERE tenant_id = current_tenant_id()))
         ON CONFLICT (tenant_id, sender_id) DO UPDATE
           SET use_case = $2, dnd_approved = $3
         RETURNING *`,
        [req.body.sender_id.slice(0, 11), req.body.use_case ?? null,
         !!req.body.dnd_approved])).rows[0]);
      reply.code(201).send(s);
    });

  /**
   * THE AUDIENCE PICKER.
   *
   * Every review of every ChMS names the same thing as the killer feature:
   * "send from the database, filtering recipients by criteria." A count is not
   * an audience. "Send to 3" tells a pastor nothing — WHICH three?
   *
   * This returns the actual PEOPLE, with how each one would be reached, so he
   * can look at the list before he pays for it.
   */
  app.post<{ Body: {
    stage?: string; group_id?: string; service?: string; q?: string;
    has_email?: boolean; has_phone?: boolean; no_group?: boolean;
    at_risk_weeks?: number; never_attended?: boolean;
    person_ids?: string[];
  } }>("/api/notify/audience", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const f = req.body ?? {};
      const w: string[] = ["p.archived_at IS NULL", "NOT p.is_deceased"];
      const v: unknown[] = [];

      if (f.person_ids?.length) { v.push(f.person_ids); w.push(`p.id = ANY($${v.length}::uuid[])`); }
      if (f.stage)    { v.push(f.stage);    w.push(`js.key = $${v.length}`); }
      if (f.group_id) {
        v.push(f.group_id);
        // includes everyone BENEATH the group, not just those pinned to it
        w.push(`(p.home_group_id IN (
                  WITH RECURSIVE sub AS (
                    SELECT id FROM groups WHERE id = $${v.length}
                    UNION ALL SELECT g.id FROM groups g JOIN sub ON g.parent_id = sub.id)
                  SELECT id FROM sub))`);
      }
      if (f.service)  { v.push(f.service);  w.push(`p.usual_service = $${v.length}`); }
      if (f.q) {
        v.push(`%${f.q}%`);
        w.push(`(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) ILIKE $${v.length}`);
      }
      if (f.has_email)  w.push(`p.email IS NOT NULL`);
      if (f.has_phone)  w.push(`coalesce(p.phone, p.phone_2) IS NOT NULL`);
      if (f.no_group)   w.push(`p.home_group_id IS NULL`);
      if (f.never_attended) w.push(`p.last_attended_at IS NULL`);
      if (f.at_risk_weeks) {
        v.push(f.at_risk_weeks);
        w.push(`p.last_attended_at IS NOT NULL
                AND p.last_attended_at < now() - ($${v.length} * interval '7 days')`);
      }

      const { rows } = await tx.query(
        `SELECT p.id,
                trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
                p.phone, p.phone_2, p.email::text AS email,
                js.label AS stage, g.name AS group_name, p.usual_service,
                p.last_attended_at,
                p.is_deceased,
                coalesce(c.status,'granted')  <> 'revoked' AS sms_ok,
                coalesce(ce.status,'granted') <> 'revoked' AS email_ok,
                d.is_dnd
           FROM persons p
           LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
           LEFT JOIN groups g          ON g.id  = p.home_group_id
           LEFT JOIN consents c        ON c.person_id = p.id AND c.channel='sms'
           LEFT JOIN consents ce       ON ce.person_id = p.id AND ce.channel='email'
           LEFT JOIN dnd_status d      ON d.phone = coalesce(p.phone, p.phone_2)
          WHERE ${w.join(" AND ")}
          ORDER BY p.last_name NULLS LAST, p.first_name
          LIMIT 2000`, v);

      // How each person would actually be reached — the pastor sees this per row.
      const people = rows.map((r: any) => {
        const email = !!r.email && r.email_ok;
        const phone = !!(r.phone || r.phone_2) && r.sms_ok;
        return {
          ...r,
          reach: email ? "email" : phone ? "sms" : "none",
          why: email ? null
             : !r.email && !r.phone && !r.phone_2 ? "No phone or email"
             : !r.sms_ok && !r.email_ok ? "Opted out"
             : !r.email && !phone ? "Opted out of SMS"
             : null,
        };
      });

      return {
        people,
        total: people.length,
        by_email: people.filter(p => p.reach === "email").length,
        by_sms:   people.filter(p => p.reach === "sms").length,
        unreachable: people.filter(p => p.reach === "none").length,
      };
    }));

  /** Compose. Nothing is sent — this shows the pastor exactly what WILL happen. */
  app.post<{ Body: { name: string; body: string; subject?: string;
                     channel?: "sms" | "email" | "cascade";
                     person_ids?: string[];
                     template_id?: string; ignore_quiet_hours?: boolean } }>(
    "/api/notify/prepare", staff, async (req) =>
      tenantTx(req, (tx) => n.prepare(tx, {
        name: req.body.name, body: req.body.body,
        subject: req.body.subject, channel: req.body.channel,
        personIds: req.body.person_ids, templateId: req.body.template_id ?? null,
        userId: req.auth!.userId, ignoreQuietHours: req.body.ignore_quiet_hours,
      })));

  /** Send. Charges the wallet and hands the queue to the worker. */
  app.post<{ Params: { id: string } }>("/api/notify/send/:id", admin, async (req, reply) => {
    try {
      return await tenantTx(req, (tx) => n.dispatch(tx, req.params.id));
    } catch (e: any) {
      return reply.code(400).send({ error: "cannot_send", detail: e.message });
    }
  });

  app.get("/api/notify/campaigns", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT c.*, u.full_name AS by_who FROM campaigns c
       LEFT JOIN app_users u ON u.id = c.created_by
       ORDER BY c.created_at DESC LIMIT 50`)).rows));

  /**
   * The message log — including everything we REFUSED to send, and why.
   * When a pastor says "she never got it", this is the answer.
   */
  app.get<{ Querystring: { campaign_id?: string; status?: string } }>(
    "/api/notify/messages", auth, async (req) =>
      tenantTx(req, async (tx) => {
        const w: string[] = [], p: unknown[] = [];
        if (req.query.campaign_id) { p.push(req.query.campaign_id); w.push(`m.campaign_id = $${p.length}`); }
        if (req.query.status)      { p.push(req.query.status);      w.push(`m.status = $${p.length}`); }
        return (await tx.query(
          `SELECT m.id, m.to_address, m.body, m.units, m.encoding, m.route, m.status,
                  m.suppressed_by, m.error, m.queued_at, m.sent_at,
                  trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name
             FROM messages m LEFT JOIN persons p ON p.id = m.person_id
            ${w.length ? "WHERE " + w.join(" AND ") : ""}
            ORDER BY m.queued_at DESC LIMIT 300`, p)).rows;
      }));

  app.get("/api/notify/status", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const s = await n.senderFor(tx);
      const w = await tx.query(
        `SELECT balance FROM credit_wallets
          WHERE tenant_id = current_tenant_id() AND credit_type = 'sms'`);
      // How many members can we reach for free? This is the number that
      // decides whether a church can afford to communicate at all.
      const reach = await tx.query(`
        SELECT count(*) FILTER (WHERE email IS NOT NULL) AS with_email,
               count(*) FILTER (WHERE email IS NULL
                                AND coalesce(phone, phone_2) IS NOT NULL) AS sms_only,
               count(*) FILTER (WHERE email IS NULL
                                AND phone IS NULL AND phone_2 IS NULL) AS unreachable,
               count(*) AS total
          FROM persons WHERE archived_at IS NULL AND NOT is_deceased`);

      return {
        provider: provider().name,
        live: provider().name !== "dry-run",
        sender_id: s.id,
        dnd_route: s.dnd,
        sms_balance: w.rows[0] ? Number(w.rows[0].balance) : 0,
        email_provider: emailProvider().name,
        email_live: emailProvider().name !== "dry-run",
        with_email:  Number(reach.rows[0].with_email),
        sms_only:    Number(reach.rows[0].sms_only),
        unreachable: Number(reach.rows[0].unreachable),
        total:       Number(reach.rows[0].total),
      };
    }));

  /**
   * Send ONE message to ONE number, right now. Bypasses the segment, not the
   * safety layer — consent, DND routing and the counter still apply.
   *
   * This is the first thing you do when a sender ID goes live: send to your own
   * phone and see it arrive. Never test a gateway on a congregation.
   */
  app.post<{ Body: { to: string; body: string } }>(
    "/api/notify/test", admin, async (req, reply) => {
      const p = provider();
      const raw = (req.body.to || "").replace(/[^\d+]/g, "");
      const e164 = raw.startsWith("+") ? raw
                 : raw.startsWith("234") ? "+" + raw
                 : raw.startsWith("0") ? "+234" + raw.slice(1)
                 : "+234" + raw;

      const body = toGsm7(req.body.body || "");
      const k = count(body);

      return tenantTx(req, async (tx) => {
        const sender = await n.senderFor(tx);
        if (!sender.id)
          return reply.code(400).send({ error: "no_sender_id",
            detail: "Register a sender ID first. A church sends as DOMINION, not as a number." });

        // Even a test respects the DND reality — otherwise the test lies to you.
        let route: "generic" | "dnd" = sender.dnd ? "dnd" : "generic";
        let dnd: boolean | undefined;
        if (p.checkDnd) {
          const s = await p.checkDnd(e164);
          dnd = s.isDnd;
          if (s.isDnd && !sender.dnd) {
            return reply.code(400).send({ error: "dnd_no_route",
              detail: `${e164} is on the DND register. The generic route cannot reach it at all. `
                    + `Ask your provider to activate the DND route and whitelist ${sender.id}.` });
          }
        }

        const r = await p.send(e164, sender.id, body, route);

        const m = await tx.query(
          `INSERT INTO messages (tenant_id, channel, to_address, sender_id, body, units,
             encoding, route, status, provider, provider_id, error, sent_at)
           VALUES (current_tenant_id(),'sms',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           RETURNING id`,
          [e164, sender.id, body, k.units, k.encoding, route,
           r.ok ? "sent" : "failed", p.name, r.providerId ?? null, r.error ?? null]);

        return {
          ok: r.ok, to: e164, sender_id: sender.id, route,
          on_dnd_register: dnd,
          encoding: k.encoding, units: k.units,
          provider: p.name, provider_id: r.providerId,
          balance: r.balance,
          error: r.error,
          message_id: m.rows[0].id,
        };
      });
    });

  /** Inbound STOP webhook. Instant, final, and it writes a consent event. */
  app.post<{ Body: { from?: string; sender?: string; message?: string; sms?: string } }>(
    "/api/notify/inbound", async (req, reply) => {
      const from = req.body.from ?? req.body.sender;
      const text = (req.body.message ?? req.body.sms ?? "").trim().toUpperCase();
      if (from && /^(STOP|UNSUBSCRIBE|CANCEL|QUIT|END)$/.test(text)) {
        const e164 = from.startsWith("+") ? from : "+" + from;
        await n.handleStop(e164);
      }
      reply.send({ ok: true });
    });
}
