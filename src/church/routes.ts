import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as ch from "./service";

export function registerChurchRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };
  const admin = { preHandler: [authenticate, requireRole("admin")] };

  // ---- groups --------------------------------------------------------------
  app.get("/api/church/groups", auth, async (req) =>
    tenantTx(req, (tx) => ch.groupTree(tx)));

  app.get<{ Params: { id: string } }>("/api/church/groups/:id", auth, async (req, reply) => {
    const g = await tenantTx(req, (tx) => ch.getGroup(tx, req.params.id));
    return g ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Body: ch.GroupInput }>("/api/church/groups", staff, async (req, reply) => {
    const g = await tenantTx(req, (tx) => ch.createGroup(tx, req.body));
    reply.code(201).send(g);
  });

  app.patch<{ Params: { id: string }; Body: Partial<ch.GroupInput> }>(
    "/api/church/groups/:id", staff, async (req, reply) => {
      try {
        const g = await tenantTx(req, (tx) => ch.updateGroup(tx, req.params.id, req.body));
        return g ?? reply.code(404).send({ error: "not_found" });
      } catch (e: any) {
        if (/cycle/i.test(e.message))
          return reply.code(400).send({ error: "cycle",
            detail: "A group cannot sit inside one of its own branches." });
        throw e;
      }
    });

  app.delete<{ Params: { id: string } }>("/api/church/groups/:id", admin, async (req, reply) => {
    const r = await tenantTx(req, (tx) => ch.archiveGroup(tx, req.params.id));
    return r ? { archived: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string }; Body: { person_id: string; role?: string } }>(
    "/api/church/groups/:id/members", staff, async (req) =>
      tenantTx(req, (tx) => ch.addToGroup(tx, req.params.id, req.body.person_id, req.body.role)));

  app.delete<{ Params: { id: string; personId: string } }>(
    "/api/church/groups/:id/members/:personId", staff, async (req) =>
      tenantTx(req, (tx) => ch.removeFromGroup(tx, req.params.id, req.params.personId)));

  /** Every person id in a group AND everything beneath it — for messaging a cell. */
  app.get<{ Params: { id: string } }>("/api/church/groups/:id/people", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const { rows } = await tx.query(`
        WITH RECURSIVE sub AS (
          SELECT id FROM groups WHERE id = $1
          UNION ALL
          SELECT g.id FROM groups g JOIN sub ON g.parent_id = sub.id
        )
        SELECT DISTINCT p.id,
               trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name
          FROM persons p
          LEFT JOIN group_memberships gm
                 ON gm.person_id = p.id AND gm.left_at IS NULL
         WHERE p.archived_at IS NULL
           AND (p.home_group_id IN (SELECT id FROM sub)
                OR gm.group_id   IN (SELECT id FROM sub))`, [req.params.id]);
      return rows;
    }));

  // ---- calendar: recurring services AND one-off events ----------------------
  app.get("/api/church/calendar", auth, async (req) =>
    tenantTx(req, (tx) => ch.listCalendar(tx)));

  app.post<{ Body: ch.ServiceInput }>("/api/church/calendar", staff, async (req, reply) => {
    try {
      const s = await tenantTx(req, (tx) => ch.createService(tx, req.body));
      reply.code(201).send(s);
    } catch (e: any) {
      return reply.code(400).send({ error: "invalid", detail: e.message });
    }
  });

  app.patch<{ Params: { id: string }; Body: Partial<ch.ServiceInput> }>(
    "/api/church/calendar/:id", staff, async (req, reply) => {
      const s = await tenantTx(req, (tx) => ch.updateService(tx, req.params.id, req.body));
      return s ?? reply.code(404).send({ error: "not_found" });
    });

  app.delete<{ Params: { id: string } }>("/api/church/calendar/:id", admin, async (req, reply) => {
    const r = await tenantTx(req, (tx) => ch.archiveService(tx, req.params.id));
    return r ? { archived: true } : reply.code(404).send({ error: "not_found" });
  });

  // ---- households ----------------------------------------------------------
  app.get("/api/church/households", auth, async (req) =>
    tenantTx(req, (tx) => ch.listHouseholds(tx)));

  app.post<{ Params: { id: string }; Body: { person_id: string; role: string } }>(
    "/api/church/households/:id/members", staff, async (req) =>
      tenantTx(req, (tx) =>
        ch.addToHousehold(tx, req.params.id, req.body.person_id, req.body.role)));

  app.delete<{ Params: { personId: string } }>(
    "/api/church/households/members/:personId", staff, async (req) =>
      tenantTx(req, (tx) => ch.removeFromHousehold(tx, req.params.personId)));

  // ---- custom fields -------------------------------------------------------
  app.get<{ Querystring: { entity?: string } }>("/api/church/fields", auth, async (req) =>
    tenantTx(req, (tx) => ch.listFields(tx, req.query.entity ?? "person")));

  app.post<{ Body: any }>("/api/church/fields", admin, async (req, reply) => {
    try {
      const f = await tenantTx(req, (tx) =>
        ch.createField(tx, { entity: "person", ...(req.body as any) }));
      reply.code(201).send(f);
    } catch (e: any) {
      return reply.code(400).send({ error: "invalid", detail: e.message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/church/fields/:id", admin, async (req, reply) => {
    const r = await tenantTx(req, (tx) => ch.archiveField(tx, req.params.id));
    return r ? { archived: true } : reply.code(404).send({ error: "not_found" });
  });

  // ---- what the church publishes to the member app -------------------------
  app.get("/api/announcements", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT * FROM announcements ORDER BY pinned DESC, publish_at DESC LIMIT 50`)).rows));

  app.post<{ Body: any }>("/api/announcements", staff, async (req, reply) => {
    const b = req.body as any;
    const a = await tenantTx(req, async (tx) => (await tx.query(
      `INSERT INTO announcements (tenant_id, title, body, pinned, expires_at, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING *`,
      [b.title, b.body, !!b.pinned, b.expires_at ?? null, req.auth!.userId])).rows[0]);
    reply.code(201).send(a);
  });

  app.delete<{ Params: { id: string } }>("/api/announcements/:id", staff, async (req) =>
    tenantTx(req, async (tx) => {
      await tx.query(`DELETE FROM announcements WHERE id = $1`, [req.params.id]);
      return { deleted: true };
    }));

  app.get("/api/sermons", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT * FROM sermons ORDER BY preached_on DESC LIMIT 50`)).rows));

  app.post<{ Body: any }>("/api/sermons", staff, async (req, reply) => {
    const b = req.body as any;
    const s = await tenantTx(req, async (tx) => (await tx.query(
      `INSERT INTO sermons (tenant_id, title, preacher, preached_on, scripture,
          summary, audio_url, video_url, notes_url)
       VALUES (current_tenant_id(), $1, $2, coalesce($3::date, CURRENT_DATE), $4, $5, $6, $7, $8)
       RETURNING *`,
      [b.title, b.preacher ?? null, b.preached_on ?? null, b.scripture ?? null,
       b.summary ?? null, b.audio_url ?? null, b.video_url ?? null,
       b.notes_url ?? null])).rows[0]);
    reply.code(201).send(s);
  });

  /**
   * Prayer requests. PRIVATE ones are pastor-only, and that is enforced here —
   * not by hiding a button in the UI.
   */
  app.get("/api/prayer", auth, async (req) =>
    tenantTx(req, async (tx) => {
      const pastoral = ["owner", "admin", "pastor"].includes(req.auth!.role);
      const { rows } = await tx.query(
        `SELECT r.*, trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name
           FROM prayer_requests r LEFT JOIN persons p ON p.id = r.person_id
          WHERE ($1::boolean OR r.is_private = false)
          ORDER BY r.status = 'open' DESC, r.created_at DESC LIMIT 100`,
        [pastoral]);
      return rows;
    }));

  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/prayer/:id", staff, async (req) =>
      tenantTx(req, async (tx) => {
        const b = req.body as any;
        const { rows } = await tx.query(
          `UPDATE prayer_requests SET status = coalesce($2, status),
                  answered_note = coalesce($3, answered_note), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [req.params.id, b.status ?? null, b.answered_note ?? null]);
        return rows[0];
      }));

  // ---- settings ------------------------------------------------------------
  app.get("/api/church/settings", auth, async (req) =>
    tenantTx(req, (tx) => ch.getSettings(tx)));

  app.patch<{ Body: any }>("/api/church/settings", admin, async (req) =>
    tenantTx(req, (tx) => ch.updateSettings(tx, req.body)));
}
