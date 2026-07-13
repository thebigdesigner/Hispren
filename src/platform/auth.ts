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

const LOCK_AFTER = 5;              // wrong guesses
const LOCK_FOR   = 15;             // minutes

/**
 * Password policy.
 *
 * Not theatre. The prize behind this login is a congregation's phone numbers,
 * home addresses, giving records, and — where a church has enabled it — their
 * genotypes. Ten characters is the floor, and "dominion2026" is not a password
 * for a church called Dominion.
 */
export function checkPassword(pw: string, context: string[] = []): string | null {
  if (!pw || pw.length < 10)
    return "At least 10 characters. This login opens a congregation's records.";
  if (/^[0-9]+$/.test(pw))
    return "Not only numbers.";
  const low = pw.toLowerCase();
  for (const c of context) {
    if (c && c.length > 3 && low.includes(c.toLowerCase()))
      return `It must not contain "${c}".`;
  }
  const common = ["password","12345678","qwerty","letmein","welcome",
                  "church","pastor","jesus","god","amen","hispren"];
  if (common.some(c => low.includes(c)))
    return "Too easy to guess. Pick something that is not about the church.";
  return null;
}

export async function hashPassword(pw: string) { return argonHash(pw); }
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

export type LoginResult =
  | { ok: true; token: string; role: string }
  | { ok: false; reason: "bad_credentials" }
  | { ok: false; reason: "locked"; minutes: number };

export async function login(
  tenantId: string,
  email: string,
  password: string,
  ip?: string
): Promise<LoginResult> {
  // Users are global; membership binds them to a tenant. Both checks required.
  const u = await platformQuery<{
    id: string; password_hash: string | null;
    failed_attempts: number; locked_until: string | null;
  }>(`SELECT id, password_hash, failed_attempts, locked_until
        FROM app_users WHERE email = $1`, [email]);
  const user = u.rows[0];

  // ---- LOCKED OUT --------------------------------------------------------
  // Held in the DATABASE, not in memory. An in-memory counter resets on every
  // deploy and does not exist across instances — an attacker only has to wait
  // for a restart.
  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil(
      (new Date(user.locked_until).getTime() - Date.now()) / 60000);
    return { ok: false, reason: "locked", minutes: mins };
  }

  // Constant-ish time: always run argon2, even for an unknown user, so the
  // response time does not reveal whether the email exists.
  const ok = await argonVerify(
    user?.password_hash ??
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    password
  ).catch(() => false);

  if (!user || !ok) {
    if (user) {
      // Five wrong guesses locks the account for fifteen minutes. The prize
      // behind this login is a congregation's phone numbers, addresses, giving
      // records, and — where enabled — their genotypes.
      const n = (user.failed_attempts ?? 0) + 1;
      await platformQuery(
        `UPDATE app_users
            SET failed_attempts = $2,
                locked_until = CASE WHEN $2 >= $3
                                    THEN now() + ($4 || ' minutes')::interval
                                    ELSE locked_until END
          WHERE id = $1`,
        [user.id, n, LOCK_AFTER, String(LOCK_FOR)]);
    }
    return { ok: false, reason: "bad_credentials" };
  }

  // clean slate on a good password
  await platformQuery(
    `UPDATE app_users SET failed_attempts = 0, locked_until = NULL,
            last_login_at = now(), last_login_ip = $2
      WHERE id = $1`, [user.id, ip ?? null]);

  const m = await platformQuery<{ role: string }>(
    `SELECT role FROM tenant_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tenantId, user.id]
  );
  const role = m.rows[0]?.role;
  // A valid human at the wrong church gets nothing — and is told nothing more
  // than a wrong password would tell them.
  if (!role) return { ok: false, reason: "bad_credentials" };

  const raw = randomBytes(32).toString("base64url");
  await platformQuery(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [hashToken(raw), user.id, tenantId, SESSION_TTL_DAYS]
  );
  return { ok: true, token: raw, role };
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
