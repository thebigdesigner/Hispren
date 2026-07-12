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

LAYOUT — Prodify reference. Soft, warm, human. Not a banking dashboard.
- Page canvas #FAFAFC. Cards are white with a 1px #F0F0F5 border and 16px radius.
  NO heavy shadows. Airy, generous whitespace.
- Sidebar (196px): user profile card at the TOP (avatar + name + "Online" in mint).
  Nav items are icon + label, 11px radius. ACTIVE = pale violet pill (#EDE9FE) with
  violet text. Below the nav, a "My church" section with colour-dotted group rows.
  A violet promo card sits at the bottom.
- Greeting is two lines: "Hello there" in dark, then a question in a
  mint-to-violet GRADIENT ("How is the church doing today?"). This is the signature.
- Action pills under the greeting: first one violet-filled with a sparkle icon
  ("Ask Hispren"), the rest white with a hairline border.
- Card headers: violet icon + 13px semibold title.
- Progress bars: 6px, fully rounded, on a #F1F1F6 track.
- Status pills: 8px radius, tinted background + matching dark text, 500 weight.
- Everything is ROUNDED and SOFT. No hard edges, no dark chrome.

PALETTE (Prodify)
  --violet      #6D4AFF   primary: buttons, active nav, headline emphasis
  --violet-dk   #5B3FD9   text on pale violet
  --violet-soft #EDE9FE   active nav pill, tints
  --violet-wash #F7F5FF   hover states, inner tiles
  --mint        #2DD4BF   positive/live: online dot, gradient start, good progress
  --mint-dk     #0F766E   text on mint tint
  --coral       #FB7185   urgent: duplicates, overdue, at-risk
  --coral-dk    #BE3455   text on coral tint
  --amber       #FB923C   warning: incomplete data
  --page        #FAFAFC
  --card        #FFFFFF   --line #F0F0F5   --line2 #F5F5F9
  --text        #1F2033   --muted #9195A8
  --chip        #F1F1F6 (+ text #6B7080)

RULES
- Violet is the product. Mint is life and progress. Coral is what needs a human.
  Amber is data that is merely incomplete. Never decorative.
- The gradient headline (mint to violet) appears once per screen, in the greeting.
- Font: Plus Jakarta Sans. Weights 400/500/600 only.
- Sentence case everywhere.
- Tenant brand_color may override --violet only.
- Multi-service is first-class: attendance shows 1st/2nd/3rd as separate tiles,
  the largest one filled violet. Never a single undifferentiated number.

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
