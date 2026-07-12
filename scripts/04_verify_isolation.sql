-- ============================================================
-- STEP 4 — VERIFY TENANT ISOLATION
-- Paste into Neon SQL Editor and Run. Read the results table.
--
-- Every row must say PASS. If any row says FAIL, STOP.
-- A cross-tenant leak of member or giving data is not a bug —
-- it is the end of the company.
--
-- Safe to re-run. Cleans up after itself.
-- ============================================================

DROP TABLE IF EXISTS iso_results;
CREATE TABLE iso_results(check_name text, result text, status text);

DO $$
DECLARE
  a uuid := '11111111-1111-1111-1111-111111111111';
  b uuid := '22222222-2222-2222-2222-222222222222';
  pid uuid;
  g1 uuid;
  g2 uuid;
  n int;
  nm text;
  ok boolean;
BEGIN
  -------------------------------------------------------------------
  -- Seed as the PLATFORM role. Provisioning a church is a platform
  -- operation — this is exactly how signup works in production.
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_platform;
  DELETE FROM tenants WHERE id IN (a, b);
  INSERT INTO tenants (id, name, subdomain) VALUES
    (a, 'Iso Church A', 'iso-a'), (b, 'Iso Church B', 'iso-b');
  RESET ROLE;

  -- member data is written as the TENANT role, inside Church A's context
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  INSERT INTO persons (tenant_id, first_name, last_name, date_of_birth)
    VALUES (a, 'Amaka', 'Okafor', '1990-03-14') RETURNING id INTO pid;
  INSERT INTO groups (tenant_id, group_type, name)
    VALUES (a, 'branch', 'Lagos Branch') RETURNING id INTO g1;
  INSERT INTO groups (tenant_id, parent_id, group_type, name)
    VALUES (a, g1, 'cell', 'Ogba Cell') RETURNING id INTO g2;
  RESET ROLE;

  -------------------------------------------------------------------
  -- 1. Church B lists persons
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', b::text, true);
  SELECT count(*) INTO n FROM persons;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('B lists all persons',
    n || ' rows', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 2. Church B fetches A's member by primary key
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', b::text, true);
  SELECT count(*) INTO n FROM persons WHERE id = pid;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('B fetches A''s member by ID',
    n || ' rows', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 3. Church B writes INTO Church A (WITH CHECK)
  -------------------------------------------------------------------
  ok := false;
  BEGIN
    SET LOCAL ROLE hispren_app;
    PERFORM set_config('app.tenant_id', b::text, true);
    INSERT INTO persons (tenant_id, first_name) VALUES (a, 'Intruder');
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('B writes into A''s church',
    CASE WHEN ok THEN 'blocked' ELSE 'ALLOWED' END,
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 4. Church B overwrites A's member
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', b::text, true);
  UPDATE persons SET first_name = 'Hacked' WHERE id = pid;
  RESET ROLE;
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  SELECT first_name INTO nm FROM persons WHERE id = pid;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('B overwrites A''s member',
    'name is still ' || nm, CASE WHEN nm = 'Amaka' THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 5. Church B deletes A's member
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', b::text, true);
  DELETE FROM persons WHERE id = pid;
  RESET ROLE;
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  SELECT count(*) INTO n FROM persons WHERE id = pid;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('B deletes A''s member',
    CASE WHEN n = 1 THEN 'member survived' ELSE 'DELETED' END,
    CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 6. No tenant context — must be 0 rows, not ALL rows
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO n FROM persons;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('no tenant set (fail-closed)',
    n || ' rows', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 7. Church B reads A's tenant record
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', b::text, true);
  SELECT count(*) INTO n FROM tenants WHERE id = a;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('B reads A''s tenant record',
    n || ' rows', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 8. PLATFORM role CAN resolve subdomain -> tenant (or nobody logs in)
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_platform;
  SELECT count(*) INTO n FROM tenants WHERE subdomain IN ('iso-a','iso-b');
  RESET ROLE;
  INSERT INTO iso_results VALUES ('platform resolves subdomain (login works)',
    n || ' of 2 tenants', CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 9. PLATFORM role is BLIND to church member data
  --    It runs the relay and billing. It must never see a member.
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_platform;
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO n FROM persons;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('platform CANNOT read members',
    n || ' rows', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 10. PLATFORM role CAN read the outbox (or automation never fires)
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  INSERT INTO event_outbox (tenant_id, event_type, entity_type)
    VALUES (a, 'visitor.registered', 'person');
  RESET ROLE;
  SET LOCAL ROLE hispren_platform;
  SELECT count(*) INTO n FROM event_outbox WHERE published_at IS NULL;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('platform reads outbox (relay works)',
    n || ' unpublished', CASE WHEN n >= 1 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 11. RLS enabled AND forced on every tenant table
  -------------------------------------------------------------------
  SELECT count(*) INTO n FROM pg_class
   WHERE relname IN ('persons','households','groups','group_memberships','tasks',
                     'care_requests','segments','segment_members','consents',
                     'consent_events','event_outbox','files','journey_stages',
                     'person_milestones','person_stage_history','audit_log',
                     'custom_property_definitions','tenant_memberships','tenant_domains')
     AND (NOT relrowsecurity OR NOT relforcerowsecurity);
  INSERT INTO iso_results VALUES ('all tenant tables RLS-protected',
    CASE WHEN n = 0 THEN '19 of 19 protected' ELSE n || ' TABLES EXPOSED' END,
    CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 12. Group hierarchy rejects cycles
  -------------------------------------------------------------------
  ok := false;
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  BEGIN
    UPDATE groups SET parent_id = g2 WHERE id = g1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('group cycle rejected',
    CASE WHEN ok THEN 'blocked' ELSE 'ALLOWED' END,
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END);

  -------------------------------------------------------------------
  -- 13. Birthday generated columns
  -------------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  SELECT (dob_month = 3 AND dob_day = 14) INTO ok FROM persons WHERE id = pid;
  RESET ROLE;
  INSERT INTO iso_results VALUES ('birthday columns generated',
    'dob 1990-03-14 to month 3, day 14',
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END);

  -- cleanup
  SET LOCAL ROLE hispren_platform;
  DELETE FROM tenants WHERE id IN (a, b);
  RESET ROLE;
END $$;

SELECT check_name AS "check", result, status FROM iso_results;

SELECT CASE WHEN count(*) = 0
       THEN 'ALL GREEN — isolation verified AND the platform layer can function.'
       ELSE 'SUITE FAILED — ' || count(*) || ' check(s) failed. Do not proceed.'
       END AS verdict
FROM iso_results WHERE status = 'FAIL';

DROP TABLE iso_results;
