/* Minimal ordered migrator. Runs as MIGRATION_DATABASE_URL (owner role).
   Creates hispren_app role + grants on first run. */
const { Pool } = require("pg");
const fs = require("fs"), path = require("path");
(async () => {
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations
    (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
  const done = new Set((await pool.query(`SELECT name FROM _migrations`)).rows.map(r => r.name));
  const dir = path.join(__dirname, "..", "migrations");
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".sql") || done.has(f)) continue;
    console.log("applying", f);
    await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
    await pool.query(`INSERT INTO _migrations (name) VALUES ($1)`, [f]);
  }
  // App role (idempotent)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hispren_app') THEN
        CREATE ROLE hispren_app LOGIN PASSWORD 'dev_app_pw';
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO hispren_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hispren_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hispren_app;
  `);
  await pool.end();
  console.log("migrations complete");
})().catch(e => { console.error(e); process.exit(1); });
