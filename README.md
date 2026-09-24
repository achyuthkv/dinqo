# Dinqo

Dinqo runs sports communities over WhatsApp. It's a SaaS: one Dinqo WhatsApp number serves every community on the platform. Players never install an app. They join, mark availability, book, pay, cancel and check their history in WhatsApp. Organisers run their community from the web console.

Starting with pickleball in Bengaluru. **Dink Over Coffee (DOC)** is the pilot community.

## How the platform fits together

```
                      ┌──────────────── Dinqo (one Meta-verified business) ────────────────┐
 Players ── WhatsApp ──▶  one shared number  ──▶  bot routes each message to a community    │
                      │                                                                    │
 Organisers ── web ────▶  console (WhatsApp OTP login) — sees only their own communities    │
                      │                                                                    │
 Game fees ── UPI ─────▶  Dinqo's Razorpay ──Route──▶ community's bank account (minus fee)  │
                      └────────────────────────────────────────────────────────────────────┘
```

- **Communities are tenants.** Each has its own members, games, venues, weekly series, polls, staff and payout account. Organisers can only see and act on communities where they are staff. Every API route checks this.
- **Players are shared.** A player's profile (name, areas, times, level) belongs to them and carries across communities. When they join a second community, only that community's consent question is asked.
- **Consent is per community.** Saying yes to DOC's invites says nothing about any other community. STOP opts out of everything; START opts back in to every community the player belongs to.
- **Routing on one number:**
  - Players join through a community's link, `wa.me/<dinqo>?text=join doc`, or by typing `join <code>`.
  - Buttons carry their game, poll or community, so a tap always lands in the right place.
  - Free text goes to the player's current community. If they belong to several and none is current, the bot asks which one they mean. The menu has "Switch community".
- **Quality protection for the shared number.** A new community is `pending` until the Dinqo team approves it. Pending or suspended communities can set everything up but can't send polls or invites. The 7-day marketing cap applies across all communities, so one busy community can't flood a player.

## What each community gets (Phase 1)

| Capability | How it works |
|---|---|
| **Member registration** | Players join with the community's link. Profile, then consent for that community. With `join_policy: approval`, the organiser approves requests in the console and the player is notified. CSV import for existing lists. |
| **Invite-only plays** | Games are `invite_only` by default. Only invited members can book. A skipped invite (no consent, over the cap) doesn't count as an invitation. |
| **Mon/Wed availability** | On poll days (default Mon and Wed, 09:00 IST, configurable per community), **regulars** get the week's games. Each tap is an RSVP. Wednesday only nudges people with unanswered games. |
| **Fill remaining slots** | **Fill** ranks guests and non-responding regulars by time, area, skill, recent play and reliability, and invites about 1.5× the open slots. |
| **Slot confirmation** | "I'm in" holds a seat for 30 min with a UPI link. Payment confirms. Free games confirm at once. A reminder goes out halfway through the hold. |
| **Waitlist** | A freed seat is offered to the longest-waiting player for 60 min, then passes down the queue. |
| **Payments and payouts** | Razorpay Payment Links on Dinqo's account. **Route** transfers the community's share (price − platform fee) to its linked account. Transfers are held until 24h after the game so cancellations can still be reversed. |
| **Refunds** | Full refund before the deadline, then a configurable late percentage. Before refunding, the community's transfer is reversed; anything beyond it comes out of the platform fee. |
| **Attendance and history** | The organiser marks Played / No-show. Players reply "history" (per community). The console shows a per-member timeline. |
| **Recurring plays** | Weekly series generate each week's games ahead of the poll. |
| **Staff** | Owners add organisers by phone. Everyone logs in with a WhatsApp code. |

## Quick start

Requires Node 22.13+. The database is SQLite through `node:sqlite`, so there are no other services to run.

```bash
npm install
cp .env.example .env
npm run seed        # DOC (open) + HSR Smash Club (approval), venues, series, members
npm run dev
```

- **Console:** http://localhost:3000/admin. Log in with a seeded number; in dev the code is shown on screen.
  - `9845000000`: Dinqo platform admin (Platform tab: approve communities, set payout accounts and fees)
  - `9845000100`: DOC owner
  - `9845000200`: Smash owner
  - any other number: create a new community (it starts as pending)
- **WhatsApp simulator:** http://localhost:3000/dev/simulator. Try `join doc` or `join smash` from a new number.

```bash
npm test            # 31 end-to-end tests on a manual clock with fake WhatsApp + Razorpay
npm run typecheck
```

## Architecture

```
WhatsApp Cloud API ──▶ /webhooks/whatsapp ─┐  verify signature, dedupe by id, store, 200 fast
Razorpay ────────────▶ /webhooks/payments ─┤
                                           ▼
                                 durable job queue (SQLite)
       ┌───────────────┬───────────────┬───┴──────────┬───────────────┬──────────────┐
   Bot router     Booking engine      Polls       Events/Fill       Members          Auth
  (community     (holds, payments,   (Mon/Wed)   (series, invites, (tenants, staff, (OTP, sessions)
   routing,       waitlist, Route,                ranking)          consent, tiers)
   onboarding)    refunds, attendance)
       └───────────────┴───────┬───────┴──────────────┘
                               ▼
         Outbox: community active? · per-community consent · global 7-day cap · idempotency
                               ▼
         send job: session message inside the 24h window, else the approved template
```

- **WhatsApp is transport, not the database.** State lives in `registrations`, `payments`, `refunds` and `registration_log`. Every change is a conditional update in a transaction.
- **Nothing is lost on failure.** Sends, payment links, transfers, reversals and refunds are all jobs with retry and backoff.
- **Idempotent everywhere.** Replayed webhooks and double taps change nothing.
- **Provider-neutral.** `MessagingProvider` and `PaymentProvider` are interfaces.
- **Schema migrations** live in `src/db/migrations/NNN_*.sql` and are tracked with `PRAGMA user_version`.

```
src/
  app.ts                 wiring, webhook ingestion, join links
  auth.ts                WhatsApp OTP login + sessions
  bot/router.ts          every WhatsApp conversation, community routing
  domain/booking.ts      seats, holds, payments, Route transfers, waitlist, refunds, attendance
  domain/polls.ts        availability rounds
  domain/events.ts       games, series, invitations, candidate ranking + fill
  domain/members.ts      communities, staff, players, memberships, consent, import
  domain/history.ts      member stats + timeline
  messaging/             outbox policy, templates, copy, Cloud API + console providers
  payments/              Razorpay (Links, Refunds, Route) + fake provider
  http/server.ts         console API (tenant-scoped), platform API, webhooks, dev tools
public/                  admin.html (console), simulator.html
test/                    end-to-end tests incl. tenancy, isolation and payouts
```

## Going live

### 1. WhatsApp: Dinqo's own Meta business

Dinqo, not any one community, is the WhatsApp business.

1. Verify **Dinqo's** legal entity in a Meta Business Portfolio. Use a GST, Udyam or incorporation document whose name and address match exactly.
2. Create a developer app, add WhatsApp, and register a **dedicated Dinqo number** with display name "Dinqo". Set a 2-step PIN and add a payment method.
3. Submit every template from `GET /api/templates` (platform key or admin login). Names, parameter order and buttons must match exactly.
   - `dinqo_login_code` is an **Authentication** template with a copy-code button.
   - `dinqo_availability_poll` and `dinqo_game_invite` are **Marketing**.
   - The rest are **Utility**.
4. Webhook: `https://<host>/webhooks/whatsapp`, subscribed to `messages`.
5. Set these in `.env`:
   - `WHATSAPP_PROVIDER=cloud`
   - `WHATSAPP_ACCESS_TOKEN` (a system-user token)
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_DISPLAY_NUMBER` (digits, used in join links)

### 2. Razorpay with Route

1. Activate Dinqo's Razorpay account and ask Razorpay to **enable Route**.
2. For each community, create a **Linked Account** in the Razorpay dashboard. The organiser completes KYC with their bank details.
3. Paste its `acc_…` id and the platform fee into the console's **Platform** tab. Any payouts that were waiting are released automatically.
4. Webhook: `https://<host>/webhooks/payments` for `payment_link.paid`, `payment_link.expired`, `refund.processed` and `refund.failed`. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`.

Razorpay's own gateway fees are charged to Dinqo's account; set the platform fee to cover them.

### 3. Deploy

- Node 22 with a persistent disk for `DATABASE_PATH`. Run a single instance.
- Set `NODE_ENV=production`. The server refuses to start with the default admin key, with dev tools on, without the Meta app secret, with placeholder join-link or admin numbers, or with fake payments.
- Set `PLATFORM_ADMIN_PHONES` to the Dinqo team's numbers.

### Onboarding a new community

1. The organiser opens the console, logs in with a WhatsApp code and creates the community (pending).
2. They add venues and weekly series, and import members.
3. Dinqo checks them and sets status **active**. Once their Route linked account is ready, Dinqo adds it in the Platform tab.
4. The organiser shares their join link in their WhatsApp group. Polls start on the next poll day.

### Launch gate

- [ ] Dinqo business verified; dedicated number with recovery access
- [ ] All templates approved (including the authentication template)
- [ ] Route enabled; DOC linked account created and tested with a real ₹1 game
- [ ] Onboarding consent and STOP tested on the real number
- [ ] Webhook signature, dedup and retries tested against real providers
- [ ] `WEEKLY_INVITE_CAP` tuned
- [ ] 20–30 real DOC games before onboarding community #2

## API

Browsers use the session cookie from `/auth/verify`. Scripts use `Authorization: Bearer <session token>` for an organiser, or `Bearer $ADMIN_API_KEY` for platform automation. Cookie writes must be same-origin JSON.

| Method | Path | Who |
|---|---|---|
| POST | `/auth/request-code` `{phone}` · `/auth/verify` `{phone, code}` · `/auth/logout` | anyone |
| GET | `/auth/me` | logged in |
| GET/POST | `/api/communities` | own list / self-serve create (pending) |
| GET/PATCH | `/api/communities/:id` | staff; owner edits name, areas, join policy; platform sets `status`, `payout_account_id`, `platform_fee_bps` |
| GET | `/api/communities/:id/dashboard` | staff |
| GET/POST/DELETE | `/api/communities/:id/staff[/:playerId]` | owner (list: staff) |
| GET | `/api/communities/:id/members/pending` · POST `…/members/:playerId/approve` · `…/reject` | staff |
| GET · POST `import` · PATCH `/:playerId` · GET `/:playerId/history` | `/api/communities/:id/members…` | staff |
| PATCH | `/api/communities/:id/poll-settings` · POST `…/polls/run` · GET `…/polls` | staff |
| GET/POST | `…/venues` · `…/series` · POST `…/series/generate` · PATCH `/api/series/:id` | staff |
| GET/POST | `/api/communities/:id/events` · GET/PATCH `/api/events/:id` | staff |
| POST | `/api/events/:id/{invite,fill,attendance,cancel,registrations}` · GET `candidates` | staff |
| GET | `/api/communities/:id/refunds` · POST `/api/refunds/:id/retry` | staff |
| GET | `/api/admin/communities` · `/api/templates` | platform |

## What's next

- **Razorpay linked accounts from the console:** create and KYC them via the Route API instead of the dashboard.
- **Phase 2, smarter filling:** automatic waves, acceptance probability, auto-fill before start, community analytics.
- **Ops:**
  - Postgres (the `Db` wrapper is the seam) so more than one server instance can run.
  - Alerting on failed jobs, transfers and refunds.
  - Per-community message cost reporting (messages already carry `community_id`).
- **Own-number upgrade:** larger communities connect their own WhatsApp number through Meta Embedded Signup (needs Tech Provider status).
- **Phase 3, tournaments:** cross-community audiences built on platform-wide `tournaments` consent.
