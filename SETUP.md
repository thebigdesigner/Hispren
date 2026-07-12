# Hispren — setup

## 1. Database (Neon, browser only)

Neon SQL Editor, in order:

| File | What it does |
|---|---|
| `01_foundation.sql` | object model + RLS |
| `02_platform.sql`   | sessions, outbox, files, billing |
| `03_create_roles.sql` | **edit both passwords first** — creates `hispren_app` + `hispren_platform` |
| `04_verify_isolation.sql` | 13 checks. Must be ALL GREEN. |

## 2. `.env`

Copy `.env.example` to `.env` and fill in three URLs.

- `MIGRATION_DATABASE_URL` — `neondb_owner`. **Migrations only.** Never reaches the app.
- `DATABASE_URL` — `hispren_app`. Pooled host. Tenant-scoped, RLS enforced.
- `PLATFORM_DATABASE_URL` — `hispren_platform`. Pooled host. Cross-tenant, platform tables only.

Passwords: letters and numbers only. Symbols break URL parsing and PowerShell.

## 3. Prove the stack

    npm install
    npm run smoke

Must print **ALL GREEN**. It checks, from Node, through Neon's pooler:
- both roles connect, neither owns tables
- Church B cannot read, write, or overwrite Church A
- 30 interleaved A/B queries with no tenant-context bleed across pooled connections
- the platform role CAN resolve a subdomain (or nobody can log in)
- the platform role CANNOT read members

If it isn't green, stop. Nothing built on a leaking foundation is worth building.

## 4. Run it

    npm run dev      # API
    npm run worker   # relay + scheduled jobs (second terminal)

## Non-negotiables

- The app never connects as the owner role. RLS does not apply to table owners.
- All church data goes through `withTenant()`. There is no raw query for tenant tables.
- `platformQuery()` is greppable on purpose. Every call site gets reviewed.
