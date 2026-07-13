-- ============================================================================
-- 010 — USERS, ROLES, AND LOCKOUT
--
-- Until now a church has had exactly ONE login. Which means every
-- separation-of-duty control in this product was decorative:
--
--   "Whoever records a payment must not approve it"  -- one person does both.
--   "Every genotype read is audited to a person"     -- always the same person.
--   The usher scans on their phone                   -- as the pastor.
--   A volunteer leaves the church                    -- you cannot revoke them.
--
-- A church is a SECRETARY, a TREASURER, USHERS, CELL LEADERS and a PASTOR.
-- They need their own accounts, with their own powers, and an audit trail that
-- names them.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- LOCKOUT.
--
-- A login endpoint with no rate limit is a brute-force target, and the prize is
-- a congregation's phone numbers, addresses, and giving records. Five wrong
-- guesses locks the account for fifteen minutes.
--
-- Held in the DATABASE, not in memory: an in-memory counter resets on every
-- deploy and does not exist across instances. An attacker only has to wait for
-- a restart.
-- ----------------------------------------------------------------------------
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS locked_until    timestamptz;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at   timestamptz;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_ip   text;

-- ----------------------------------------------------------------------------
-- INVITATIONS
--
-- You do not create a password for somebody else. You send them a link, they
-- set their own, and the link dies. A pastor who types his treasurer's password
-- for her knows his treasurer's password.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invitations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  full_name  text,
  role       text NOT NULL CHECK (role IN ('owner','admin','pastor','staff','viewer')),
  token      uuid NOT NULL DEFAULT gen_random_uuid(),
  invited_by uuid REFERENCES app_users(id),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_invite_token ON invitations(token) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invite_tenant ON invitations(tenant_id);

-- ----------------------------------------------------------------------------
-- Membership gets a lifecycle. A volunteer who leaves must be revocable, and
-- the record of them having been here must survive.
-- ----------------------------------------------------------------------------
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES app_users(id);

-- ----------------------------------------------------------------------------
-- RLS. Invitations are tenant data. The platform role handles login and must
-- see memberships across tenants — it already does.
-- ----------------------------------------------------------------------------
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invitations;
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS platform_access ON invitations;
CREATE POLICY platform_access ON invitations FOR ALL TO hispren_platform
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO hispren_app, hispren_platform;
GRANT SELECT, INSERT, UPDATE ON app_users TO hispren_platform;

-- ----------------------------------------------------------------------------
-- Who can see this church, and as what.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION church_users()
RETURNS TABLE (user_id uuid, email text, full_name text, role text,
               last_login_at timestamptz, locked boolean, joined timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT u.id, u.email::text, u.full_name, m.role,
         u.last_login_at,
         (u.locked_until IS NOT NULL AND u.locked_until > now()),
         m.created_at
    FROM tenant_memberships m
    JOIN app_users u ON u.id = m.user_id
   WHERE m.tenant_id = current_tenant_id()
     AND m.revoked_at IS NULL
   ORDER BY
     CASE m.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'pastor' THEN 3
                 WHEN 'staff' THEN 4 ELSE 5 END,
     u.full_name
$fn$;
GRANT EXECUTE ON FUNCTION church_users() TO hispren_app;

COMMIT;

-- ============================================================================
-- THE ROLES, AND WHAT THEY ARE FOR
--
--   owner    The pastor. Everything, including billing and removing people.
--   admin    The church secretary. Everything except billing.
--            APPROVES expenses — and so must not be the treasurer.
--   pastor   Sees GENOTYPE and pastoral care. Every read is logged.
--   staff    The treasurer, the ushers, the cell leaders. Records attendance,
--            counts offerings, registers members. RECORDS expenses, cannot
--            approve them.
--   viewer   Read only. A board member who should see the numbers and touch
--            nothing.
--
-- The separation that matters: STAFF records the money, ADMIN approves it.
-- One person doing both is how a church loses money it never knew it had.
-- ============================================================================
