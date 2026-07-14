import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as A from "./service";
import { runDue } from "./runner";
import { consumeOutbox, sweepAbsence, sweepDates, sweepChanges, sweepSchedules,
  sweepThresholds } from "./triggers";

export function registerAutomationRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const admin = { preHandler: [authenticate, requireRole("admin")] };

  app.get("/api/automations", auth, async (req) =>
    tenantTx(req, async (tx) => ({
      workflows: await A.workflows(tx),
      library:   A.LIBRARY,
      triggers:  A.TRIGGERS,
      actions:   A.ACTIONS,
    })));

  app.get<{ Params: { id: string } }>("/api/automations/:id", auth, async (req, reply) => {
    const w = await tenantTx(req, (tx) => A.getWorkflow(tx, req.params.id));
    return w ?? reply.code(404).send({ error: "not_found" });
  });

  /** Build one from nothing. It arrives as a DRAFT. */
  app.post<{ Body: any }>("/api/automations", admin, async (req, reply) => {
    const b = req.body as any;
    const w = await tenantTx(req, async (tx) => (await tx.query(
      `INSERT INTO workflows (tenant_id, name, description, trigger_type,
          trigger_config, allow_reenrollment, reenroll_after_days, status, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, 'draft', $7)
       RETURNING *`,
      [b.name || "New automation", b.description ?? null,
       b.trigger_type || "event", JSON.stringify(b.trigger_config ?? {}),
       !!b.allow_reenrollment, b.reenroll_after_days ?? null,
       req.auth!.userId])).rows[0]);
    reply.code(201).send(w);
  });

  /** Install a recipe. It arrives as a DRAFT — it does not fire until she says so. */
  app.post<{ Body: { recipe: string } }>(
    "/api/automations/recipe", admin, async (req, reply) => {
      try {
        const w = await tenantTx(req, (tx) =>
          A.useRecipe(tx, req.body.recipe, req.auth!.userId));
        reply.code(201).send(w);
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_use", detail: e.message });
      }
    });

  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/automations/:id", admin, async (req, reply) => {
      const w = await tenantTx(req, (tx) =>
        A.updateWorkflow(tx, req.params.id, req.body as any));
      return w ?? reply.code(404).send({ error: "not_found" });
    });

  app.put<{ Params: { id: string }; Body: { steps: any[] } }>(
    "/api/automations/:id/steps", admin, async (req) =>
      tenantTx(req, (tx) => A.saveSteps(tx, req.params.id, (req.body as any).steps ?? [])));

  app.post<{ Params: { id: string }; Body: { status: string } }>(
    "/api/automations/:id/status", admin, async (req, reply) => {
      try {
        return await tenantTx(req, (tx) =>
          A.setStatus(tx, req.params.id, (req.body as any).status));
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_change", detail: e.message });
      }
    });

  app.delete<{ Params: { id: string } }>("/api/automations/:id", admin, async (req, reply) => {
    const r = await tenantTx(req, (tx) => A.archiveWorkflow(tx, req.params.id));
    return r ? { archived: true } : reply.code(404).send({ error: "not_found" });
  });

  /**
   * TEST MODE. Nothing is sent. Nothing is created.
   * It answers one question: "if I turn this on right now, what happens?"
   */
  app.get<{ Params: { id: string } }>("/api/automations/:id/test", admin, async (req, reply) => {
    try { return await tenantTx(req, (tx) => A.dryRun(tx, req.params.id)); }
    catch (e: any) { return reply.code(400).send({ error: "cannot_test", detail: e.message }); }
  });

  /** Run it against ONE person, for real. */
  app.post<{ Params: { id: string }; Body: { person_id: string } }>(
    "/api/automations/:id/test-once", admin, async (req, reply) => {
      try {
        return await tenantTx(req, (tx) =>
          A.testOnce(tx, req.params.id, (req.body as any).person_id, req.auth!.tenantId));
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_test", detail: e.message });
      }
    });

  /** Every step that ran — and every step we REFUSED to run, with the reason. */
  app.get<{ Querystring: { workflow_id?: string } }>(
    "/api/automations/log", auth, async (req) =>
      tenantTx(req, (tx) => A.runLog(tx, req.query.workflow_id)));

  /** Force a sweep. Should never be needed. Useful when it is. */
  app.post("/api/automations/sweep", admin, async () => {
    const events  = await consumeOutbox(200);
    const changes = await sweepChanges();
    const absence = await sweepAbsence();
    const dates    = await sweepDates();
    const schedule = await sweepSchedules();
    const threshold = await sweepThresholds();
    const ran      = await runDue(200);
    return { ...events, changes, absence, dates, schedule, threshold, steps_run: ran };
  });
}
