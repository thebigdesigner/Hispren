import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as att from "./service";

export function registerAttendanceRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };

  app.get("/api/services", auth, async (req) =>
    tenantTx(req, (tx) => att.listServices(tx)));

  app.post<{ Body: { service_id: string; date?: string } }>(
    "/api/attendance/session", staff, async (req) =>
      tenantTx(req, (tx) => att.openSession(
        tx, req.body.service_id,
        req.body.date ?? new Date().toISOString().slice(0, 10),
        req.auth!.userId)));

  app.post<{ Params: { id: string }; Body: { unregistered?: number } }>(
    "/api/attendance/session/:id/close", staff, async (req, reply) => {
      const s = await tenantTx(req, (tx) =>
        att.closeSession(tx, req.params.id, req.body?.unregistered ?? 0));
      return s ?? reply.code(404).send({ error: "not_found" });
    });

  app.get<{ Params: { id: string } }>("/api/attendance/session/:id", auth, async (req, reply) => {
    const s = await tenantTx(req, (tx) => att.sessionState(tx, req.params.id));
    return s ?? reply.code(404).send({ error: "not_found" });
  });

  app.get<{ Params: { id: string } }>("/api/attendance/session/:id/present", auth, async (req) =>
    tenantTx(req, (tx) => att.present(tx, req.params.id)));

  /**
   * The roster the scanner caches before losing signal.
   * Minimal by design — an usher's phone gets lost, and it must not contain
   * a congregation's addresses or health data.
   */
  app.get("/api/attendance/roster", staff, async (req) =>
    tenantTx(req, async (tx) => ({
      roster: await att.roster(tx),
      cached_at: new Date().toISOString(),
    })));

  /** Flush the offline queue. Idempotent — safe to retry the whole batch. */
  app.post<{ Body: { session_id: string; scans: att.Scan[] } }>(
    "/api/attendance/sync", staff, async (req) =>
      tenantTx(req, (tx) =>
        att.syncScans(tx, req.body.session_id, req.body.scans ?? [], req.auth!.userId)));

  app.get<{ Querystring: { date?: string } }>("/api/attendance/by-service", auth, async (req) =>
    tenantTx(req, (tx) =>
      att.byService(tx, req.query.date ?? new Date().toISOString().slice(0, 10))));

  // ---- MANUAL ENTRY --------------------------------------------------------
  // The scanner will fail. Someone forgets their phone, a QR smudges, an usher
  // taps the wrong Chinedu. Without a manual path the whole feature gets
  // abandoned the first Sunday it lets somebody down.

  /** The sheet an usher works from on a tablet: everyone, with a present flag. */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    "/api/attendance/session/:id/sheet", staff, async (req) =>
      tenantTx(req, (tx) => att.markSheet(tx, req.params.id, req.query.q)));

  app.post<{ Params: { id: string }; Body: { person_id: string } }>(
    "/api/attendance/session/:id/mark", staff, async (req) =>
      tenantTx(req, (tx) =>
        att.markPresent(tx, req.params.id, req.body.person_id, req.auth!.userId)));

  /** Undo. Logged — attendance is a record a church may be audited on. */
  app.delete<{ Params: { id: string; personId: string } }>(
    "/api/attendance/session/:id/mark/:personId", staff, async (req) =>
      tenantTx(req, (tx) =>
        att.unmark(tx, req.params.id, req.params.personId, req.auth!.userId)));

  /** Headcount for people who were never registered. Every church has them. */
  app.put<{ Params: { id: string }; Body: { count: number } }>(
    "/api/attendance/session/:id/unregistered", staff, async (req) =>
      tenantTx(req, (tx) => att.setUnregistered(tx, req.params.id, req.body.count)));

  app.get("/api/attendance/sessions", auth, async (req) =>
    tenantTx(req, (tx) => att.recentSessions(tx)));
}
