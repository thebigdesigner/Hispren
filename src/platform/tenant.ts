/**
 * SECURITY-CRITICAL. Edge tenant resolution: hostname → tenant_id.
 *
 * Invariants:
 *  - Tenant is derived from the TLS-terminated Host header ONCE, here, and
 *    attached to the request. Application code NEVER re-derives tenant from
 *    any header downstream.
 *  - Unknown hostname → 404. No fallback tenant. Fail closed.
 *  - Custom domains resolve only after verified_at is set (TXT verification),
 *    so a stranger pointing DNS at us gets nothing.
 */
import { FastifyRequest, FastifyReply } from "fastify";
import { platformQuery } from "./db";

const BASE = process.env.BASE_DOMAIN ?? "hispren.com"; // serves *.hispren.com

type TenantRef = { id: string; status: string };
const cache = new Map<string, { t: TenantRef | null; exp: number }>();
const TTL_MS = 60_000;

async function resolveHost(hostname: string): Promise<TenantRef | null> {
  const now = Date.now();
  const hit = cache.get(hostname);
  if (hit && hit.exp > now) return hit.t;

  let t: TenantRef | null = null;

  if (hostname === BASE || hostname === `www.${BASE}`) {
    t = null; // marketing site / platform admin — no tenant context
  } else if (hostname.endsWith(`.${BASE}`)) {
    const sub = hostname.slice(0, -(BASE.length + 1));
    if (!sub.includes(".")) {
      const r = await platformQuery<TenantRef>(
        `SELECT id, status FROM tenants WHERE subdomain = $1`,
        [sub]
      );
      t = r.rows[0] ?? null;
    }
  } else {
    // Custom domain — must be verified
    const r = await platformQuery<TenantRef>(
      `SELECT t.id, t.status
         FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.hostname = $1 AND d.verified_at IS NOT NULL`,
      [hostname]
    );
    t = r.rows[0] ?? null;
  }

  cache.set(hostname, { t, exp: now + TTL_MS });
  return t;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string | null;
  }
}

export async function tenantResolver(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // req.hostname is set by Fastify from the Host header AFTER TLS termination.
  // Behind the load balancer, ensure trustProxy is configured so a client
  // cannot spoof X-Forwarded-Host to a hostname the LB didn't route.
  const hostname = req.hostname.toLowerCase().split(":")[0];
  const tenant = await resolveHost(hostname);

  if (tenant === null) {
    // Platform routes (marketing, superadmin) are mounted under a separate
    // prefix and explicitly allow tenantId === null. Everything else: 404.
    req.tenantId = null;
    return;
  }
  if (tenant.status === "suspended" || tenant.status === "churned") {
    reply.code(402).send({ error: "account_inactive" });
    return reply;
  }
  req.tenantId = tenant.id;
}

/** Route guard: this endpoint requires tenant context. */
export function requireTenant(req: FastifyRequest, reply: FastifyReply): string {
  if (!req.tenantId) {
    reply.code(404).send({ error: "not_found" });
    throw new Error("no_tenant_context");
  }
  return req.tenantId;
}
