# Hispren — the full pack

---

## 1. Neon SQL Editor (browser), in this exact order

| # | File | |
|---|---|---|
| 1 | `001_foundation.sql` | object model + RLS |
| 2 | `002_platform.sql` | sessions, outbox, files, billing |
| 3 | `03_create_roles.sql` | **edit BOTH passwords first** |
| 4 | `04_verify_isolation.sql` | **13 checks. Must be ALL GREEN. Do not proceed otherwise.** |
| 5 | `003_nigerian_fields.sql` | three-part names, two SIMs, state of origin, genotype |
| 6 | `004_import_dedupe.sql` | bulk import + duplicate detection |
| 7 | `005_attendance.sql` | services, sessions, offline scans |
| 8 | `006_groups_events_reports.sql` | recursive groups, calendar, reports |
| 9 | `007_notifications.sql` | messages, suppression layer, DND cache |
| 10 | `008_optout_email.sql` | the NCC-mandated opt-out line, email templates |
| 11 | `009_giving.sql` | funds, counting sessions, **the restricted-fund guard** |
| 12 | `010_users.sql` | **users, roles, invitations, account lockout** |
| 12b | `011_whatsapp.sql` | **WhatsApp — the way around bulk SMS** |
| 13 | `05_seed_church.sql` | Dominion Chapel + the first login |
| 14 | `08_go_live.sql` | SMS credit, templates, services, funds |

Every one is idempotent. Re-running what you have already run is safe.

    Church:   dominion
    Login:    pastor@dominion.test
    Password: DominionPastor2026

---

## 2. Push

    npm install
    npm run check      # types + route collisions + frontend syntax + handlers
    git add . ; git commit -m "..." ; git push

**Run `npm run check` before every push.** Half a second. It is the difference
between finding a boot crash in your terminal and finding it in a Railway log
after the site is already down. Every one of its four gates exists because
something actually broke.

---

## 3. Railway → Variables

    DATABASE_URL          postgresql://hispren_app:...@ep-...-pooler.../neondb?sslmode=require
    PLATFORM_DATABASE_URL postgresql://hispren_platform:...@ep-...-pooler.../neondb?sslmode=require
    BASE_DOMAIN           hispren.up.railway.app

**NEVER `MIGRATION_DATABASE_URL`.** That is the owner role, and RLS does not
apply to table owners. If the running app ever holds it, every isolation policy
in this product is silently bypassed.

Optional:

    RESEND_API_KEY     live email.  Without it: dry run.   <-- GET THIS FIRST
    EMAIL_FROM         Dominion Chapel <hello@yourdomain.com>

    WHATSAPP_TOKEN     Meta Cloud API. Real bulk WhatsApp. NO TELCO INVOLVED.
    WHATSAPP_PHONE_ID  Set neither and WhatsApp still works — by hand, for free,
                       one tap per person, from the church's own number.

    TERMII_API_KEY     live SMS. Blocked on a sender ID + the DND route.
    PUBLIC_URL       used in invitation links
    REDIS_URL        optional. Without it the queue runs IN the API process,
                     which is correct below ~10 churches.

---

## What is built

| Screen | |
|---|---|
| Home | Payoneer-style: alert strip, balances, who needs you, funds |
| Members | register · search · edit · archive · QR · history · genotype (pastor-only, every read logged) |
| Lists | **smart** (questions answered live) + **saved** (hand-picked). Both messageable. |
| Attendance | offline QR scanner · manual mark sheet · newcomer at the door · unregistered headcount |
| Groups | recursive hierarchy · leaders · roll-up counts |
| Families | households, roles, message a whole family |
| Calendar | recurring services AND one-off events |
| **Giving** | counting sessions · anonymous cash · named envelopes · pledges |
| **Finance** | funds · expenses · approval · income statement · **the restricted-fund guard** |
| Messages | GSM-7 counter · channel cascade · full suppression layer · message log |
| Follow-ups | owned tasks |
| Pastoral care | prayer, counselling, hospital |
| Reports | trend · funnel · at-risk · growth |
| Duplicates | review and merge. Never automatic. |
| Import | CSV, column guessing, preview, **undo** |
| Export | CSV, Excel-safe, every download audited |
| **Who can log in** | **users · roles · invitations · lockout** |
| Settings | church · brand · health toggle · custom fields |

Scanner: `/scan.html` — works with **no internet at all**.
Join page: `/join.html` — an invited person sets their own password.

---

## The five things no competitor does

**Tenant isolation enforced by the database, not by code.** A forgotten `WHERE`
returns zero rows, not everyone's rows. Verified thirteen ways, on Neon, from
Node, through the pooler, with thirty interleaved queries proving no context
bleed between churches on a shared connection.

**The restricted-fund guard.** Money given for the building CANNOT be spent on
salaries — and CANNOT take the fund into deficit. Two separate refusals, both at
the database. Planning Center allows it. ChurchTrac allows it. A spreadsheet
certainly allows it. This is where a treasurer's trouble begins, and Hispren
simply will not commit the transaction.

**An attendance scanner that works with no signal.** 3,000 people in 30 minutes
is 1.7 scans a second. A round-trip per scan backs the gate up and the church is
back on paper by week three. The roster is cached on the phone; a scan is a local
lookup; the queue syncs when the signal returns. Double-scans are absorbed
silently. First scan wins, because that is when they arrived.

**The suppression layer sits at the SEND boundary.** A church admin cannot even
*build* a message that reaches someone who opted out, or died, or has already had
four texts this week. And a suppressed message is never a silent no-op — it is a
row, with a reason. When a pastor says "she never got it", the answer is one
query away.

**Email first, SMS as the fallback.** One message to 1,832 members: **NGN 8,244**
by SMS, **NGN 2,826** by cascade. NGN 281,736 a year on one weekly reminder.
Email has no DND register, no 160-character tax, no 8pm cutoff. It is how a
Nigerian church can afford to communicate at all.

---

## What is NOT built

- **Phase 2 — the automation engine.** Every module already emits events into
  `event_outbox`. Nothing listens yet. This is the difference between a filing
  cabinet and an assistant.
- **Child check-in.** Breeze's second-biggest selling point. Safety-critical.
- **Volunteer rotas.** Who is on duty Sunday.
- **Member self-service.** Cuts admin work AND keeps the data fresh.
- **Two-way messaging.** The STOP webhook exists; Termii has never been told the
  URL, so a reply goes nowhere.
- **Photos.** The column exists; there is no upload.

## You do NOT need bulk SMS

| | Setup | Cost | Blocked by |
|---|---|---|---|
| **Email** | none | **free, unlimited** | nothing |
| **WhatsApp, by hand** | **none** | **free** | nothing |
| WhatsApp Cloud API | Meta business account, ~2 days | cheap | **no telco at all** |
| Bulk SMS | CAC + 4 stamped letters | NGN 4.50/page | sender ID + DND route |

**WhatsApp needs no telco, no sender ID, no DND register, and no NCC approval.**
Meta does not care that you are not a bank. And Nigerians LIVE on WhatsApp — a
message from the church arrives beside their family, not in the SMS folder they
stopped opening in 2019.

**And it works today, with nothing set up.** Compose, pick WhatsApp, and Hispren
hands the secretary a tap-through list: she taps a name, WhatsApp opens with the
message already written, she presses send. It goes from **the church's own
number**. For the thirty-four first-timers who need reaching this Sunday, that is
not a workaround — it is better than a bulk SMS, because it arrives as a real
message from a real person.

For a whole congregation: **WhatsApp broadcast lists**. 256 people each, a native
feature of the phone in her hand, costs nothing, and every recipient sees a
PRIVATE message rather than a group. Hispren exports the numbers ready to paste.

    One message to 1,832 members:
      SMS to everyone          NGN 8,244   BLOCKED - no sender ID
      Email + WhatsApp         NGN     0   works TODAY

    Every Sunday, for a year:  NGN 428,688 saved.

## What is blocked on paperwork, not code

- **Live SMS.** Needs a sender ID: CAC certificate plus a stamped letter to each
  of MTN, Airtel, Glo, 9mobile. See `sender-id-letter.md`.
- **The DND route.** The NCC restricts DND-capable ("Corporate Bind") sender IDs
  to banks. Without it, DND-registered numbers cannot be reached by SMS **at
  all** — and Hispren will tell you so, rather than pretend the message went.
  **Ask Termii the blunt question before you chase letters for three weeks.**
