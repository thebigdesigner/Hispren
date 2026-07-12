import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as ex from "./service";

/**
 * Exports are ADMIN-only and every one is audited.
 * Downloading a congregation's phone numbers is a security event.
 */
export function registerExportRoutes(app: FastifyInstance) {
  const admin = { preHandler: [authenticate, requireRole("admin")] };

  function send(reply: any, name: string, body: string) {
    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="hispren-${name}-${stamp}.csv"`)
      .send(body);
  }

  app.get("/api/export/members.csv", admin, async (req, reply) =>
    send(reply, "members", await tenantTx(req, (tx) =>
      ex.exportMembers(tx, req.auth!.userId))));

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/export/attendance.csv", admin, async (req, reply) =>
      send(reply, "attendance", await tenantTx(req, (tx) =>
        ex.exportAttendance(tx, req.auth!.userId, req.query.from, req.query.to))));

  app.get("/api/export/attendance-summary.csv", admin, async (req, reply) =>
    send(reply, "attendance-summary", await tenantTx(req, (tx) =>
      ex.exportAttendanceSummary(tx, req.auth!.userId))));

  app.get("/api/export/groups.csv", admin, async (req, reply) =>
    send(reply, "groups", await tenantTx(req, (tx) =>
      ex.exportGroups(tx, req.auth!.userId))));

  app.get("/api/export/audit.csv", admin, async (req, reply) =>
    send(reply, "audit", await tenantTx(req, (tx) =>
      ex.exportAudit(tx, req.auth!.userId))));
}
