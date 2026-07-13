/**
 * USERS.
 *
 * A church is a SECRETARY, a TREASURER, USHERS, CELL LEADERS and a PASTOR.
 * Until this existed, it was one login — and so every separation-of-duty
 * control in the product was decorative:
 *
 *   "Whoever records a payment must not approve it"  -- one person did both.
 *   "Every genotype read is audited to a person"     -- always the same person.
 *   The usher scanned on his phone                   -- as the pastor.
 */
import { Tx, platformQuery } from "../platform/db";
import { hashPassword, checkPassword } from "../platform/auth";
import { normaliseText } from "../members/service";

export const ROLES: Record<string, { label: string; can: string }> = {
  owner:  { label: "Owner",
            can: "Everything, including billing and removing people. The pastor." },
  admin:  { label: "Administrator",
            can: "Everything except billing. APPROVES expenses — and so must not be the treasurer." },
  pastor: { label: "Pastor",
            can: "Sees genotype and pastoral care. Every one of those reads is logged." },
  staff:  { label: "Staff",
            can: "Treasurer, ushers, cell leaders. Records attendance, counts offerings, registers members. Records expenses but CANNOT approve them." },
  viewer: { label: "Viewer",
            can: "Read only. A board member who should see the numbers and touch nothing." },
};

export async function users(tx: Tx) {
  const { rows } = await tx.query(`SELECT * FROM church_users()`);
  return rows;
}

export async function invites(tx: Tx) {
  const { rows } = await tx.query(
    `SELECT id, email::text, full_name, role, expires_at, created_at
       FROM invitations WHERE accepted_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`);
  return rows;
}

/**
 * Invite. You do NOT create a password for somebody else.
 *
 * A pastor who types his treasurer's password for her knows his treasurer's
 * password — and every audit entry with her name on it is now worthless. She
 * sets her own, from a link, and the link dies when she uses it.
 */
export async function invite(
  tx: Tx,
  d: { email: string; full_name?: string; role: string },
  invitedBy: string
) {
  if (!ROLES[d.role]) throw new Error("No such role.");

  const already = await tx.query(
    `SELECT 1 FROM tenant_memberships m JOIN app_users u ON u.id = m.user_id
      WHERE u.email = $1 AND m.revoked_at IS NULL`, [d.email.trim().toLowerCase()]);
  if (already.rows[0]) throw new Error("That person already has an account here.");

  const { rows } = await tx.query(
    `INSERT INTO invitations (tenant_id, email, full_name, role, invited_by)
     VALUES (current_tenant_id(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, email) DO UPDATE
       SET role = $3, full_name = $2, token = gen_random_uuid(),
           expires_at = now() + interval '7 days', accepted_at = NULL
     RETURNING id, email::text, full_name, role, token, expires_at`,
    [d.email.trim().toLowerCase(), normaliseText(d.full_name), d.role, invitedBy]);
  return rows[0];
}

export async function revokeInvite(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `DELETE FROM invitations WHERE id = $1 RETURNING id`, [id]);
  return rows[0] ?? null;
}

export async function changeRole(tx: Tx, userId: string, role: string, actor: string) {
  if (!ROLES[role]) throw new Error("No such role.");
  if (userId === actor) throw new Error("You cannot change your own role.");

  // A church must never be left with nobody who can let anyone back in.
  const owners = await tx.query(
    `SELECT count(*)::int AS n FROM tenant_memberships
      WHERE role = 'owner' AND revoked_at IS NULL`);
  const isOwner = await tx.query(
    `SELECT 1 FROM tenant_memberships
      WHERE user_id = $1 AND role = 'owner' AND revoked_at IS NULL`, [userId]);
  if (isOwner.rows[0] && owners.rows[0].n <= 1 && role !== "owner")
    throw new Error("This is the only owner. Make somebody else an owner first.");

  const { rows } = await tx.query(
    `UPDATE tenant_memberships SET role = $2
      WHERE user_id = $1 AND tenant_id = current_tenant_id() AND revoked_at IS NULL
      RETURNING user_id`, [userId, role]);

  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user, action, entity_type, entity_id, after)
     VALUES (current_tenant_id(), $1, 'user.role_changed', 'user', $2, $3)`,
    [actor, userId, JSON.stringify({ role })]);
  return rows[0] ?? null;
}

/**
 * Revoke. A volunteer leaves the church. Their access ends TODAY — but the
 * record of everything they did stays, forever, with their name on it.
 */
export async function revoke(tx: Tx, userId: string, actor: string) {
  if (userId === actor) throw new Error("You cannot remove yourself.");

  const owners = await tx.query(
    `SELECT count(*)::int AS n FROM tenant_memberships
      WHERE role = 'owner' AND revoked_at IS NULL`);
  const isOwner = await tx.query(
    `SELECT 1 FROM tenant_memberships
      WHERE user_id = $1 AND role = 'owner' AND revoked_at IS NULL`, [userId]);
  if (isOwner.rows[0] && owners.rows[0].n <= 1)
    throw new Error("This is the only owner. The church would be locked out.");

  await tx.query(
    `UPDATE tenant_memberships SET revoked_at = now()
      WHERE user_id = $1 AND tenant_id = current_tenant_id()`, [userId]);

  // Kill their sessions now. Not on next login — NOW.
  await platformQuery(
    `DELETE FROM sessions WHERE user_id = $1 AND tenant_id = current_tenant_id()`,
    [userId]);

  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user, action, entity_type, entity_id)
     VALUES (current_tenant_id(), $1, 'user.revoked', 'user', $2)`, [actor, userId]);
  return { revoked: true };
}

/** Unlock an account somebody locked out of by fat-fingering their password. */
export async function unlock(tx: Tx, userId: string, actor: string) {
  await platformQuery(
    `UPDATE app_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
    [userId]);
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user, action, entity_type, entity_id)
     VALUES (current_tenant_id(), $1, 'user.unlocked', 'user', $2)`, [actor, userId]);
  return { unlocked: true };
}

// ---------------------------------------------------------------------------
// ACCEPTING AN INVITE — runs BEFORE the person has a session, so it is a
// PLATFORM operation, not a tenant one.
// ---------------------------------------------------------------------------
export async function lookupInvite(token: string) {
  const { rows } = await platformQuery<any>(
    `SELECT i.id, i.email::text, i.full_name, i.role, i.tenant_id,
            t.name AS church, t.subdomain
       FROM invitations i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
    [token]);
  return rows[0] ?? null;
}

export async function acceptInvite(token: string, fullName: string, password: string) {
  const inv = await lookupInvite(token);
  if (!inv) throw new Error("That invitation has expired or has already been used.");

  const bad = checkPassword(password, [inv.church, inv.subdomain, inv.email.split("@")[0]]);
  if (bad) throw new Error(bad);

  const hash = await hashPassword(password);

  // The person may already exist — one human, many churches.
  const u = await platformQuery<any>(
    `INSERT INTO app_users (email, full_name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET full_name = coalesce(app_users.full_name, $2),
           password_hash = coalesce(app_users.password_hash, $3)
     RETURNING id`,
    [inv.email, normaliseText(fullName) ?? inv.full_name, hash]);

  await platformQuery(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE
       SET role = $3, revoked_at = NULL`,
    [inv.tenant_id, u.rows[0].id, inv.role]);

  // The link dies the moment it is used.
  await platformQuery(
    `UPDATE invitations SET accepted_at = now() WHERE id = $1`, [inv.id]);

  return { church: inv.church, subdomain: inv.subdomain, email: inv.email };
}

/** Change your OWN password. Never anybody else's. */
export async function changeOwnPassword(
  userId: string, current: string, next: string, email: string
) {
  const { verify } = await import("@node-rs/argon2");
  const u = await platformQuery<any>(
    `SELECT password_hash FROM app_users WHERE id = $1`, [userId]);
  const ok = await verify(u.rows[0]?.password_hash ?? "", current).catch(() => false);
  if (!ok) throw new Error("That is not your current password.");

  const bad = checkPassword(next, [email.split("@")[0]]);
  if (bad) throw new Error(bad);

  await platformQuery(
    `UPDATE app_users SET password_hash = $2 WHERE id = $1`,
    [userId, await hashPassword(next)]);

  // Every OTHER session ends. If somebody had your old password, they are out.
  await platformQuery(
    `DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return { changed: true };
}
