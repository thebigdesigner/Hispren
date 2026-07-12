-- ============================================================
-- STEP 3 — Application roles + platform policies
-- Paste into Neon SQL Editor and Run.
-- Idempotent: safe to run again if you already ran an earlier version.
--
-- TWO ROLES, and the split matters:
--
--   hispren_app       Tenant-scoped. RLS enforced. Handles ~all traffic.
--                     Cannot read across tenants. Cannot see another
--                     church's members, ever.
--
--   hispren_platform  Cross-tenant, but ONLY on platform tables:
--                     tenants, domains, memberships, outbox, billing.
--                     Needed for: hostname→tenant resolution, login,
--                     the event relay, and billing jobs — all of which
--                     must work BEFORE a tenant context exists.
--                     It CANNOT read persons, households, giving, or any
--                     other church data. Verified in step 4.
--
-- CHANGE BOTH PASSWORDS BELOW. Letters and numbers only, 12+ chars.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hispren_app') THEN
    CREATE ROLE hispren_app LOGIN PASSWORD 'ChangeMeAppPw2026';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hispren_platform') THEN
    CREATE ROLE hispren_platform LOGIN PASSWORD 'ChangeMePlatformPw2026';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO hispren_app, hispren_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO hispren_app, hispren_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO hispren_app, hispren_platform;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hispren_app, hispren_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hispren_app, hispren_platform;

-- Membership so the SQL Editor can SET ROLE for the isolation test (step 4).
-- Postgres 16 needs explicit membership to SET ROLE, even for a role you created.
GRANT hispren_app, hispren_platform TO CURRENT_USER;

-- ------------------------------------------------------------------
-- PLATFORM POLICIES
-- Postgres policies are PERMISSIVE and OR'd together. So adding a
-- policy scoped TO hispren_platform grants that role full access to
-- these tables, while hispren_app remains bound by tenant_isolation.
--
-- ONLY these tables. Church data (persons, households, groups,
-- care_requests, tasks, consents, ...) gets NO platform policy —
-- the platform role is blind to it by construction.
-- ------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants',                      -- provisioning + subdomain lookup + billing iteration
    'tenant_domains',               -- hostname -> tenant at the edge
    'tenant_memberships',           -- login, before tenant context exists
    'event_outbox',                 -- the relay ships events across tenants
    'subscriptions',
    'invoices',
    'member_metering_snapshots',
    'credit_wallets',
    'credit_ledger'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', t);
    EXECUTE format($p$
      CREATE POLICY platform_access ON %I
        FOR ALL TO hispren_platform
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END $$;

-- These billing tables have no tenant_id column, so they were never
-- RLS-protected; the platform role reads them directly.
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_lines, dunning_events, plan_prices
  TO hispren_platform;

-- ------------------------------------------------------------------
-- Confirm neither app role owns any table.
-- RLS does NOT apply to table owners — if an app role owned a table,
-- every policy on it would be silently inert.
-- ------------------------------------------------------------------
SELECT
  'table owner: ' || (SELECT tableowner FROM pg_tables WHERE tablename = 'persons')
  || '  |  app roles must differ from this'  AS separation_check;
