# Hispren Church OS

Multi-tenant SaaS for Nigerian churches. Churches pay onboarding fees + monthly
subscriptions metered on ACTIVE members. We take NOTHING from giving — no payment
processing, no transaction fees. Finance module RECORDS and RECONCILES only.

## Invariants — NEVER violate

- Every tenant-scoped table has `tenant_id uuid NOT NULL`, indexed, FK to tenants.
- Tenant isolation is enforced by Postgres ROW-LEVEL SECURITY. Never by app code alone.
- `tenant_id` is resolved at the edge (hostname → tenant), set via
  `SET LOCAL app.tenant_id`, and bound to the session/transaction.
  Application code NEVER re-derives tenant from a request header.
- AI drafts. Humans send. No AI-generated message is ever auto-sent.
- Consent, frequency caps, quiet hours, and deceased-suppression are enforced at the
  ACTION/SEND layer. An admin must not be ABLE to build a workflow that violates them.
- No module hardcodes automation. Modules register triggers + actions into the engine.
- A `deceased` flag on person blocks ALL outbound communication, permanently.
- Soft-delete everywhere (`archived_at`); hard-delete only via NDPR erasure procedure.
- All money values: `numeric(14,2)`, currency code alongside. Never floats.
- All timestamps: `timestamptz`. Church-local display uses tenant timezone (default WAT).

## Object model

- **person** — one object for member/visitor/worker/leader/pastor/child,
  differentiated by lifecycle stage. NOT separate tables per type.
- **household** — family unit. Churches think in families.
- **group** — RECURSIVE. One table models branch → zone → department → unit → cell
  via `parent_id`. `group_type` distinguishes semantics. Do not create separate
  tables for departments vs cells vs branches.
- **journey** — lifecycle pipeline (Visitor → First Timer → Convert → Member →
  Worker → Leader). Stages are tenant-configurable, seeded with defaults.
- **care_request** — prayer / counselling / hospital / bereavement / benevolence.
  Assignment, SLA, closure.
- **task** — generic assignment object. Follow-ups are tasks.
- **custom properties** — definitions table + JSONB values on person/household/group.
  A Catholic parish and a Pentecostal megachurch need different fields.
- **segment** — static (explicit membership) and dynamic (stored filter definition,
  evaluated on read or materialised).
- **consent** — per person, per channel (sms/email/whatsapp/push/call).
  Granted/revoked with full audit trail. NDPR requirement.

## Pricing model (affects schema)

- Meter ACTIVE members (communicated-with or app-account), not roll size.
  Store everyone free; `person.is_billable` derived nightly.
- Member bands, not linear per-member. Growth protection: band crossings bill at
  renewal, not mid-term.
- Unlimited admin users. Never per-seat.
- Automation engine: flat fee, unlimited runs. NEVER task-metered.
- Metered credits: SMS, WhatsApp, email, AI.

## Stack

- Postgres 16 (RLS is the reason — non-negotiable)
- [API framework: TBD Day 1 decision]
- Redis for queue + cache
- Wildcard DNS `*.hispren.com` → edge → tenant resolution

## Design system

TYPE — three faces, each with a job. Never mix them up.
  DM Sans   headings, buttons, nav, labels, tags        400 / 500 / 600 / 700
  Karla     body prose                                  400 / 500 / 600 / 700
  DM Mono   EVERY FIGURE — counts, phone numbers, member codes, balances, IDs
            400 / 500, font-variant-numeric: tabular-nums

  The mono rule is not decoration. A column of phone numbers or attendance
  counts must line up digit-under-digit or the table cannot be scanned. If it
  is a number, it is DM Mono. No exceptions.

LAYOUT — Termii console.
- Near-black sidebar (#0D0F14, 236px). White cards on a #F7F8FA canvas.
- Sidebar: brand mark + wordmark, then slab labels (CHURCH / DATA) over nav groups.
  ACTIVE nav = #171A21 background + 2px GREEN left border + green icon + white text.
  Inactive = #8B92A0. Tenant identity pinned to the bottom, above a hairline.
- Page header: 28px DM Sans title + muted subtitle left, actions right.
- KPI row: 3px coloured left border stating the KPI's condition —
  green = fine, amber = someone is waiting, red = something is wrong.
  Label in caps DM Sans, big DM Mono figure, one line of context.
- Cards: white, 1px #E8EAEE, 12px radius, header with icon + rule beneath.
- Tables: uppercase micro headers, hairline rows, brand-wash hover.
  Flagged rows tinted red.

PALETTE
  --ink        #12141A   headings
  --body       #4A4F5C   prose
  --muted      #8B92A0   secondary
  --brand      #00C389   THE one green. Buttons, active nav, healthy state.
  --brand-deep #00674A   text on a green tint
  --warn       #F5A623   someone is waiting
  --bad        #E5484D   something is wrong
  --shell      #0D0F14   sidebar
  --shell-2    #171A21   active nav
  --canvas     #F7F8FA   --card #FFFFFF   --line #E8EAEE

RULES
- One green. Never introduce a second accent.
- Text on the green button is #062B20, not white — white on #00C389 fails contrast.
- Colour states data, never decorates it. If nothing is wrong the screen is calm.
- Multi-service is first-class: 1st/2nd/3rd as separate tiles, the largest filled
  green. Never a single undifferentiated attendance number.
- Tenant brand_color may override --brand only.

## Nigerian market constraints (do not "optimise" these away)

- SMS: 160 chars GSM-7 = 1 unit; ANY non-GSM char (curly quote, Yoruba diacritic)
  drops it to 70 chars/unit. Composer must show live unit count and normalise
  smart quotes.
- DND registry: promotional SMS blocked to DND numbers; corporate/transactional
  route required. Promotional window 8am–8pm WAT.
- WhatsApp Business API: pre-approved templates only outside 24hr session window.
- Attendance: 3,000 members / 30 min = 1.7 scans/sec sustained. QR validation is
  OFFLINE-FIRST: cached roster, local validation, sync queue.
- Many churches: paper registers + old Excel + WhatsApp groups. Import tooling and
  duplicate merge are core, not nice-to-have.

## Testing rules

- Two-tenant adversarial suite runs on every commit: every endpoint hit from
  Tenant B's session against Tenant A's data. Assert failure.
- Never relax an RLS policy to make a test pass. If an isolation test fails,
  the code is wrong, not the test.
- Security-relevant diffs (auth, tenant resolution, RLS, finance) get human
  line-by-line review. Always flag these explicitly when producing them.
