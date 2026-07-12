import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as c from "./service";

export function registerCareRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };

  // ---- tasks --------------------------------------------------------------
  app.get<{ Querystring: { status?: string; mine?: string } }>(
    "/api/tasks", auth, async (req) =>
      tenantTx(req, (tx) => c.listTasks(tx, { ...(req.query as any), userId: req.auth!.userId })));

  app.post<{ Body: any }>("/api/tasks", staff, async (req, reply) => {
    const t = await tenantTx(req, (tx) => c.createTask(tx, req.body as any));
    reply.code(201).send(t);
  });

  app.patch<{ Params: { id: string }; Body: any }>("/api/tasks/:id", staff, async (req, reply) => {
    const t = await tenantTx(req, (tx) => c.updateTask(tx, req.params.id, req.body as any));
    return t ?? reply.code(404).send({ error: "not_found" });
  });

  /** Sweep every uncontacted first-timer into an owned, dated task. */
  app.post("/api/tasks/generate", staff, async (req) =>
    tenantTx(req, (tx) => c.generateFollowUps(tx)));

  // ---- pastoral care ------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>("/api/care", auth, async (req) =>
    tenantTx(req, (tx) => c.listCare(tx, req.query.status)));

  app.post<{ Body: any }>("/api/care", staff, async (req, reply) => {
    const r = await tenantTx(req, (tx) => c.createCare(tx, req.body as any));
    reply.code(201).send(r);
  });

  app.patch<{ Params: { id: string }; Body: any }>("/api/care/:id", staff, async (req, reply) => {
    const r = await tenantTx(req, (tx) => c.updateCare(tx, req.params.id, req.body as any));
    return r ?? reply.code(404).send({ error: "not_found" });
  });

  // ---- households ---------------------------------------------------------

  // ---- the users a task can be assigned to --------------------------------
  app.get("/api/users", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT u.id, u.full_name, u.email, m.role
         FROM tenant_memberships m JOIN app_users u ON u.id = m.user_id
        WHERE m.tenant_id = current_tenant_id() ORDER BY u.full_name`)).rows));
}
