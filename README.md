# Hispren Church OS

## Dev setup
    docker compose up -d
    npm install
    MIGRATION_DATABASE_URL=postgres://hispren_owner:dev@localhost:5432/hispren npm run migrate
    DATABASE_URL=postgres://hispren_app:dev_app_pw@localhost:5432/hispren npm run dev
    # worker (second terminal):
    DATABASE_URL=... REDIS_URL=redis://localhost:6379 npm run worker

## Non-negotiables (see CLAUDE.md)
- API connects as `hispren_app`, NEVER the owner role. RLS does not apply to owners.
- All tenant queries via `withTenant()`. `platformQuery()` is greppable and reviewed.
- `npm run test:isolation` is a merge gate. If it fails, the code is wrong, not the test.

## Deploy (launch posture)
- API + worker: Fly.io or Render (two processes, one image)
- Postgres: managed (Neon / Render PG / RDS) with PITR backups enabled
- Redis: managed (Upstash / Render)
- Storage: Cloudflare R2 (S3-compatible, no egress fees)
- DNS: wildcard `*.hispren.com` → LB; custom domains via CNAME later (Phase 8)
- Monitoring: healthz probe + provider alerts; add Sentry DSN via env
