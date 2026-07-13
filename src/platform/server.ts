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
import { startInProcessWorker } from "./inproc";

/**
 * A per-IP burst limiter, in memory.
 *
 * The DATABASE lockout (5 wrong passwords -> 15 minutes) is the real control:
 * it survives restarts and works across instances. This sits in front of it and
 * stops the noisy half of an attack before it ever reaches Postgres.
 *
 * In-memory is fine HERE precisely because it is not the real control. If it
 * resets on deploy, the database lockout is still standing.
 */
const tries = new Map<string, number[]>();
const BURST = 5;              // attempts
const BURST_WINDOW = 60_000;  // per minute

function recent(ip: string) {
  const cut = Date.now() - BURST_WINDOW;
  const t = (tries.get(ip) ?? []).filter((x) => x > cut);
  tries.set(ip, t);
  return t;
}
function tooManyTries(ip: string) { return recent(ip).length >= BURST; }
function noteFailure(ip: string) { recent(ip).push(Date.now()); }
function clearFailures(ip: string) { tries.delete(ip); }
setInterval(() => {
  const cut = Date.now() - BURST_WINDOW;
  for (const [ip, t] of tries) {
    const keep = t.filter((x) => x > cut);
    keep.length ? tries.set(ip, keep) : tries.delete(ip);
  }
}, 5 * 60_000);
import { registerMemberRoutes } from "../members/routes";
import { registerAttendanceRoutes } from "../attendance/routes";
import { registerExportRoutes } from "../export/routes";
import { registerChurchRoutes } from "../church/routes";
import { registerReportRoutes } from "../reports/routes";
import { registerNotifyRoutes } from "../notify/routes";
import { registerListRoutes } from "../lists/routes";
import { registerGivingRoutes } from "../giving/routes";
import { registerUserRoutes } from "../users/routes";
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
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
                 ?? req.ip;

      // A burst limiter in front of the DB one. Five wrong guesses from an IP in
      // a minute and it waits. Cheap, and it stops the noisy half of an attack
      // before it ever reaches Postgres.
      if (tooManyTries(ip)) {
        return reply.code(429).send({
          error: "too_many",
          detail: "Too many attempts. Wait a minute and try again.",
        });
      }

      const r: any = await login(tenantId, req.body.email, req.body.password, ip);

      if (!r.ok) {
        if (r.reason === "locked") {
          return reply.code(423).send({
            error: "locked",
            detail: `This account is locked for ${r.minutes} more minute` +
                    `${r.minutes === 1 ? "" : "s"} after too many wrong passwords.`,
          });
        }
        noteFailure(ip);
        return reply.code(401).send({ error: "invalid_credentials",
          detail: "Wrong email or password." });
      }

      clearFailures(ip);
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
  registerListRoutes(app);
  registerGivingRoutes(app);
  registerUserRoutes(app);
  registerCareRoutes(app);

  startInProcessWorker();

  return app;
}

if (require.main === module) {
  buildServer().listen(
    { port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" },
    (err) => { if (err) { console.error(err); process.exit(1); } }
  );
}
