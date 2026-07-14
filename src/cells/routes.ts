import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";

/**
 * CELLS.
 *
 * A cell leader meets fifteen people in his sitting room on a Wednesday. On
 * Thursday he sends a WhatsApp to his zonal leader saying how many came. That
 * message IS the management system of most Nigerian churches, and it lives in a
 * chat thread nobody can query.
 *
 * To replace it, the report must be FASTER than that WhatsApp message. Three
 * numbers and a tap. If it takes more than fifteen seconds on a phone with bad
 * signal, he will keep using WhatsApp and this table stays empty forever.
 */
export function registerCellRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const staff = { preHandler: [authenticate, requireRole("staff")] };

  /** Every cell, and whether it has gone quiet. THE SIGNAL IS THE SILENCE. */
  app.get("/api/cells", auth, async (req) =>
    tenantTx(req, async (tx) => ({
      cells: (await tx.query(`SELECT * FROM cell_health()`)).rows,
      tree:  (await tx.query(`SELECT * FROM multiplication_tree()`)).rows,
    })));

  app.get<{ Params: { id: string } }>("/api/cells/:id/reports", auth, async (req) =>
    tenantTx(req, async (tx) => (await tx.query(
      `SELECT r.*, trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS reporter
         FROM cell_reports r LEFT JOIN persons p ON p.id = r.reported_by
        WHERE r.group_id = $1 ORDER BY r.week_of DESC LIMIT 26`,
      [req.params.id])).rows));

  /**
   * The report. One tap.
   *
   * week_of is the MONDAY of the week — so a leader reporting late on Sunday
   * night and one reporting on Tuesday morning file against the same week, and
   * the UNIQUE constraint does its job instead of creating a duplicate.
   */
  app.post<{ Params: { id: string }; Body: any }>(
    "/api/cells/:id/report", staff, async (req, reply) => {
      const b = req.body as any;
      try {
        return await tenantTx(req, async (tx) => {
          const r = await tx.query(
            `INSERT INTO cell_reports (tenant_id, group_id, week_of, met,
                did_not_meet_reason, present, visitors, new_converts, offering,
                note, reported_by)
             VALUES (current_tenant_id(), $1,
                     date_trunc('week', coalesce($2::date, CURRENT_DATE))::date,
                     $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (group_id, week_of) DO UPDATE SET
               met = $3, did_not_meet_reason = $4, present = $5, visitors = $6,
               new_converts = $7, offering = $8, note = $9,
               reported_by = $10, reported_at = now()
             RETURNING *`,
            [req.params.id, b.week_of ?? null, b.met !== false,
             b.did_not_meet_reason ?? null,
             Number(b.present ?? 0), Number(b.visitors ?? 0),
             Number(b.new_converts ?? 0),
             b.offering ? Number(b.offering) : null,
             b.note ?? null, b.reported_by ?? null]);

          // If he named who came, record it — but never demand it. Demanding a
          // name list is how you get zero reports instead of a headcount.
          if (Array.isArray(b.person_ids) && b.person_ids.length) {
            await tx.query(
              `DELETE FROM cell_attendance WHERE report_id = $1`, [r.rows[0].id]);
            await tx.query(
              `INSERT INTO cell_attendance (tenant_id, report_id, person_id)
               SELECT current_tenant_id(), $1, unnest($2::uuid[])
               ON CONFLICT DO NOTHING`, [r.rows[0].id, b.person_ids]);
          }
          return r.rows[0];
        });
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_report", detail: e.message });
      }
    });

  /**
   * MULTIPLY. A cell that grows past ~15 stops being a cell — it becomes a
   * small congregation, the quiet people go silent, and it stops multiplying.
   */
  app.post<{ Params: { id: string }; Body: any }>(
    "/api/cells/:id/multiply", staff, async (req, reply) => {
      const b = req.body as any;
      if (!b.name || !b.leader_id)
        return reply.code(400).send({ error: "need_name_and_leader",
          detail: "The new cell needs a name and a leader." });

      return tenantTx(req, async (tx) => {
        const parent = await tx.query(
          `SELECT parent_id, group_type FROM groups WHERE id = $1`, [req.params.id]);

        const g = await tx.query(
          `INSERT INTO groups (tenant_id, name, group_type, parent_id, leader_id,
              multiplied_from, launched_on, capacity, meets_on, meets_at, meets_where)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, CURRENT_DATE, 15, $6, $7, $8)
           RETURNING *`,
          [b.name, parent.rows[0]?.group_type ?? "cell",
           parent.rows[0]?.parent_id ?? null, b.leader_id, req.params.id,
           b.meets_on ?? null, b.meets_at ?? null, b.meets_where ?? null]);

        await tx.query(
          `UPDATE groups SET multiplied_at = CURRENT_DATE WHERE id = $1`,
          [req.params.id]);

        // Move the named people across.
        if (Array.isArray(b.person_ids) && b.person_ids.length) {
          await tx.query(
            `UPDATE persons SET home_group_id = $1 WHERE id = ANY($2::uuid[])`,
            [g.rows[0].id, b.person_ids]);
          await tx.query(
            `INSERT INTO group_memberships (tenant_id, group_id, person_id, role)
             SELECT current_tenant_id(), $1, unnest($2::uuid[]), 'member'
             ON CONFLICT DO NOTHING`, [g.rows[0].id, b.person_ids]);
        }
        // The new leader leads.
        await tx.query(
          `INSERT INTO group_memberships (tenant_id, group_id, person_id, role)
           VALUES (current_tenant_id(), $1, $2, 'leader')
           ON CONFLICT (tenant_id, group_id, person_id) DO UPDATE SET role='leader'`,
          [g.rows[0].id, b.leader_id]);

        return g.rows[0];
      });
    });
}
