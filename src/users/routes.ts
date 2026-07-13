import { FastifyInstance } from "fastify";
import { authenticate, requireRole, tenantTx } from "../platform/auth";
import * as U from "./service";
import { emailProvider, renderEmail } from "../notify/providers/email";
import { platformQuery } from "../platform/db";

export function registerUserRoutes(app: FastifyInstance) {
  const auth  = { preHandler: [authenticate] };
  const admin = { preHandler: [authenticate, requireRole("admin")] };
  const owner = { preHandler: [authenticate, requireRole("owner")] };

  app.get("/api/users", auth, async (req) =>
    tenantTx(req, async (tx) => ({
      users: await U.users(tx),
      invites: await U.invites(tx),
      roles: U.ROLES,
      me: req.auth!.userId,
      my_role: req.auth!.role,
    })));

  /** Invite. Emails them a link. You never set anybody else's password. */
  app.post<{ Body: { email: string; full_name?: string; role: string } }>(
    "/api/users/invite", admin, async (req, reply) => {
      try {
        const inv = await tenantTx(req, (tx) =>
          U.invite(tx, req.body, req.auth!.userId));

        const t = await platformQuery<any>(
          `SELECT name, brand_color FROM tenants WHERE id = $1`, [req.auth!.tenantId]);
        const church = t.rows[0]?.name ?? "your church";
        const base = process.env.PUBLIC_URL
          ?? `https://${req.headers.host ?? "hispren.up.railway.app"}`;
        const link = `${base}/join.html?t=${inv.token}`;

        const mail = emailProvider();
        const { html, text } = renderEmail(church,
          `You have been invited to help run ${church} on Hispren, as ` +
          `${U.ROLES[inv.role].label}.\n\n` +
          `Set your own password here — the link works once, and expires in seven days:\n\n` +
          `${link}\n\n` +
          `Nobody at ${church} knows your password, and nobody should. ` +
          `Everything you do is recorded with your name on it.`,
          t.rows[0]?.brand_color ?? "#1A5FD0");

        await mail.send(inv.email,
          process.env.EMAIL_FROM ?? "Hispren <onboarding@resend.dev>",
          `You have been invited to ${church}`, html, text);

        reply.code(201).send({ ...inv, link, emailed: mail.name !== "dry-run" });
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_invite", detail: e.message });
      }
    });

  app.delete<{ Params: { id: string } }>("/api/users/invite/:id", admin, async (req, reply) => {
    const r = await tenantTx(req, (tx) => U.revokeInvite(tx, req.params.id));
    return r ? { revoked: true } : reply.code(404).send({ error: "not_found" });
  });

  app.patch<{ Params: { id: string }; Body: { role: string } }>(
    "/api/users/:id/role", owner, async (req, reply) => {
      try {
        return await tenantTx(req, (tx) =>
          U.changeRole(tx, req.params.id, req.body.role, req.auth!.userId));
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_change", detail: e.message });
      }
    });

  app.delete<{ Params: { id: string } }>("/api/users/:id", owner, async (req, reply) => {
    try { return await tenantTx(req, (tx) => U.revoke(tx, req.params.id, req.auth!.userId)); }
    catch (e: any) { return reply.code(400).send({ error: "cannot_revoke", detail: e.message }); }
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/unlock", admin, async (req) =>
    tenantTx(req, (tx) => U.unlock(tx, req.params.id, req.auth!.userId)));

  /** Change your OWN password. Never anybody else's. */
  app.post<{ Body: { current: string; next: string } }>(
    "/api/users/password", auth, async (req, reply) => {
      try {
        const u = await platformQuery<any>(
          `SELECT email::text FROM app_users WHERE id = $1`, [req.auth!.userId]);
        return await U.changeOwnPassword(
          req.auth!.userId, req.body.current, req.body.next, u.rows[0].email);
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_change", detail: e.message });
      }
    });

  // ---- accepting an invite: NO session yet, so no tenant context ----------
  app.get<{ Params: { token: string } }>("/api/join/:token", async (req, reply) => {
    const inv = await U.lookupInvite(req.params.token);
    return inv
      ? { church: inv.church, subdomain: inv.subdomain, email: inv.email,
          full_name: inv.full_name, role: inv.role, role_label: U.ROLES[inv.role].label }
      : reply.code(404).send({ error: "expired",
          detail: "That invitation has expired or has already been used." });
  });

  app.post<{ Body: { token: string; full_name: string; password: string } }>(
    "/api/join", async (req, reply) => {
      try {
        return await U.acceptInvite(req.body.token, req.body.full_name, req.body.password);
      } catch (e: any) {
        return reply.code(400).send({ error: "cannot_join", detail: e.message });
      }
    });
}
