# Phase 1 — Member CRM

## Apply the migrations (Neon SQL Editor, in the browser)

1. `003_nigerian_fields.sql`
2. `004_import_dedupe.sql`

## Then, in PowerShell

    npm install          # adds papaparse
    npm run seed         # creates a church + login + 6 members
    npm run dev          # API on :3000

The API now boots on **Postgres alone**. Redis is only needed for `npm run worker`
(the outbox relay and scheduled jobs) — you don't need it to see Members work.

## Log in

    Church:   Dominion Chapel International   (subdomain: dominion)
    Email:    pastor@dominion.test
    Password: DominionPastor2026

Because tenant is resolved from the hostname, set `BASE_DOMAIN=localhost` in
`.env` and call the API as `dominion.localhost:3000` — browsers and curl resolve
`*.localhost` to 127.0.0.1 with no hosts-file editing.

    curl -H "Host: dominion.localhost" http://localhost:3000/healthz

## Endpoints

| | |
|---|---|
| `GET /api/members` | list, search (`?q=`), filter by `stage`, `group_id`, `service` |
| `POST /api/members` | register |
| `GET /api/members/:id` | full record |
| `PATCH /api/members/:id` | update (logs lifecycle-stage history, emits an event) |
| `DELETE /api/members/:id` | archive — soft delete, never destructive |
| `GET /api/members/:id/qr` | QR token |
| `POST /api/members/:id/qr/rotate` | rotate a leaked QR without reprinting an ID |
| `GET /api/scan/:token` | scanner lookup — one indexed hit |
| `POST /api/households` · `GET /api/households/:id` | family grouping |
| `GET /api/duplicates` | the review queue |
| `POST /api/duplicates/merge` | admin only, snapshots the losing record first |
| `POST /api/import/preview` | CSV → column guesses, validation, warnings |
| `POST /api/import/commit` | writes the batch |
| `POST /api/import/:id/revert` | undo a bad import |
| `GET/PUT /api/members/:id/health` | **pastor/admin only. Every access audited.** |

## Decisions worth knowing

**Phone normalisation.** `08031234567` · `8031234567` · `+2348031234567` ·
`0803 123 4567` all become `+2348031234567` on write. Without this, duplicate
detection is worthless and SMS silently fails.

**Smart quotes are stripped on write.** One curly apostrophe pasted from Word
turns a 160-character GSM-7 SMS into a 70-character UCS-2 one and triples the
church's cost. Normalised at the door.

**Duplicate detection never fires on a name alone.** Nigerian names repeat
heavily — a 3,000-member church has many a "Chinedu Okonkwo". Name similarity
only scores when a phone, an email, or a date of birth corroborates it.

**Merges are never automatic.** A human confirms, the losing record is
snapshotted verbatim into `merge_log`, and empty fields on the survivor are
backfilled from the loser — a visitor card with only a phone number should
enrich the record, not be discarded.

**Imports are two-phase.** Preview shows column guesses, per-row warnings, and
what will be dropped. Commit writes. Revert archives the whole batch. A church
that loses 2,000 records to a bad import never trusts you again.

**Health data is separate, gated, and audited.** Genotype lives in
`person_health`, not on `persons`. Pastor/admin only. Every *read* writes an
`audit_log` row — not just writes. Opt-in per church, explicit consent required.
`hispren_platform` (billing, relay) cannot see it at all.
