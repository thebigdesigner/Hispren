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

LAYOUT — Bankio reference. Do not redesign; reskin only.
- Page canvas #E9EFEF. Each screen is a white rounded card (16px) floating on
  it. Sidebar lives INSIDE the white card, not outside it.
- Sidebar (148px): logo + chevron -> "MAIN MENU" section label -> nav items
  (icon + label) -> "OTHERS" section label -> Settings, Support.
  Active item = charcoal pill, white text. Inactive = #5A686E text.
- Header: "Welcome, {first_name}" + one-line subtitle. Right cluster: circular
  outline icon buttons (search, mail, bell) + avatar circle. Hairline divider under.
- Title row: screen title (16px/500) + pill search field + filter icon, right-aligned.
- Stat row: 3 columns — (1) two stacked stats with arrow + delta chip + "Last
  month" caption, (2) headline stat + inner #E9EFEF card w/ sparkline,
  (3) dark charcoal highlight card.
- Chart row: donut w/ center label + legend rows (dot, name, count, %) |
  bar chart w/ y-axis labels + period dropdown pill.
- Table screen: compact stat row w/ vertical dividers, then charcoal header row,
  avatar+name cells, status pills, hairline row borders.

PALETTE (REF 3) — five colors, no others.
  --charcoal  #394449   structure: sidebar active, dark cards, bars, primary text
  --slate     #97A7AB   labels, muted text, secondary data
  --offwhite  #E9EFEF   page canvas, dividers, inner cards
  --amber     #F7A81B   avatar, alerts, tertiary data
  --orange    #F08200   ENERGY: the live/urgent number only

  Derived: text-mid #5A686E - slate-tint #E4EAEB (+ text #4A5A60)
           amber-tint #FDF0DA (+ text #8A5A00) - orange-tint #FBE3D0 (+ text #A85A00)

RULES
- Orange marks the LIVE or URGENT figure (this Sunday's bar, at-risk count,
  live scan rate). Never decorative. Charcoal carries structure; slate carries
  everything muted.
- Text on a tinted chip uses the dark shade of that same tint. Never black.
- Status pills: Contacted = amber tint - Pending = slate tint - Overdue = orange tint.
- Delta chips: growth = amber tint - decline = slate tint.
- Radius: 16px screens, 12px cards, 10px inner, 20px pills.
- Two weights only: 400 regular, 500 for values and active items.
- Sentence case everywhere. Never Title Case.
- Tenant brand_color may override --orange only. Charcoal/slate/offwhite are fixed.
- Multi-service is first-class: attendance is per-service (1st/2nd/3rd), never a
  single undifferentiated number.

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
