import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as g from "./service";

/**
 * Giving is money. Everything here is staff-or-above, and approving an expense
 * is admin-only — the person who records a payment must not be the person who
 * approves it.
 */
export function registerGivingRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate, requireRole("staff")] };
  const admin = { preHandler: [authenticate, requireRole("admin")] };

  app.get("/api/giving/funds", auth, async (req) => tenantTx(req, (tx) => g.funds(tx)));
  app.post<{ Body: any }>("/api/giving/funds", admin, async (req, reply) => {
    const f = await tenantTx(req, (tx) => g.createFund(tx, req.body as any));
    reply.code(201).send(f);
  });

  app.get("/api/giving/batches", auth, async (req) => tenantTx(req, (tx) => g.batches(tx)));

  app.get<{ Params: { id: string } }>("/api/giving/batches/:id", auth, async (req, reply) => {
    const b = await tenantTx(req, (tx) => g.getBatch(tx, req.params.id));
    return b ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Body: any }>("/api/giving/batches", auth, async (req, reply) => {
    const b = await tenantTx(req, (tx) => g.openBatch(tx, req.body as any, req.auth!.userId));
    reply.code(201).send(b);
  });

  app.post<{ Params: { id: string }; Body: any }>(
    "/api/giving/batches/:id/entries", auth, async (req, reply) => {
      try {
        const c = await tenantTx(req, (tx) =>
          g.addContribution(tx, req.params.id, req.body as any, req.auth!.userId));
        reply.code(201).send(c);
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_add", detail: e.message });
      }
    });

  app.delete<{ Params: { id: string } }>(
    "/api/giving/entries/:id", auth, async (req, reply) => {
      try {
        const r = await tenantTx(req, (tx) => g.removeContribution(tx, req.params.id));
        return r ?? reply.code(404).send({ error: "not_found" });
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_remove", detail: e.message });
      }
    });

  app.post<{ Params: { id: string } }>(
    "/api/giving/batches/:id/close", auth, async (req, reply) => {
      try { return await tenantTx(req, (tx) => g.closeBatch(tx, req.params.id)); }
      catch (e: any) { return reply.code(400).send({ error: "cannot_close", detail: e.message }); }
    });

  // ---- expenses ------------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>("/api/giving/expenses", auth, async (req) =>
    tenantTx(req, (tx) => g.expenses(tx, req.query.status)));

  /**
   * The restricted-fund guard lives in the DATABASE, not here. If this throws,
   * it is because Postgres refused the transaction — not because a check in
   * TypeScript happened to run. That distinction is the whole point.
   */
  app.post<{ Body: any }>("/api/giving/expenses", auth, async (req, reply) => {
    try {
      const e = await tenantTx(req, (tx) =>
        g.addExpense(tx, req.body as any, req.auth!.userId));
      reply.code(201).send(e);
    } catch (e: any) {
      return reply.code(400).send({ error: "refused", detail: e.message });
    }
  });

  /** Approving is ADMIN. Whoever records a payment must not approve it. */
  app.post<{ Params: { id: string }; Body: { approve: boolean } }>(
    "/api/giving/expenses/:id/approve", admin, async (req, reply) => {
      try {
        const e = await tenantTx(req, (tx) =>
          g.approveExpense(tx, req.params.id, req.auth!.userId, req.body.approve !== false));
        return e ?? reply.code(404).send({ error: "not_found" });
      } catch (e: any) {
        return reply.code(400).send({ error: "refused", detail: e.message });
      }
    });

  // ---- reports -------------------------------------------------------------
  app.get<{ Querystring: { months?: string } }>("/api/giving/by-month", auth, async (req) =>
    tenantTx(req, (tx) => g.byMonth(tx, Number(req.query.months ?? 12))));

  app.get("/api/giving/top", auth, async (req) => tenantTx(req, (tx) => g.topGivers(tx)));

  app.get("/api/giving/pledges", auth, async (req) => tenantTx(req, (tx) => g.pledges(tx)));

  app.post<{ Body: any }>("/api/giving/pledges", auth, async (req, reply) => {
    const p = await tenantTx(req, (tx) => g.addPledge(tx, req.body as any));
    reply.code(201).send(p);
  });

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/giving/income", auth, async (req) => {
      const yr = new Date().getFullYear();
      return tenantTx(req, (tx) => g.income(tx,
        req.query.from ?? `${yr}-01-01`, req.query.to ?? `${yr}-12-31`));
    });

  app.get<{ Params: { id: string }; Querystring: { year?: string } }>(
    "/api/giving/statement/:id", auth, async (req) =>
      tenantTx(req, (tx) => g.statement(tx, req.params.id,
        Number(req.query.year ?? new Date().getFullYear()))));
}
