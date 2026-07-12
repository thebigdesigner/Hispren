/**
 * Member CRM — HTTP layer.
 * Every handler runs inside tenantTx(), so RLS is underneath every query.
 */
import { FastifyInstance } from "fastify";
import Papa from "papaparse";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as svc from "./service";
import { guessColumnMap, validateRows, commitImport, revertImport } from "./import";

export function registerMemberRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };
  const pastor = { preHandler: [authenticate, requireRole("pastor")] };

  // ---- list / search -----------------------------------------------------
  app.get<{ Querystring: svc.MemberQuery }>("/api/members", auth, async (req) =>
    tenantTx(req, (tx) => svc.listMembers(tx, {
      ...req.query,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    })));

  app.get<{ Params: { id: string } }>("/api/members/:id", auth, async (req, reply) => {
    const m = await tenantTx(req, (tx) => svc.getMember(tx, req.params.id));
    return m ?? reply.code(404).send({ error: "not_found" });
  });

  // ---- create / update / archive ------------------------------------------
  app.post<{ Body: svc.MemberInput }>("/api/members", staff, async (req, reply) => {
    const m = await tenantTx(req, (tx) =>
      svc.createMember(tx, req.body, req.auth!.userId));
    reply.code(201).send(m);
  });

  app.patch<{ Params: { id: string }; Body: svc.MemberInput }>(
    "/api/members/:id", staff, async (req, reply) => {
      const m = await tenantTx(req, (tx) =>
        svc.updateMember(tx, req.params.id, req.body, req.auth!.userId));
      return m ?? reply.code(404).send({ error: "not_found" });
    });

  app.delete<{ Params: { id: string } }>("/api/members/:id",
    { preHandler: [authenticate, requireRole("admin")] }, async (req, reply) => {
      const r = await tenantTx(req, (tx) => svc.archiveMember(tx, req.params.id));
      return r ? { archived: true } : reply.code(404).send({ error: "not_found" });
    });

  // ---- QR identity ---------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/members/:id/qr", auth, async (req, reply) => {
    const q = await tenantTx(req, (tx) => svc.getQr(tx, req.params.id));
    return q ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/members/:id/qr/rotate", staff, async (req) =>
    tenantTx(req, (tx) => svc.rotateQr(tx, req.params.id)));

  // Scanner lookup. Attendance is 1.7 scans/sec at a 3,000-member church —
  // this must be one indexed hit and nothing else.
  app.get<{ Params: { token: string } }>("/api/scan/:token", auth, async (req, reply) => {
    const p = await tenantTx(req, (tx) => svc.findByQrToken(tx, req.params.token));
    return p ?? reply.code(404).send({ error: "unknown_code" });
  });

  // ---- households ----------------------------------------------------------
  app.post<{ Body: { name: string; address?: string; area?: string } }>(
    "/api/households", staff, async (req, reply) => {
      const h = await tenantTx(req, (tx) =>
        svc.createHousehold(tx, req.body.name, req.body.address, req.body.area));
      reply.code(201).send(h);
    });

  app.get<{ Params: { id: string } }>("/api/households/:id", auth, async (req, reply) => {
    const h = await tenantTx(req, (tx) => svc.getHousehold(tx, req.params.id));
    return h ?? reply.code(404).send({ error: "not_found" });
  });

  // ---- HEALTH DATA — pastor/admin only, every access audited ---------------
  app.get<{ Params: { id: string } }>("/api/members/:id/health", pastor, async (req, reply) => {
    const h = await tenantTx(req, (tx) =>
      svc.getHealth(tx, req.params.id, req.auth!.userId));
    return h ?? reply.code(404).send({ error: "no_health_record" });
  });

  app.put<{ Params: { id: string };
            Body: { blood_group?: string; genotype?: string; consent_given: boolean } }>(
    "/api/members/:id/health", pastor, async (req, reply) => {
      try {
        return await tenantTx(req, (tx) =>
          svc.setHealth(tx, req.params.id, req.auth!.userId, req.body));
      } catch (e: any) {
        if (e.message === "consent_required")
          return reply.code(400).send({ error: "consent_required",
            detail: "Health data cannot be stored without the member's explicit consent." });
        if (e.message === "health_data_not_enabled")
          return reply.code(403).send({ error: "health_data_not_enabled",
            detail: "This church has not enabled health data collection." });
        throw e;
      }
    });

  // ---- duplicates ----------------------------------------------------------
  app.get("/api/duplicates", staff, async (req) =>
    tenantTx(req, (tx) => svc.listDuplicates(tx)));

  app.post<{ Body: { keep_id: string; merge_id: string } }>(
    "/api/duplicates/merge",
    { preHandler: [authenticate, requireRole("admin")] },
    async (req) => tenantTx(req, (tx) =>
      svc.mergeMembers(tx, req.body.keep_id, req.body.merge_id, req.auth!.userId)));

  app.post<{ Params: { id: string } }>("/api/duplicates/:id/dismiss", staff, async (req) =>
    tenantTx(req, (tx) => svc.dismissDuplicate(tx, req.params.id, req.auth!.userId)));

  // ---- bulk import: PREVIEW, then COMMIT ----------------------------------
  app.post<{ Body: { filename: string; csv: string } }>(
    "/api/import/preview",
    { preHandler: [authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = Papa.parse<Record<string, string>>(req.body.csv, {
        header: true, skipEmptyLines: true,
      });
      if (!parsed.meta.fields?.length)
        return reply.code(400).send({ error: "no_headers" });

      const map = guessColumnMap(parsed.meta.fields);
      const results = validateRows(parsed.data, map);
      const valid = results.filter((r) => r.data).length;
      const errored = results.length - valid;

      const batch = await tenantTx(req, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO import_batches (tenant_id, filename, column_map,
              total_rows, valid_rows, error_rows, errors, created_by)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [req.body.filename, JSON.stringify(map), results.length, valid, errored,
           JSON.stringify(results.filter((r) => r.errors.length || r.warnings.length)
                                 .slice(0, 200)),
           req.auth!.userId]);
        return rows[0];
      });

      return {
        batch_id: batch.id,
        column_map: map,
        unmapped_columns: parsed.meta.fields.filter((f) => !map[f]),
        total: results.length,
        valid,
        errors: errored,
        preview: results.slice(0, 20),
      };
    });

  app.post<{ Body: { batch_id: string; csv: string; column_map: Record<string, string> } }>(
    "/api/import/commit",
    { preHandler: [authenticate, requireRole("admin")] },
    async (req) => {
      const parsed = Papa.parse<Record<string, string>>(req.body.csv, {
        header: true, skipEmptyLines: true,
      });
      const results = validateRows(parsed.data, req.body.column_map);
      const imported = await tenantTx(req, (tx) =>
        commitImport(tx, req.body.batch_id, results, req.auth!.userId));
      return { imported, skipped: results.length - imported };
    });

  app.post<{ Params: { id: string } }>("/api/import/:id/revert",
    { preHandler: [authenticate, requireRole("admin")] },
    async (req) => {
      const n = await tenantTx(req, (tx) => revertImport(tx, req.params.id));
      return { reverted: n };
    });
}
