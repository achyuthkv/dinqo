# Dinqo

A WhatsApp-native operating system for sports communities, starting with pickleball in Bengaluru. Dink Over Coffee is the design partner.

Players never install an app. They register, mark their availability, book, pay, cancel and check their history in WhatsApp. Organisers run everything from a small web console.

## Phase 1 scope

| Capability | How it works |
|---|---|
| **Member registration** | A new number messages the business. The bot asks for name, areas, preferred times and level, then asks for consent to receive invites. Organisers can also import an existing member list as CSV. |
| **Invite-only plays** | Games are `invite_only` by default. Only players with an invitation can book. The availability poll and "Fill" both create invitations. |
| **Mon/Wed availability** | Every Monday and Wednesday at 09:00 IST (configurable), **regulars** get the week's open games. Each tap is an RSVP. "Can't make any" records a decline. Wednesday only nudges people who still have unanswered games. |
| **Fill remaining slots** | The organiser taps **Fill** on a game. The system ranks **guests** and non-responding regulars by time, area, skill, recent play and reliability, and invites about 1.5× the open slots. |
| **WhatsApp registration** | Interactive buttons and lists inside the 24h window. Outside the window, approved templates with quick-reply buttons are used. |
| **Slot confirmation** | "I'm in" holds a seat for 30 minutes and sends a UPI payment link. Payment confirms the booking. Free games confirm instantly. A payment reminder goes out halfway through the hold. |
| **Waitlist** | When a game is full the player is offered the waitlist. A freed seat is offered to the longest-waiting player for 60 minutes, then passes to the next. |
| **Payments** | Razorpay Payment Links (UPI, cards). Signed webhooks are deduplicated. Late payments are honoured if a seat is free and refunded otherwise. Duplicate payments are refunded. |
| **Refunds** | Full refund until the game's cancellation deadline, then a configurable late percentage. The organiser cancelling a game or removing a player always refunds in full. Failed refunds are retried and shown in the console. |
| **Attendance** | The organiser marks Played / No-show per player. Games auto-complete at their end time. |
| **Member history** | Players reply "history" in WhatsApp. Organisers see a per-member timeline with played, no-shows, cancellations, attendance rate and net paid. |
| **Recurring plays** | Weekly series (e.g. "Sunday 7am, Play Mania, 16 players, ₹350") generate each week's games before the poll. |

## Quick start

Requires Node 22.13+. There are no other services to run: the database is SQLite through `node:sqlite`.

```bash
npm install
cp .env.example .env        # the defaults work locally
npm run seed                # DOC-like community, venues, weekly series, 5 members
npm run dev
```

- Organiser console: http://localhost:3000/admin (API key `dev-admin-key`)
- WhatsApp simulator: http://localhost:3000/dev/simulator. Pick a seeded player or type a new number and say "hi".

Try the whole loop: click **Send poll now** in the console. In the simulator, open the poll as Rahul (9845000001), pick a game and tap **Pay** (a fake UPI page). Back in the console, click **Fill** on a game and invite guests.

```bash
npm test          # end-to-end flows on a manual clock with fake providers
npm run typecheck
```

## Architecture

```
WhatsApp Cloud API ──webhook──▶ /webhooks/whatsapp ─┐   verify signature, dedupe by message id,
Razorpay ───────────webhook──▶ /webhooks/payments ─┤   store, return 200 fast
                                                   ▼
                                        jobs (SQLite, durable, retried)
                                                   │
          ┌───────────────┬──────────────┬─────────┴──────┬────────────────┐
          ▼               ▼              ▼                ▼                ▼
      Bot router     Booking engine    Polls          Events/Fill       Members
   (onboarding,     (holds, payments, (Mon/Wed      (series, invites, (profiles, tiers,
    menus, taps)     waitlist, refunds, rounds)      candidate ranking) consent, import)
                     attendance)
          └───────────────┴───────┬──────┴────────────────┘
                                  ▼
                     Outbox: consent · 7-day cap · idempotency key
                                  ▼
                 send job: session message if the 24h window is open,
                 otherwise the approved template (see /api/templates)
```

Design rules (from the WhatsApp limitations doc):

- **WhatsApp is transport, not the database.** All state lives in `registrations`, `payments` and `refunds`. Every change is a conditional update in a transaction, logged to `registration_log`.
- **Nothing is lost on failure.** Every external call (send, payment link, refund) is a job that is retried with backoff. Timers (hold expiry, offers, reminders, polls) are jobs too.
- **Idempotent everywhere.** Inbound message ids and payment event ids are unique, and every outbound message has an idempotency key. Replayed webhooks change nothing.
- **Consent-first.** Invites and polls need `community_games` consent and count toward a weekly cap. STOP revokes consent immediately. Booking updates still go out.
- **Provider-neutral.** `MessagingProvider` and `PaymentProvider` are interfaces. The domain never builds a Meta payload.

Layout:

```
src/
  app.ts                 wiring + webhook ingestion
  bot/router.ts          every WhatsApp conversation
  domain/booking.ts      seats, holds, payments, waitlist, cancellations, refunds, attendance
  domain/polls.ts        Mon/Wed availability rounds
  domain/events.ts       games, weekly series, invitations, candidate ranking + fill
  domain/members.ts      players, memberships (regular/guest), consent, CSV import
  domain/history.ts      member stats + timeline
  messaging/             outbox policy, templates, copy, Cloud API + console providers
  payments/              Razorpay + fake provider
  jobs/queue.ts          durable job queue
  http/server.ts         organiser API, webhooks, dev tools
public/                  admin.html (organiser console), simulator.html
test/                    end-to-end flow tests
```

## Going live

### 1. WhatsApp (Meta)

1. Create a Meta Business account, get it verified and add a **dedicated** phone number to a WhatsApp Business app.
2. Submit every template from `GET /api/templates` in WhatsApp Manager. Names, parameter order and button order must match exactly. `dinqo_availability_poll` and `dinqo_game_invite` are **Marketing**; the rest are **Utility**.
3. Set the webhook URL to `https://<host>/webhooks/whatsapp` with your `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.
4. Set `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_ACCESS_TOKEN` (a system-user token), `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_APP_SECRET`.

### 2. Razorpay

1. Set `PAYMENTS_PROVIDER=razorpay`, `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Add a webhook to `https://<host>/webhooks/payments` for `payment_link.paid`, `payment_link.expired`, `refund.processed` and `refund.failed`. Put its secret in `RAZORPAY_WEBHOOK_SECRET`.

### 3. Deploy

- Run on any Node 22 host with a persistent disk for `DATABASE_PATH`.
- Set `NODE_ENV=production`. The server refuses to start with the default admin key, with dev tools on, or without the Meta app secret.
- Run a single instance: the job runner and SQLite assume one process. The Postgres move is noted below.

### Launch gate (from the limitations doc)

- [ ] Business verified, dedicated number with recovery access
- [ ] All templates approved
- [ ] Onboarding captures consent; STOP tested
- [ ] Webhook signature, dedup and retries tested against the real providers
- [ ] Weekly cap tuned (`WEEKLY_INVITE_CAP`)
- [ ] Payment and refund flows tested end-to-end in Razorpay test mode
- [ ] 20–30 real DOC games before expanding

## Organiser API

All `/api/*` routes need `Authorization: Bearer $ADMIN_API_KEY`.

| Method | Path | |
|---|---|---|
| GET/POST | `/api/communities` | list / create (`name`, `slug`, `locations[]`) |
| GET | `/api/communities/:id/dashboard` | upcoming games, fill, revenue, next poll |
| PATCH | `/api/communities/:id/poll-settings` | `poll_days`, `poll_time`, `poll_horizon_days`, `poll_enabled` |
| POST | `/api/communities/:id/polls/run` | send an availability round now |
| GET | `/api/communities/:id/polls` | rounds and response counts |
| GET | `/api/communities/:id/members?q=` | members with stats |
| POST | `/api/communities/:id/members/import` | `{rows}`, `{csv}` or `text/csv` |
| PATCH | `/api/communities/:id/members/:playerId` | `tier`, `status`, profile fields |
| GET | `/api/communities/:id/members/:playerId/history` | stats and timeline |
| GET/POST | `/api/communities/:id/venues` | |
| GET/POST | `/api/communities/:id/series` · `PATCH /api/series/:id` | weekly series |
| POST | `/api/communities/:id/series/generate` | create upcoming games from series |
| GET/POST | `/api/communities/:id/events` | games |
| GET/PATCH | `/api/events/:id` | detail (registrations, invitations) / edit title, capacity… |
| POST | `/api/events/:id/invite` | `{player_ids}` |
| GET | `/api/events/:id/candidates` | ranked fill candidates |
| POST | `/api/events/:id/fill` | `{count?}` or `{player_ids}` |
| POST | `/api/events/:id/attendance` | `{marks: [{player_id, attendance}]}` |
| POST | `/api/events/:id/registrations` | organiser books a player |
| POST | `/api/events/:id/registrations/:playerId/cancel` | remove, full refund |
| POST | `/api/events/:id/cancel` | cancel the game, refund everyone |
| GET | `/api/refunds` · `POST /api/refunds/:id/retry` | |
| GET | `/api/templates` | templates to submit to Meta |

## What's next

- **Phase 2, smarter filling:** automatic waves (invite N, wait, invite the next N), acceptance probability from history, auto-fill X hours before start, community analytics.
- **Ops:** move SQLite to Postgres (the SQL is portable; the `Db` wrapper is the seam), per-organiser logins instead of a shared key, and alerting on failed jobs and refunds.
- **Phase 3, tournaments:** audience segments, campaigns and attribution. This needs separate `tournaments` consent, which the schema already has.
