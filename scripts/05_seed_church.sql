-- ============================================================
-- STEP 5 — SEED A WORKING CHURCH
-- Paste into Neon SQL Editor and Run. No terminal needed.
--
-- Prereqs: 001, 002, 03_create_roles, 003, 004 already run.
--
-- Creates:
--   Church:   Dominion Chapel International   (subdomain: dominion)
--   Login:    pastor@dominion.test
--   Password: DominionPastor2026
--   Hierarchy: HQ -> Zone -> Branch -> Cell + Choir
--   6 members, including two deliberate near-duplicates
--
-- Safe to re-run: it wipes and recreates this one church.
-- ============================================================

DO $$
DECLARE
  t   uuid := 'aaaa0000-0000-0000-0000-000000000001';
  u   uuid;
  hq  uuid := gen_random_uuid();
  zn  uuid := gen_random_uuid();
  br  uuid := gen_random_uuid();
  cl  uuid := gen_random_uuid();
  ch  uuid := gen_random_uuid();
  s   jsonb := '{}';
  r   record;
  pid uuid;
BEGIN
  ----------------------------------------------------------------
  -- Provisioning is a PLATFORM operation — exactly how signup works
  ----------------------------------------------------------------
  SET LOCAL ROLE hispren_platform;
  DELETE FROM tenants WHERE id = t;
  INSERT INTO tenants (id, name, subdomain, timezone, plan_tier, member_band,
                       status, collects_health_data)
  VALUES (t, 'Dominion Chapel International', 'dominion', 'Africa/Lagos',
          'growth', 'b751_2000', 'active', true);

  DELETE FROM app_users WHERE email = 'pastor@dominion.test';
  INSERT INTO app_users (email, full_name, password_hash)
  VALUES ('pastor@dominion.test', 'Pastor Tunde Adeyemi',
          '$argon2id$v=19$m=65536,t=3,p=4$pqMPMHWuQaqpgN4UTgJW0g$4hQK8tnSOQWfv0gDKvPQlV6df4WfmwAC6EGmt2GEqrE')
  RETURNING id INTO u;

  INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (t, u, 'owner');
  RESET ROLE;

  ----------------------------------------------------------------
  -- Everything below is TENANT-scoped, as the app role
  ----------------------------------------------------------------
  SET LOCAL ROLE hispren_app;
  PERFORM set_config('app.tenant_id', t::text, true);

  -- lifecycle pipeline
  INSERT INTO journey_stages (tenant_id, key, label, position, is_billable_default) VALUES
    (t,'visitor','Visitor',0,false),      (t,'first_timer','First Timer',1,false),
    (t,'convert','Convert',2,true),       (t,'member','Member',3,true),
    (t,'worker','Worker',4,true),         (t,'leader','Leader',5,true),
    (t,'pastor','Pastor',6,true);

  FOR r IN SELECT id, key FROM journey_stages WHERE tenant_id = t LOOP
    s := s || jsonb_build_object(r.key, r.id);
  END LOOP;

  -- Pentecostal custom properties
  PERFORM seed_pentecostal_properties(t);

  -- one recursive table, the whole hierarchy
  INSERT INTO groups (id, tenant_id, group_type, name)
    VALUES (hq, t, 'headquarters', 'Dominion Chapel HQ, Lagos');
  INSERT INTO groups (id, tenant_id, parent_id, group_type, name) VALUES
    (zn, t, hq, 'zone',       'Lagos Mainland Zone'),
    (br, t, zn, 'branch',     'Ikeja Branch'),
    (cl, t, br, 'cell',       'Ogba House Fellowship'),
    (ch, t, br, 'department', 'Choir');

  -- members
  INSERT INTO persons (tenant_id, journey_stage_id, home_group_id,
      first_name, middle_name, last_name, gender, date_of_birth, marital_status,
      phone, phone_2, email, address, town, lga, state_of_origin, lga_of_origin,
      occupation, workplace, post_held, usual_service, source)
  VALUES
    (t, (s->>'worker')::uuid, cl,
     'Chinedu','Emeka','Okonkwo','male','2001-03-14','single',
     '+2348031234567','+2349087654321','chinedu@example.com',
     '14 Ilaro Road','Igbesa','Ado-Odo/Ota','Anambra','Idemili North',
     'Student','Federal Polytechnic Ilaro','Cell Coordinator','2nd Service','paper_form'),

    (t, (s->>'first_timer')::uuid, br,
     'Blessing',NULL,'Adeyemi','female','1998-07-22',NULL,
     '+2348022221111',NULL,NULL,
     NULL,'Ikeja','Ikeja','Ogun',NULL,
     'Nurse',NULL,NULL,'1st Service','visitor_card'),

    (t, (s->>'leader')::uuid, ch,
     'Amaka',NULL,'Nwosu','female','1985-11-02','married',
     '+2348033334444',NULL,NULL,
     NULL,'Ogba','Ikeja','Imo',NULL,
     'Trader',NULL,'Choir Leader','1st Service','manual'),

    (t, (s->>'member')::uuid, cl,
     'Tobi',NULL,'Balogun','male','1993-01-30',NULL,
     '+2348055556666',NULL,NULL,
     NULL,'Agege','Agege','Oyo',NULL,
     'Driver',NULL,NULL,'3rd Service','bulk_import'),

    -- deliberate near-duplicate of Chinedu: SAME PHONE, name shortened
    (t, (s->>'visitor')::uuid, br,
     'Chinedu',NULL,'Okonkwo','male',NULL,NULL,
     '+2348031234567',NULL,NULL,
     NULL,NULL,NULL,NULL,NULL,
     NULL,NULL,NULL,'2nd Service','visitor_card'),

    -- a DIFFERENT person with a very common Nigerian name. Must NOT be merged.
    (t, (s->>'member')::uuid, cl,
     'Chinedu',NULL,'Okafor','male','1990-05-09','married',
     '+2348077778888',NULL,NULL,
     NULL,'Ojodu','Ikeja','Enugu',NULL,
     'Electrician',NULL,NULL,'1st Service','manual');

  -- group membership + flag duplicates for HUMAN review (never auto-merge)
  FOR r IN SELECT id, home_group_id FROM persons WHERE tenant_id = t LOOP
    INSERT INTO group_memberships (tenant_id, group_id, person_id, role)
      VALUES (t, r.home_group_id, r.id, 'member') ON CONFLICT DO NOTHING;
    INSERT INTO duplicate_candidates (tenant_id, person_a, person_b, score, reasons)
      SELECT t, r.id, d.candidate_id, d.score, d.reasons
        FROM find_duplicates(r.id) d WHERE d.score >= 0.6
      ON CONFLICT DO NOTHING;
  END LOOP;

  -- genotype on the cell coordinator: AS. A pastor should see this before he
  -- marries this young man to another AS carrier.
  SELECT id INTO pid FROM persons
    WHERE tenant_id = t AND first_name = 'Chinedu' AND middle_name = 'Emeka';
  INSERT INTO person_health (person_id, tenant_id, blood_group, genotype,
                             consent_given, consent_at, recorded_by)
  VALUES (pid, t, 'O+', 'AS', true, now(), u);

  RESET ROLE;
END $$;

-- ------------------------------------------------------------------
-- What you just created
-- ------------------------------------------------------------------
SET ROLE hispren_app;
SELECT set_config('app.tenant_id', 'aaaa0000-0000-0000-0000-000000000001', false);

SELECT 'members'            AS item, count(*)::text AS value FROM persons
UNION ALL
SELECT 'groups',            count(*)::text FROM groups
UNION ALL
SELECT 'duplicates flagged', count(*)::text FROM duplicate_candidates WHERE status='open'
UNION ALL
SELECT 'lifecycle stages',  count(*)::text FROM journey_stages
UNION ALL
SELECT 'custom properties', count(*)::text FROM custom_property_definitions;

RESET ROLE;

-- ------------------------------------------------------------------
--   Church:   Dominion Chapel International   (subdomain: dominion)
--   Login:    pastor@dominion.test
--   Password: DominionPastor2026
-- ------------------------------------------------------------------
