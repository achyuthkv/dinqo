-- Dinqo Phase 1 schema.
-- Conventions: ids are prefixed text ids, timestamps are UTC ISO-8601 strings,
-- money is integer paise. JSON columns hold small arrays/objects only.

CREATE TABLE IF NOT EXISTS communities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  locations     TEXT NOT NULL DEFAULT '[]',   -- areas offered during onboarding
  -- Availability poll: sent to regulars on these weekdays at poll_time (community-local).
  poll_enabled       INTEGER NOT NULL DEFAULT 1,
  poll_days          TEXT NOT NULL DEFAULT '["mon","wed"]',
  poll_time          TEXT NOT NULL DEFAULT '09:00',
  poll_horizon_days  INTEGER NOT NULL DEFAULT 7,
  created_at    TEXT NOT NULL
);

-- A player is a person, identified by phone, independent of any community.
CREATE TABLE IF NOT EXISTS players (
  id                   TEXT PRIMARY KEY,
  phone                TEXT NOT NULL UNIQUE,  -- E.164 without '+', as WhatsApp sends it
  name                 TEXT,
  skill_level          TEXT CHECK (skill_level IN ('beginner','intermediate','advanced')),
  preferred_locations  TEXT NOT NULL DEFAULT '[]',
  preferred_slots      TEXT NOT NULL DEFAULT '[]',
  last_inbound_at      TEXT,                  -- opens the 24h customer-service window
  blocked              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  community_id   TEXT NOT NULL REFERENCES communities(id),
  player_id      TEXT NOT NULL REFERENCES players(id),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','removed')),
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','organiser')),
  -- regulars get the Mon/Wed availability poll; guests are invited to fill open slots
  tier           TEXT NOT NULL DEFAULT 'guest' CHECK (tier IN ('regular','guest')),
  source         TEXT NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp','import','organiser')),
  joined_at      TEXT NOT NULL,
  PRIMARY KEY (community_id, player_id)
);

-- Purpose-based consent. One row per (player, purpose); revocation keeps the row.
CREATE TABLE IF NOT EXISTS consents (
  player_id       TEXT NOT NULL REFERENCES players(id),
  purpose         TEXT NOT NULL CHECK (purpose IN ('community_games','tournaments','venue_events','coaching','brands')),
  granted         INTEGER NOT NULL,
  source          TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (player_id, purpose)
);

-- Bot conversation state (onboarding steps, pending choices).
CREATE TABLE IF NOT EXISTS conversations (
  player_id    TEXT PRIMARY KEY REFERENCES players(id),
  community_id TEXT REFERENCES communities(id),
  state        TEXT NOT NULL DEFAULT 'idle',
  context      TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id            TEXT PRIMARY KEY,
  community_id  TEXT NOT NULL REFERENCES communities(id),
  name          TEXT NOT NULL,
  area          TEXT,
  maps_url      TEXT,
  created_at    TEXT NOT NULL
);

-- Weekly recurring plays. Events are generated from these ahead of each poll.
CREATE TABLE IF NOT EXISTS event_series (
  id                      TEXT PRIMARY KEY,
  community_id            TEXT NOT NULL REFERENCES communities(id),
  venue_id                TEXT REFERENCES venues(id),
  title                   TEXT NOT NULL,
  weekday                 TEXT NOT NULL CHECK (weekday IN ('mon','tue','wed','thu','fri','sat','sun')),
  start_time              TEXT NOT NULL,              -- 'HH:MM' community-local
  duration_minutes        INTEGER NOT NULL DEFAULT 120,
  capacity                INTEGER NOT NULL,
  skill_level             TEXT,
  price_paise             INTEGER NOT NULL DEFAULT 0,
  visibility              TEXT NOT NULL DEFAULT 'invite_only',
  cancel_hours_before     INTEGER NOT NULL DEFAULT 12, -- full refund until this many hours before start
  late_refund_percent     INTEGER NOT NULL DEFAULT 0,
  active                  INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id                      TEXT PRIMARY KEY,
  community_id            TEXT NOT NULL REFERENCES communities(id),
  series_id               TEXT REFERENCES event_series(id),
  venue_id                TEXT REFERENCES venues(id),
  title                   TEXT NOT NULL,
  starts_at               TEXT NOT NULL,
  ends_at                 TEXT NOT NULL,
  capacity                INTEGER NOT NULL CHECK (capacity > 0),
  skill_level             TEXT,
  price_paise             INTEGER NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  visibility              TEXT NOT NULL DEFAULT 'invite_only' CHECK (visibility IN ('invite_only','members')),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','closed','cancelled','completed')),
  cancellation_deadline   TEXT,                     -- full refund up to here
  late_refund_percent     INTEGER NOT NULL DEFAULT 0 CHECK (late_refund_percent BETWEEN 0 AND 100),
  hold_minutes            INTEGER NOT NULL DEFAULT 30,
  offer_minutes           INTEGER NOT NULL DEFAULT 60,
  reminder_hours_before   INTEGER NOT NULL DEFAULT 12,
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  UNIQUE (series_id, starts_at)
);

CREATE TABLE IF NOT EXISTS invitations (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  source        TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','poll','fill')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','accepted','declined','skipped')),
  skip_reason   TEXT,
  created_at    TEXT NOT NULL,
  responded_at  TEXT,
  UNIQUE (event_id, player_id)
);

-- A Mon/Wed availability round and who it went to.
CREATE TABLE IF NOT EXISTS availability_polls (
  id             TEXT PRIMARY KEY,
  community_id   TEXT NOT NULL REFERENCES communities(id),
  event_ids      TEXT NOT NULL,          -- JSON array of events included
  sent_at        TEXT NOT NULL,
  horizon_end    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_recipients (
  poll_id        TEXT NOT NULL REFERENCES availability_polls(id),
  player_id      TEXT NOT NULL REFERENCES players(id),
  status         TEXT NOT NULL CHECK (status IN ('sent','skipped','responded','not_this_week')),
  skip_reason    TEXT,
  responded_at   TEXT,
  PRIMARY KEY (poll_id, player_id)
);

-- One row per (event, player). Seat-occupying statuses: offered, held, confirmed.
CREATE TABLE IF NOT EXISTS registrations (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events(id),
  player_id        TEXT NOT NULL REFERENCES players(id),
  status           TEXT NOT NULL CHECK (status IN
                   ('waitlisted','offered','held','confirmed','cancelled','expired','declined')),
  waitlisted_at    TEXT,
  expires_at       TEXT,           -- for offered/held
  confirmed_at     TEXT,
  cancelled_at     TEXT,
  cancel_reason    TEXT,
  attendance       TEXT CHECK (attendance IN ('attended','no_show')),
  attendance_at    TEXT,
  amount_paise     INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (event_id, player_id)
);
CREATE INDEX IF NOT EXISTS registrations_event_status ON registrations(event_id, status);

-- Append-only history of every registration transition (member history + audit).
CREATE TABLE IF NOT EXISTS registration_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id  TEXT NOT NULL REFERENCES registrations(id),
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor            TEXT NOT NULL,   -- 'player' | 'organiser' | 'system'
  note             TEXT,
  at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT PRIMARY KEY,
  registration_id       TEXT NOT NULL REFERENCES registrations(id),
  provider              TEXT NOT NULL,
  provider_link_id      TEXT NOT NULL UNIQUE,
  provider_payment_id   TEXT UNIQUE,
  link_url              TEXT NOT NULL,
  amount_paise          INTEGER NOT NULL,
  refunded_paise        INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL CHECK (status IN ('created','paid','expired','cancelled')),
  created_at            TEXT NOT NULL,
  paid_at               TEXT
);
CREATE INDEX IF NOT EXISTS payments_registration ON payments(registration_id);

CREATE TABLE IF NOT EXISTS refunds (
  id                  TEXT PRIMARY KEY,
  payment_id          TEXT NOT NULL REFERENCES payments(id),
  provider_refund_id  TEXT UNIQUE,
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  status              TEXT NOT NULL CHECK (status IN ('pending','processed','failed')),
  reason              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  processed_at        TEXT
);

-- Message ledger: every inbound and outbound WhatsApp message.
CREATE TABLE IF NOT EXISTS messages (
  id                   TEXT PRIMARY KEY,
  player_id            TEXT REFERENCES players(id),
  direction            TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind                 TEXT NOT NULL,        -- text | interactive | template | button | ...
  template_name        TEXT,
  category             TEXT,                 -- utility | marketing | service
  body                 TEXT NOT NULL,        -- JSON payload (sent or received)
  status               TEXT NOT NULL,        -- queued | sent | delivered | read | failed | received | blocked
  provider_message_id  TEXT UNIQUE,
  idempotency_key      TEXT UNIQUE,
  event_id             TEXT,
  error                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_player ON messages(player_id, created_at);

-- Raw webhook deliveries, deduplicated by provider event id.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  payload            TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  processed_at       TEXT,
  error              TEXT,
  UNIQUE (provider, provider_event_id)
);

-- Durable job queue: timers (hold expiry, offers, reminders) and async work.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  run_at       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  unique_key   TEXT UNIQUE,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
