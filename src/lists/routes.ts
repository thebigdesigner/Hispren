import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as L from "./service";

export function registerListRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };

  /** Smart lists, with live counts. The Monday-morning questions. */
  app.get("/api/lists/smart", auth, async (req) =>
    tenantTx(req, (tx) => L.smartCounts(tx)));

  app.get<{ Params: { key: string } }>("/api/lists/smart/:key", auth, async (req, reply) => {
    try { return await tenantTx(req, (tx) => L.runSmart(tx, req.params.key)); }
    catch (e: any) { return reply.code(404).send({ error: "no_such_list", detail: e.message }); }
  });

  app.get("/api/lists", auth, async (req) => tenantTx(req, (tx) => L.listSaved(tx)));

  app.get<{ Params: { id: string } }>("/api/lists/:id", auth, async (req, reply) => {
    const l = await tenantTx(req, (tx) => L.getSaved(tx, req.params.id));
    return l ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Body: { name: string; person_ids?: string[] } }>(
    "/api/lists", staff, async (req, reply) => {
      const l = await tenantTx(req, (tx) =>
        L.createSaved(tx, req.body.name, req.body.person_ids ?? []));
      reply.code(201).send(l);
    });

  app.post<{ Params: { id: string }; Body: { person_ids: string[] } }>(
    "/api/lists/:id/members", staff, async (req) =>
      tenantTx(req, (tx) => L.addToList(tx, req.params.id, req.body.person_ids)));

  app.delete<{ Params: { id: string; personId: string } }>(
    "/api/lists/:id/members/:personId", staff, async (req) =>
      tenantTx(req, (tx) => L.removeFromList(tx, req.params.id, req.params.personId)));

  app.delete<{ Params: { id: string } }>("/api/lists/:id", staff, async (req, reply) => {
    const r = await tenantTx(req, (tx) => L.archiveList(tx, req.params.id));
    return r ? { archived: true } : reply.code(404).send({ error: "not_found" });
  });
}
