-- Schema for the rail_first_seat availability finder.
-- The server applies this automatically at boot; you can also paste it into
-- the Supabase SQL editor (Dashboard -> SQL Editor -> New query) to set up by hand.
-- Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS trains (
  train_number      TEXT PRIMARY KEY,
  train_name        TEXT,
  origin_city       TEXT,
  destination_city  TEXT,
  zone              TEXT,
  opening_time      TEXT,
  running_days      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  off_day           TEXT,
  total_duration    TEXT,
  stop_count        INTEGER,
  route_synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stations (
  city_name   TEXT PRIMARY KEY,
  label       TEXT,
  train_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stops (
  train_number   TEXT    NOT NULL REFERENCES trains(train_number) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  city_name      TEXT    NOT NULL,
  arrival_time   TEXT,
  departure_time TEXT,
  halt_minutes   INTEGER,
  duration_raw   TEXT,
  PRIMARY KEY (train_number, seq)
);
CREATE INDEX IF NOT EXISTS idx_stops_city  ON stops(city_name);
CREATE INDEX IF NOT EXISTS idx_stops_train ON stops(train_number);

-- One row per (route, journey date, moment we looked).
CREATE TABLE IF NOT EXISTS snapshots (
  id            BIGSERIAL   PRIMARY KEY,
  from_city     TEXT        NOT NULL,
  to_city       TEXT        NOT NULL,
  journey_date  DATE        NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL,
  captured_date DATE        NOT NULL,
  days_ahead    INTEGER,
  source        TEXT        NOT NULL,
  train_count   INTEGER     NOT NULL DEFAULT 0,
  total_seats   INTEGER     NOT NULL DEFAULT 0,
  ok            BOOLEAN     NOT NULL DEFAULT TRUE,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_route_date
  ON snapshots(from_city, to_city, journey_date, captured_at);
CREATE INDEX IF NOT EXISTS idx_snap_captured ON snapshots(captured_date);

-- Per-train, per-class seat counts belonging to one snapshot.
CREATE TABLE IF NOT EXISTS seat_counts (
  snapshot_id    BIGINT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  train_number   TEXT,
  train_name     TEXT,
  departure_time TEXT,
  arrival_time   TEXT,
  seat_class     TEXT   NOT NULL,
  online_seats   INTEGER NOT NULL DEFAULT 0,
  offline_seats  INTEGER NOT NULL DEFAULT 0,
  fare           DOUBLE PRECISION,
  vat            DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_seat_counts_snap ON seat_counts(snapshot_id);

-- Routes the background collector keeps history for.
CREATE TABLE IF NOT EXISTS watchlist (
  from_city   TEXT        NOT NULL,
  to_city     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  PRIMARY KEY (from_city, to_city)
);

ALTER TABLE meta        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trains      ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stops       ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE seat_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist   ENABLE ROW LEVEL SECURITY;

-- People who can be alarmed. One row per Telegram chat that completed pairing.
CREATE TABLE IF NOT EXISTS notify_subscribers (
  id           BIGSERIAL   PRIMARY KEY,
  chat_id      TEXT        NOT NULL UNIQUE,
  display_name TEXT,
  -- Bearer secret handed to the browser once at pairing, so one person's
  -- alarms cannot be listed or cancelled from someone else's browser.
  access_token TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ
);

-- Short-lived codes that bind "this browser" to "that Telegram chat".
CREATE TABLE IF NOT EXISTS notify_pairings (
  code          TEXT        PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  subscriber_id BIGINT      REFERENCES notify_subscribers(id) ON DELETE CASCADE,
  claimed_at    TIMESTAMPTZ
);

-- One pending alarm: fire when this journey date's sale opens.
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGSERIAL   PRIMARY KEY,
  subscriber_id   BIGINT      NOT NULL REFERENCES notify_subscribers(id) ON DELETE CASCADE,
  from_city       TEXT        NOT NULL,
  to_city         TEXT        NOT NULL,
  journey_date    DATE        NOT NULL,
  -- Frozen at creation from saleOpening(); the sale instant for a given date
  -- never moves, and freezing it keeps the scheduler a pure index scan.
  opens_at        TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL,
  fired_at        TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  rings_sent      INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT
);
-- Test alarms are real rows travelling the real scheduler path, marked so they
-- neither consume one of the three slots nor collide with a genuine alarm.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
-- The message currently ringing. Each new ring deletes the previous one, so the
-- chat keeps one live alarm rather than a wall of duplicates.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_message_id BIGINT;

-- The 3-per-person cap counts only 'active' rows, and the same route+date may
-- be alarmed again after a previous one fired, so uniqueness is partial too.
DROP INDEX IF EXISTS idx_alerts_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_real_unique
  ON alerts(subscriber_id, from_city, to_city, journey_date)
  WHERE status = 'active' AND is_test = FALSE;
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(status, opens_at);
CREATE INDEX IF NOT EXISTS idx_alerts_sub ON alerts(subscriber_id, status);

ALTER TABLE notify_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify_pairings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts             ENABLE ROW LEVEL SECURITY;
