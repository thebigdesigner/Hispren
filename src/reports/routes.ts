/**
 * Reports. Four questions a pastor actually asks:
 *   Is attendance growing?
 *   Are first-timers becoming members?
 *   Who has stopped coming?
 *   Which service is carrying the church?
 */
import { FastifyInstance } from "fastify";
import { authenticate, tenantTx } from "../platform/auth";

export function registerReportRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.get<{ Querystring: { weeks?: string } }>("/api/reports/trend", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM attendance_trend($1)`, [Number(req.query.weeks ?? 12)]);
      return rows;
    }));

  app.get<{ Querystring: { months?: string } }>("/api/reports/growth", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM growth_by_month($1)`, [Number(req.query.months ?? 12)]);
      return rows;
    }));

  app.get("/api/reports/funnel", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(`SELECT * FROM funnel()`)).rows));

  /**
   * At risk: they DID come, then stopped. A visitor who never returned is not
   * "at risk" — they were never ours. This distinction is the whole feature.
   */
  app.get<{ Querystring: { weeks?: string } }>("/api/reports/at-risk", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM at_risk($1)`, [Number(req.query.weeks ?? 3)]);
      return rows;
    }));
}
