# Hispren — deploy

## 1. Neon SQL Editor (browser), in this order

| # | File | |
|---|---|---|
| 1 | `001_foundation.sql` | object model + RLS |
| 2 | `002_platform.sql` | sessions, outbox, files, billing |
| 3 | `03_create_roles.sql` | **edit both passwords first** |
| 4 | `04_verify_isolation.sql` | **must be ALL GREEN. Do not proceed otherwise.** |
| 5 | `003_nigerian_fields.sql` | three-part names, two SIMs, state of origin, genotype |
| 6 | `004_import_dedupe.sql` | bulk import + duplicate detection |
| 7 | `005_attendance.sql` | services, sessions, offline scans |
| 8 | `006_groups_events_reports.sql` | recursive groups, calendar, reports |
| 9 | `007_notifications.sql` | messages, templates, suppression, DND cache |
| 10 | `05_seed_church.sql` | Dominion Chapel + login |
| 11 | `08_go_live.sql` | SMS credit, templates, services |

*(Already run some? They're idempotent. Re-running is safe.)*

Login: **dominion** / `pastor@dominion.test` / `DominionPastor2026`

## 2. Push

    npm install
    npm run check      # typecheck + frontend syntax + handler resolution
    git add . ; git commit -m "..." ; git push

## 3. Railway

Variables:

    DATABASE_URL          postgresql://hispren_app:...@ep-...-pooler.../neondb?sslmode=require
    PLATFORM_DATABASE_URL postgresql://hispren_platform:...@ep-...-pooler.../neondb?sslmode=require
    BASE_DOMAIN           hispren.up.railway.app

**Never `MIGRATION_DATABASE_URL`.** That's the owner role, and RLS does not apply
to table owners. If the running app holds it, every isolation policy is bypassed.

Redis and `TERMII_API_KEY` are optional. Without them the API still runs — the
worker is off, and SMS is in dry-run.

---

## What's built

| Screen | |
|---|---|
| Overview | KPIs, who needs a call, data health, groups |
| Members | search, register, edit, archive, QR, genotype (pastor-only, audited) |
| Attendance | offline QR scanner + manual mark sheet + unregistered headcount |
| Groups | recursive hierarchy, leaders, membership, roll-up counts |
| Calendar | recurring services AND one-off events |
| Reports | trend, funnel, at-risk, growth |
| Messages | GSM-7 counter, full suppression layer, campaigns, message log |
| Tasks & Care | owned follow-ups, prayer/counselling/hospital queue |
| Duplicates | review and merge, never automatic |
| Import | CSV with column guessing, preview, revert |
| Export | CSV, Excel-safe, every download audited |
| Settings | church, brand, health toggle, custom fields |

Scanner: `/scan.html` — works with no internet.

## Known gaps

- **SMS is in dry-run.** Live sending needs a sender ID from Termii: CAC
  certificate + a stamped letter per operator. See `sender-id-letter.md`.
- **The DND route may not be obtainable.** The NCC restricts DND-capable
  ("Corporate Bind") sender IDs to banks. Without it, DND-registered numbers
  cannot be reached by SMS at all — and Hispren will tell you so rather than
  pretend. WhatsApp may have to become the primary channel.
- **The mandatory opt-out line is not in the templates.** The NCC requires
  "Reply STOP to opt out" at the end of every commercial SMS. Sending without it
  is how a sender ID gets blocked.
- **Phase 2 (automation engine) not started.** Every module already emits events
  into the outbox. Nothing is listening yet.
