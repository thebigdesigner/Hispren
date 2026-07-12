/**
 * SECURITY-CRITICAL. Auth, sessions, RBAC.
 *
 * Design:
 *  - Opaque session tokens (random 256-bit), stored hashed (sha256) in
 *    `sessions`. No JWTs: churches need instant revocation when a volunteer
 *    leaves, and opaque tokens revoke with one DELETE.
 *  - A session is bound to (user, tenant). A token minted on Church A's
 *    hostname is invalid on Church B's hostname even for the same human.
 *  - RBAC roles come from tenant_memberships (owner > admin > pastor >
 *    finance > staff > leader > readonly).
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { FastifyRequest, FastifyReply } from "fastify";
import { platformQuery, withTenant } from "./db";
import { requireTenant } from "./tenant";

const SESSION_TTL_DAYS = 14;

const ROLE_RANK: Record<string, number> = {
  readonly: 0, leader: 1, staff: 2, finance: 3, pastor: 4, admin: 5, owner: 6,
};

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function login(
  tenantId: string,
  email: string,
  password: string
): Promise<{ token: string; role: string } | null> {
  // Users are global; membership binds them to a tenant. Both checks required.
  const u = await platformQuery<{
    id: string; password_hash: string | null;
  }>(`SELECT id, password_hash FROM app_users WHERE email = $1`, [email]);
  const user = u.rows[0];
  // Constant-ish time: always run argon2 even for unknown users.
  const ok = await argonVerify(
    user?.password_hash ??
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    password
  ).catch(() => false);
  if (!user || !ok) return null;

  const m = await platformQuery<{ role: string }>(
    `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, user.id]
  );
  const role = m.rows[0]?.role;
  if (!role) return null; // valid human, wrong church → no session

  const raw = randomBytes(32).toString("base64url");
  await platformQuery(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [hashToken(raw), user.id, tenantId, SESSION_TTL_DAYS]
  );
  return { token: raw, role };
}

export async function logout(rawToken: string): Promise<void> {
  await platformQuery(`DELETE FROM sessions WHERE token_hash = $1`, [
    hashToken(rawToken),
  ]);
}

export type AuthContext = { userId: string; tenantId: string; role: string };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** preHandler: authenticate against the CURRENT hostname's tenant. */
export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const tenantId = requireTenant(req, reply);
  const raw =
    req.headers.authorization?.replace(/^Bearer /, "") ??
    (req.cookies as any)?.session;
  if (!raw) {
    reply.code(401).send({ error: "unauthenticated" });
    return reply;
  }
  const r = await platformQuery<{
    user_id: string; tenant_id: string; role: string;
  }>(
    `SELECT s.user_id, s.tenant_id, m.role
       FROM sessions s
       JOIN tenant_memberships m
         ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(raw)]
  );
  const row = r.rows[0];
  // The session's tenant must equal the hostname's tenant. This is the line
  // that makes a Church A token worthless on Church B's domain.
  if (!row || row.tenant_id !== tenantId) {
    reply.code(401).send({ error: "unauthenticated" });
    return reply;
  }
  req.auth = { userId: row.user_id, tenantId, role: row.role };
}

/** Route guard factory: requireRole('finance') */
export function requireRole(minRole: keyof typeof ROLE_RANK) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth || ROLE_RANK[req.auth.role] < ROLE_RANK[minRole]) {
      reply.code(403).send({ error: "forbidden" });
      return reply;
    }
  };
}

/** Convenience: run a handler's queries in the caller's tenant context. */
export function tenantTx<T>(req: FastifyRequest, fn: Parameters<typeof withTenant<T>>[1]) {
  if (!req.auth) throw new Error("tenantTx before authenticate");
  return withTenant<T>(req.auth.tenantId, fn);
}
