import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as n from "./service";
import { platformQuery } from "../platform/db";

export function registerNotifyRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };
  const admin = { preHandler: [authenticate, requireRole("admin")] };

  // ---- the character counter. Live, in the composer, BEFORE they send. -----
  app.post<{ Body: { body: string } }>("/api/notify/count", auth, async (req) =>
    n.countSms(req.body.body ?? ""));

  // ---- templates ----------------------------------------------------------
  app.get("/api/notify/templates", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT * FROM message_templates WHERE archived_at IS NULL ORDER BY kind, name`)).rows));

  app.post<{ Body: any }>("/api/notify/templates", staff, async (req, reply) => {
    const t = await tenantTx(req, async (tx) => (await tx.query(
      `INSERT INTO message_templates (tenant_id, name, channel, kind, subject, body)
       VALUES (current_tenant_id(),$1,$2,$3,$4,$5) RETURNING *`,
      [req.body.name, req.body.channel ?? "sms", req.body.kind ?? "custom",
       req.body.subject ?? null, req.body.body])).rows[0]);
    reply.code(201).send(t);
  });

  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/notify/templates/:id", staff, async (req) =>
      tenantTx(req, async (tx) => (await tx.query(
        `UPDATE message_templates SET name=coalesce($2,name), body=coalesce($3,body),
                subject=coalesce($4,subject) WHERE id=$1 RETURNING *`,
        [req.params.id, req.body.name, req.body.body, req.body.subject])).rows[0]));

  // ---- segments -----------------------------------------------------------
  app.get("/api/notify/segments", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT s.*, (SELECT count(*)::int FROM eval_segment(s.id)) AS people
         FROM segments s WHERE s.archived_at IS NULL ORDER BY s.name`)).rows));

  app.post<{ Body: { name: string; filter: any } }>(
    "/api/notify/segments", staff, async (req, reply) => {
      const s = await tenantTx(req, async (tx) => (await tx.query(
        `INSERT INTO segments (tenant_id, name, kind, filter)
         VALUES (current_tenant_id(),$1,'dynamic',$2) RETURNING *`,
        [req.body.name, JSON.stringify(req.body.filter ?? {})])).rows[0]);
      reply.code(201).send(s);
    });

  app.delete<{ Params: { id: string } }>("/api/notify/segments/:id", staff, async (req) =>
    tenantTx(req, async (tx) => {
      await tx.query(`UPDATE segments SET archived_at=now() WHERE id=$1`, [req.params.id]);
      return { archived: true };
    }));

  // ---- compose: screen everyone and cost it BEFORE anything is sent --------
  app.post<{ Body: any }>("/api/notify/compose", staff, async (req, reply) => {
    try {
      return await tenantTx(req, (tx) =>
        n.compose(tx, { ...req.body, userId: req.auth!.userId }));
    } catch (e: any) {
      return reply.code(400).send({ error: "compose_failed", detail: e.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/notify/send/:id", admin, async (req, reply) => {
    try {
      const r = await tenantTx(req, (tx) => n.send(tx, req.params.id));
      // The worker picks it up from the outbox. If no worker is running, deliver
      // inline — a church with one Railway service must still be able to send.
      n.deliver(req.params.id).catch(() => {});
      return r;
    } catch (e: any) {
      if (e.message === "not_enough_sms_credit")
        return reply.code(402).send({ error: "no_credit",
          detail: "Not enough SMS credit. Top up before sending." });
      return reply.code(400).send({ error: "send_failed", detail: e.message });
    }
  });

  app.get("/api/notify/messages", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT m.*, s.name AS segment_name
         FROM messages m LEFT JOIN segments s ON s.id = m.segment_id
        ORDER BY m.created_at DESC LIMIT 50`)).rows));

  /** Why didn't Amaka get it? One word: consent / dnd / frequency_cap / ... */
  app.get<{ Params: { id: string } }>("/api/notify/messages/:id", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const m = (await tx.query(`SELECT * FROM messages WHERE id=$1`, [req.params.id])).rows[0];
      const r = (await tx.query(
        `SELECT r.*, trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name
           FROM message_recipients r JOIN persons p ON p.id=r.person_id
          WHERE r.message_id=$1 ORDER BY r.status, name`, [req.params.id])).rows;
      return { ...m, recipients: r };
    }));

  // ---- wallet -------------------------------------------------------------
  app.get("/api/notify/wallet", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT credit_type, balance FROM credit_wallets`)).rows));

  app.post<{ Body: { credit_type: string; amount: number } }>(
    "/api/notify/wallet/topup", admin, async (req) =>
      tenantTx(req, async (tx) => {
        await tx.query(
          `INSERT INTO credit_wallets (tenant_id, credit_type, balance)
           VALUES (current_tenant_id(),$1,$2)
           ON CONFLICT (tenant_id, credit_type) DO UPDATE
             SET balance = credit_wallets.balance + $2, updated_at = now()`,
          [req.body.credit_type, req.body.amount]);
        await tx.query(
          `INSERT INTO credit_ledger (tenant_id, credit_type, delta, reason)
           VALUES (current_tenant_id(),$1,$2,'topup')`,
          [req.body.credit_type, req.body.amount]);
        return (await tx.query(
          `SELECT balance FROM credit_wallets
            WHERE tenant_id=current_tenant_id() AND credit_type=$1`,
          [req.body.credit_type])).rows[0];
      }));

  // ---- consent (NDPR) — per person, per channel ---------------------------
  app.get<{ Params: { id: string } }>("/api/members/:id/consent", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT channel, status, updated_at FROM consents WHERE person_id = $1`,
      [req.params.id])).rows));

  app.put<{ Params: { id: string }; Body: { channel: string; granted: boolean } }>(
    "/api/members/:id/consent", staff, async (req) =>
      tenantTx(req, async (tx) => {
        const st = req.body.granted ? "granted" : "revoked";
        await tx.query(
          `INSERT INTO consents (tenant_id, person_id, channel, status)
           VALUES (current_tenant_id(),$1,$2,$3)
           ON CONFLICT (tenant_id, person_id, channel) DO UPDATE
             SET status=$3, updated_at=now()`,
          [req.params.id, req.body.channel, st]);
        // append-only trail. Under NDPR you must be able to show WHEN and HOW.
        await tx.query(
          `INSERT INTO consent_events (tenant_id, person_id, channel, action, source, actor_user)
           VALUES (current_tenant_id(),$1,$2,$3,'admin',$4)`,
          [req.params.id, req.body.channel, req.body.granted ? "granted" : "revoked",
           req.auth!.userId]);
        return { channel: req.body.channel, status: st };
      }));

  // ---- delivery webhook (public — the provider calls it) -------------------
  app.post<{ Body: any }>("/api/notify/webhook/:provider", async (req, reply) => {
    const b: any = req.body ?? {};
    const ref = b.message_id ?? b.id ?? b.messageId;
    const status = b.status ?? b.Status ?? b.event;
    if (ref) await n.receipt(String(ref), String(status ?? "")).catch(() => {});
    reply.send({ ok: true });
  });
}
