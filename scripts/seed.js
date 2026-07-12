/**
 * Seed a working church so you can actually log in and see something.
 *
 *   node scripts/seed.js
 *
 * Creates:
 *   - tenant "Dominion Chapel" at dominion.localhost
 *   - admin login: pastor@dominion.test / DominionPastor2026
 *   - HQ -> Zone -> Branch -> Cell + Choir department
 *   - lifecycle stages
 *   - 6 members, including two deliberate near-duplicates
 */
require("dotenv").config();
const { Pool } = require("pg");
const argon2 = require("argon2");
const { randomUUID } = require("crypto");

const app = new Pool({ connectionString: process.env.DATABASE_URL });
const plat = new Pool({ connectionString: process.env.PLATFORM_DATABASE_URL });

const T = "aaaa0000-0000-0000-0000-000000000001";
const EMAIL = "pastor@dominion.test";
const PASSWORD = "DominionPastor2026";

async function inTenant(fn) {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL app.tenant_id = '${T}'`);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

(async () => {
  // ---- tenant + user: PLATFORM operations, before any tenant context exists
  await plat.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  await plat.query(
    `INSERT INTO tenants (id, name, subdomain, timezone, plan_tier, member_band,
                          status, collects_health_data)
     VALUES ($1,'Dominion Chapel International','dominion','Africa/Lagos',
             'growth','b751_2000','active',true)`, [T]);

  const hash = await argon2.hash(PASSWORD);
  await plat.query(`DELETE FROM app_users WHERE email = $1`, [EMAIL]);
  const u = await plat.query(
    `INSERT INTO app_users (email, full_name, password_hash)
     VALUES ($1,'Pastor Tunde Adeyemi',$2) RETURNING id`, [EMAIL, hash]);
  const userId = u.rows[0].id;
  await plat.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`,
    [T, userId]);

  // ---- everything below is TENANT-scoped
  await inTenant(async (c) => {
    // lifecycle pipeline
    const stages = [
      ["visitor","Visitor",0,false], ["first_timer","First Timer",1,false],
      ["convert","Convert",2,true],  ["member","Member",3,true],
      ["worker","Worker",4,true],    ["leader","Leader",5,true],
      ["pastor","Pastor",6,true],
    ];
    for (const [k,l,p,b] of stages) {
      await c.query(
        `INSERT INTO journey_stages (tenant_id,key,label,position,is_billable_default)
         VALUES (current_tenant_id(),$1,$2,$3,$4)`, [k,l,p,b]);
    }
    const st = {};
    for (const r of (await c.query(`SELECT id,key FROM journey_stages`)).rows) st[r.key] = r.id;

    // Pentecostal custom properties
    await c.query(`SELECT seed_pentecostal_properties(current_tenant_id())`);

    // hierarchy — one recursive table
    const hq   = randomUUID(), zone = randomUUID(), branch = randomUUID();
    const cell = randomUUID(), choir = randomUUID();
    await c.query(`INSERT INTO groups (id,tenant_id,group_type,name)
                   VALUES ($1,current_tenant_id(),'headquarters','Dominion Chapel HQ, Lagos')`, [hq]);
    await c.query(`INSERT INTO groups (id,tenant_id,parent_id,group_type,name) VALUES
      ($1,current_tenant_id(),$2,'zone','Lagos Mainland Zone'),
      ($3,current_tenant_id(),$1,'branch','Ikeja Branch'),
      ($4,current_tenant_id(),$3,'cell','Ogba House Fellowship'),
      ($5,current_tenant_id(),$3,'department','Choir')`,
      [zone, hq, branch, cell, choir]);

    const people = [
      { first_name:"Chinedu", middle_name:"Emeka", last_name:"Okonkwo", gender:"male",
        date_of_birth:"2001-03-14", phone:"+2348031234567", phone_2:"+2349087654321",
        email:"chinedu@example.com", state_of_origin:"Anambra", lga_of_origin:"Idemili North",
        town:"Igbesa", lga:"Ado-Odo/Ota", occupation:"Student",
        workplace:"Federal Polytechnic Ilaro", post_held:"Cell Coordinator",
        usual_service:"2nd Service", stage:"worker", group:cell, source:"paper_form" },
      { first_name:"Blessing", last_name:"Adeyemi", gender:"female",
        date_of_birth:"1998-07-22", phone:"+2348022221111",
        town:"Ikeja", lga:"Ikeja", state_of_origin:"Ogun",
        occupation:"Nurse", usual_service:"1st Service",
        stage:"first_timer", group:branch, source:"visitor_card" },
      { first_name:"Amaka", last_name:"Nwosu", gender:"female",
        date_of_birth:"1985-11-02", phone:"+2348033334444",
        town:"Ogba", lga:"Ikeja", state_of_origin:"Imo",
        occupation:"Trader", usual_service:"1st Service",
        stage:"leader", group:choir, source:"manual" },
      { first_name:"Tobi", last_name:"Balogun", gender:"male",
        date_of_birth:"1993-01-30", phone:"+2348055556666",
        town:"Agege", lga:"Agege", state_of_origin:"Oyo",
        occupation:"Driver", usual_service:"3rd Service",
        stage:"member", group:cell, source:"bulk_import" },
      // --- deliberate near-duplicate of Chinedu: same phone, name shortened
      { first_name:"Chinedu", last_name:"Okonkwo", gender:"male",
        phone:"+2348031234567", usual_service:"2nd Service",
        stage:"visitor", group:branch, source:"visitor_card" },
      // --- a DIFFERENT person with a very common Nigerian name. Must NOT merge.
      { first_name:"Chinedu", last_name:"Okafor", gender:"male",
        date_of_birth:"1990-05-09", phone:"+2348077778888",
        town:"Ojodu", lga:"Ikeja", state_of_origin:"Enugu",
        occupation:"Electrician", usual_service:"1st Service",
        stage:"member", group:cell, source:"manual" },
    ];

    for (const p of people) {
      const { stage, group, ...f } = p;
      const cols = Object.keys(f), vals = Object.values(f);
      const ph = cols.map((_, i) => `$${i + 3}`).join(",");
      const r = await c.query(
        `INSERT INTO persons (tenant_id, journey_stage_id, home_group_id, ${cols.join(",")})
         VALUES (current_tenant_id(), $1, $2, ${ph}) RETURNING id`,
        [st[stage], group, ...vals]);
      await c.query(
        `INSERT INTO group_memberships (tenant_id,group_id,person_id,role)
         VALUES (current_tenant_id(),$1,$2,'member')`, [group, r.rows[0].id]);
      // flag duplicates for HUMAN review
      await c.query(
        `INSERT INTO duplicate_candidates (tenant_id,person_a,person_b,score,reasons)
         SELECT current_tenant_id(), $1, d.candidate_id, d.score, d.reasons
           FROM find_duplicates($1) d WHERE d.score >= 0.6
         ON CONFLICT DO NOTHING`, [r.rows[0].id]);
    }

    // genotype on the cell coordinator — AS, which a pastor should see
    const ch = await c.query(
      `SELECT id FROM persons WHERE first_name='Chinedu' AND middle_name='Emeka'`);
    await c.query(
      `INSERT INTO person_health (person_id,tenant_id,blood_group,genotype,
                                  consent_given,consent_at,recorded_by)
       VALUES ($1,current_tenant_id(),'O+','AS',true,now(),$2)`,
      [ch.rows[0].id, userId]);

    const dupes = await c.query(`SELECT count(*) n FROM duplicate_candidates WHERE status='open'`);
    const mem   = await c.query(`SELECT count(*) n FROM persons WHERE archived_at IS NULL`);
    console.log(`\n  ${mem.rows[0].n} members seeded`);
    console.log(`  ${dupes.rows[0].n} duplicate pair(s) queued for review\n`);
  });

  await app.end(); await plat.end();

  console.log("  Church:    Dominion Chapel International");
  console.log("  Subdomain: dominion");
  console.log(`  Login:     ${EMAIL}`);
  console.log(`  Password:  ${PASSWORD}\n`);
  console.log("  Start the API:   npm run dev");
  console.log("  Then:            curl -H 'Host: dominion.localhost' http://localhost:3000/healthz\n");
})().catch((e) => { console.error("\nSEED FAILED:", e.message, "\n"); process.exit(1); });
