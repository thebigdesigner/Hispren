/**
 * API layer. Fastify wiring: tenant resolution → auth → routes.
 * Error contract: every error is { error: string, detail?: string }.
 * Unknown errors are logged with a request id and returned opaque — never
 * leak SQL or stack traces to a church admin's browser.
 */
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import path from "path";
import { tenantResolver, requireTenant } from "./tenant";
import { authenticate, requireRole, login, logout, tenantTx } from "./auth";
import { healthcheck } from "./db";
import { registerMemberRoutes } from "../members/routes";
import { registerAttendanceRoutes } from "../attendance/routes";
import { registerExportRoutes } from "../export/routes";
import { registerChurchRoutes } from "../church/routes";
import { registerReportRoutes } from "../reports/routes";
import { registerNotifyRoutes } from "../notify/routes";
import { registerCareRoutes } from "../care/routes";

export function buildServer() {
  const app = Fastify({
    logger: true,
    trustProxy: true, // REQUIRED behind the LB so req.hostname is the routed host
  });
  app.register(cookie);

  // The frontend. Served by the same process — one deploy, no build step.
  app.register(fstatic, {
    root: path.join(__dirname, "..", "..", "public"),
    prefix: "/",
  });

  app.addHook("onRequest", tenantResolver);

  app.setErrorHandler((err, req, reply) => {
    if ((err as any).validation) {
      return reply.code(400).send({ error: "validation", detail: err.message });
    }
    req.log.error({ err, reqId: req.id }, "unhandled");
    reply.code(500).send({ error: "internal", ref: req.id });
  });

  app.get("/healthz", async (_req, reply) => {
    const h = await healthcheck();
    const ok = h.app && h.platform;
    return reply.code(ok ? 200 : 503).send({ ok, ...h });
  });

  // ---- auth ----
  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      const r = await login(tenantId, req.body.email, req.body.password);
      if (!r) return reply.code(401).send({ error: "invalid_credentials" });
      reply
        .setCookie("session", r.token, {
          httpOnly: true, secure: true, sameSite: "lax", path: "/",
        })
        .send({ role: r.role });
    }
  );
  app.post("/api/auth/logout", { preHandler: [authenticate] }, async (req, reply) => {
    const raw = (req.cookies as any)?.session
      ?? req.headers.authorization?.replace(/^Bearer /, "");
    if (raw) await logout(raw);
    reply.clearCookie("session", { path: "/" }).send({ ok: true });
  });

  // ---- example tenant-scoped route (pattern for all Phase 1 modules) ----
  app.get("/api/me", { preHandler: [authenticate] }, async (req) => {
    return tenantTx(req, async (tx) => {
      const t = await tx.query(`SELECT id, name, subdomain, plan_tier FROM tenants
                                WHERE id = current_tenant_id()`);
      return { tenant: t.rows[0], role: req.auth!.role };
    });
  });

  // Role-guard example: finance-only endpoint shape
  app.get("/api/billing/invoices",
    { preHandler: [authenticate, requireRole("finance")] },
    async (req) => tenantTx(req, async (tx) => {
      const r = await tx.query(
        `SELECT number, status, total, due_at, period_start, period_end
           FROM invoices WHERE tenant_id = current_tenant_id()
          ORDER BY created_at DESC LIMIT 50`);
      return { invoices: r.rows };
    })
  );

  registerMemberRoutes(app);
  registerAttendanceRoutes(app);
  registerExportRoutes(app);
  registerChurchRoutes(app);
  registerReportRoutes(app);
  registerNotifyRoutes(app);
  registerCareRoutes(app);

  return app;
}

if (require.main === module) {
  buildServer().listen(
    { port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" },
    (err) => { if (err) { console.error(err); process.exit(1); } }
  );
}
