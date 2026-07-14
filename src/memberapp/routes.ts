/**
 * THE MEMBER APP.
 *
 * A member does not have a password, and asking a Nigerian congregation to
 * invent and remember one is how you get forty downloads and zero logins.
 *
 * THEIR QR TOKEN IS THEIR LOGIN.
 *
 * persons.qr_token is already a rotatable secret UUID. It is already on their
 * phone, already printed on their member card, and already the thing an usher
 * scans at the gate. Reusing it means:
 *
 *   - no password to forget
 *   - no SMS OTP to pay for
 *   - losing your phone is fixed by ROTATING the token, which the church can
 *     already do from the member's record, and which already invalidates the
 *     old card
 *
 * WHAT THE TOKEN CAN DO:
 *   read their own record, the directory (opt-in only), announcements, events,
 *   sermons; submit a prayer request; correct their own phone and email.
 *
 * WHAT IT CANNOT DO:
 *   see giving — theirs or anybody's. See a genotype. See another member's
 *   address. Change anything about anybody else. It is a MEMBER token, and it
 *   is deliberately close to useless in the wrong hands.
 */
import { FastifyInstance, FastifyRequest } from "fastify";
import { platformQuery, withTenant, Tx } from "../platform/db";

type Me = { person_id: string; tenant_id: string };

/** Resolve the QR token. Nothing else in this file runs without it. */
async function whoami(req: FastifyRequest): Promise<Me | null> {
  const t = (req.headers["x-member-token"] as string)
         ?? (req.query as any)?.t;
  if (!t || !/^[0-9a-f-]{36}$/i.test(t)) return null;

  const { rows } = await platformQuery<any>(
    `SELECT p.id AS person_id, p.tenant_id
       FROM persons p
      WHERE p.qr_token = $1 AND p.archived_at IS NULL AND NOT p.is_deceased`, [t]);
  return rows[0] ?? null;
}

export function registerMemberAppRoutes(app: FastifyInstance) {

  /** Who am I. The first call the app makes. */
  app.get("/api/me/card", async (req, reply) => {
    const me = await whoami(req);
    if (!me) return reply.code(401).send({ error: "unknown_card" });

    return withTenant(me.tenant_id, async (tx: Tx) => {
      const p = await tx.query(
        `SELECT p.id, p.first_name, p.last_name, p.member_code, p.qr_token,
                p.phone, p.email, p.usual_service,
                p.show_in_directory, p.directory_phone, p.directory_email,
                g.name AS group_name, js.label AS stage,
                p.last_attended_at, p.attendance_streak,
                t.name AS church, t.brand_color
           FROM persons p
           LEFT JOIN groups g ON g.id = p.home_group_id
           LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
           JOIN tenants t ON t.id = p.tenant_id
          WHERE p.id = $1`, [me.person_id]);
      return p.rows[0];
    });
  });

  /** Announcements, events, sermons. Everything the app shows, in one call —
   *  because it is going to be opened on a phone with two bars of signal. */
  app.get("/api/me/feed", async (req, reply) => {
    const me = await whoami(req);
    if (!me) return reply.code(401).send({ error: "unknown_card" });

    return withTenant(me.tenant_id, async (tx: Tx) => {
      const ann = await tx.query(
        `SELECT id, title, body, pinned, publish_at FROM announcements
          WHERE publish_at <= now() AND (expires_at IS NULL OR expires_at > now())
          ORDER BY pinned DESC, publish_at DESC LIMIT 20`);

      const events = await tx.query(
        `SELECT id, name, kind, event_date, day_of_week, start_time, location, colour
           FROM services
          WHERE archived_at IS NULL
            AND (event_date IS NULL OR event_date >= CURRENT_DATE)
          ORDER BY (event_date IS NULL), event_date, position LIMIT 20`);

      const sermons = await tx.query(
        `SELECT id, title, preacher, preached_on, scripture, summary,
                audio_url, video_url, notes_url
           FROM sermons ORDER BY preached_on DESC LIMIT 20`);

      return { announcements: ann.rows, events: events.rows, sermons: sermons.rows };
    });
  });

  /**
   * The directory. OPT-IN ONLY.
   *
   * A church directory that publishes everyone's home address by default is a
   * burglary list. Nobody appears here unless they said yes, and their phone and
   * email are two separate yeses.
   */
  app.get("/api/me/directory", async (req, reply) => {
    const me = await whoami(req);
    if (!me) return reply.code(401).send({ error: "unknown_card" });

    return withTenant(me.tenant_id, async (tx: Tx) => {
      const { rows } = await tx.query(
        `SELECT p.id,
                trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
                CASE WHEN p.directory_phone THEN coalesce(p.phone, p.phone_2) END AS phone,
                CASE WHEN p.directory_email THEN p.email::text END AS email,
                g.name AS group_name, p.post_held
           FROM persons p LEFT JOIN groups g ON g.id = p.home_group_id
          WHERE p.show_in_directory = true
            AND p.archived_at IS NULL AND NOT p.is_deceased
          ORDER BY p.first_name, p.last_name`);
      return rows;
    });
  });

  /** Their own attendance. Nobody else's. */
  app.get("/api/me/attendance", async (req, reply) => {
    const me = await whoami(req);
    if (!me) return reply.code(401).send({ error: "unknown_card" });

    return withTenant(me.tenant_id, async (tx: Tx) => {
      const { rows } = await tx.query(
        `SELECT s.session_date, sv.name AS service
           FROM attendance a
           JOIN attendance_sessions s ON s.id = a.session_id
           JOIN services sv ON sv.id = s.service_id
          WHERE a.person_id = $1
          ORDER BY s.session_date DESC LIMIT 20`, [me.person_id]);
      return rows;
    });
  });

  /**
   * A prayer request, from their own phone.
   *
   * PRIVATE BY DEFAULT. A member asking for prayer about a marriage, a
   * diagnosis, or a debt must not find it on a noticeboard.
   */
  app.post<{ Body: { body: string; is_private?: boolean; is_anonymous?: boolean } }>(
    "/api/me/prayer", async (req, reply) => {
      const me = await whoami(req);
      if (!me) return reply.code(401).send({ error: "unknown_card" });
      const b = req.body as any;
      if (!b.body?.trim())
        return reply.code(400).send({ error: "empty" });

      return withTenant(me.tenant_id, async (tx: Tx) => {
        const { rows } = await tx.query(
          `INSERT INTO prayer_requests (tenant_id, person_id, body, is_private, is_anonymous)
           VALUES (current_tenant_id(), $1, $2, $3, $4)
           RETURNING id, created_at`,
          [b.is_anonymous ? null : me.person_id, b.body.trim(),
           b.is_private !== false, !!b.is_anonymous]);
        return rows[0];
      });
    });

  /**
   * Correct their OWN details. Nobody else's, and only these fields.
   *
   * This is the cheapest data-quality feature in the product: a member fixing
   * their own phone number costs the church nothing and fixes a record that
   * would otherwise be wrong for years.
   */
  app.patch<{ Body: any }>("/api/me/details", async (req, reply) => {
    const me = await whoami(req);
    if (!me) return reply.code(401).send({ error: "unknown_card" });
    const b = req.body as any;

    return withTenant(me.tenant_id, async (tx: Tx) => {
      await tx.query(
        `UPDATE persons SET
            phone = coalesce($2, phone),
            email = coalesce($3, email),
            show_in_directory = coalesce($4, show_in_directory),
            directory_phone   = coalesce($5, directory_phone),
            directory_email   = coalesce($6, directory_email),
            push_token        = coalesce($7, push_token)
          WHERE id = $1`,
        [me.person_id, b.phone ?? null, b.email ?? null,
         b.show_in_directory ?? null, b.directory_phone ?? null,
         b.directory_email ?? null, b.push_token ?? null]);
      return { saved: true };
    });
  });
}
