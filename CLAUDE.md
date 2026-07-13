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

## Design system — Payoneer

THE CONCEPT
  Payoneer's dashboard has NO SIDEBAR. A hamburger, the page name, and that is
  it. The nav hides so the CONTENT is the hero. Then: an alert strip if
  something needs you, a "Balances" block, and a tabbed activity list.

  Their orange lives in the LOGO. The interface accent is BLUE — the active tab
  underline, "View all >". Orange/amber appears only in the alert strip.

TYPE
  Inter, everywhere. 400 / 500 / 600 / 700.
  Every figure carries font-variant-numeric: tabular-nums and -.02em tracking,
  so a column of naira lines up under itself.

SHELL
  A permanent DARK sidebar (#1A1A1A, 250px). White logo mark + wordmark at top,
  then nav. ACTIVE item = a lighter box (#2B2B2B) with a thin #4A4A4A OUTLINE —
  not a fill, not a bar. Small grey footer text at the bottom.
  Content: pure white. The utility cluster (help · bell · avatar + church name)
  FLOATS top-right with no bar and no border behind it.
  The page title is LARGE (34px, weight 500) and sits in the content, not in
  chrome.

THE BALANCES PATTERN — use it on every screen
  1. A grey section label ("Your church", "Funds", "Members")
  2. A running total in body text with the FIGURE in bold ink
  3. Cards you can walk into: coloured circle + big figure + one line + chevron

  Payoneer's whole dashboard is this. Every Hispren screen has one number that
  matters — how many members, how much is held, how many are waiting for a call.

THE ALERT STRIP
  Soft peach (#FDF1E7), amber triangle, the message, and a BOLD UPPERCASE LINK
  on the right — not a button. One at a time, and only when something genuinely
  needs a human.

TABS
  Blue 3px underline on the active one. "View all >" in blue on the right.
  Empty state is large, light grey, centred: "Nobody is waiting. Good."

PALETTE
  --ink        #1A1A2E   headings, figures
  --body       #4A4A5A   prose
  --muted      #8A8A9C   section labels, secondary
  --faint      #B8B8C4   chevrons, empty states
  --blue       #1A5FD0   THE interactive colour. Buttons, links, active tab.
  --orange     #FF4800   the logo mark ONLY. Never in the interface.
  --good       #00A868   --warn #F5A623   --bad #E5342A
  --canvas     #FFFFFF   --surface #F7F7FA   --line #E2E2E8

RULES
- Buttons are fully rounded (22px), solid blue, white text.
- The secondary action is not a button — it is a BOLD UPPERCASE LINK.
- Borders are 1px #E2E2E8. No shadows except a whisper on card hover.
- Colour states data, never decorates it.
- Multi-service is first-class: 1st/2nd/3rd tiles, the largest filled blue.
- Tenant brand_color may override --blue only.

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

## Postgres traps that already bit

**NEVER try/catch a failing query inside a transaction and carry on.**
Postgres ABORTS the entire transaction on the first error. Every query after it
returns "current transaction is aborted, commands ignored until end of
transaction block". A catch block that swallows the error does not recover — it
moves the crash one line down, where nobody is looking for it, and the user sees
a 500 with no explanation.

    // WRONG — the transaction is already dead by the time we get here
    try { await tx.query(`UPDATE wallet ...`); }
    catch { balance = null; }
    await tx.query(`UPDATE messages ...`);   // <- "transaction is aborted"

    // RIGHT — check first, then act
    const w = await tx.query(`SELECT balance FROM wallet ...`);
    if (!w.rows[0]) throw new Error("no wallet");
    await tx.query(`UPDATE wallet ...`);

If you genuinely need to recover mid-transaction, use a SAVEPOINT. Usually you
do not — a SELECT first is clearer and cheaper.

**Reserved words that are NOT obviously reserved:** `rollup`, `position`.
Both were used as identifiers and both were syntax errors.

## Testing rules

- Two-tenant adversarial suite runs on every commit: every endpoint hit from
  Tenant B's session against Tenant A's data. Assert failure.
- Never relax an RLS policy to make a test pass. If an isolation test fails,
  the code is wrong, not the test.
- Security-relevant diffs (auth, tenant resolution, RLS, finance) get human
  line-by-line review. Always flag these explicitly when producing them.
