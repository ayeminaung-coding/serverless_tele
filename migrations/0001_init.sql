-- T1: initial D1 schema.
-- Dates are ISO-8601 TEXT. Booleans are INTEGER 0/1 (SQLite has no bool).

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per Telegram channel this Worker may post to. chat_id is the
-- Bot API identifier: `@publicname` for public channels, `-100...` for
-- private ones (pasted manually by the operator; the bot must be admin).
CREATE TABLE IF NOT EXISTS telegram_channels (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  chat_id TEXT NOT NULL UNIQUE,
  is_public INTEGER NOT NULL DEFAULT 0,
  -- Paid private channels set this to 1: forwards/saves are blocked.
  protect_content INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One publish attempt for one asset in one channel. chat_id_snapshot freezes
-- the destination so renaming a channel never rewrites history. Jobs are
-- independent: one channel's failure never touches its siblings.
CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES telegram_channels (id) ON DELETE SET NULL,
  chat_id_snapshot TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'scheduled',
  external_id TEXT,
  external_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (asset_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON publish_jobs (state);

-- A serialised show: many assets released in fixed episode order with shared
-- caption material. Ordering is by part_index, never by time.
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title_local TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'Burmese',
  style_example TEXT NOT NULL DEFAULT '',
  total_parts INTEGER,
  caption_template TEXT NOT NULL DEFAULT '',
  title_template TEXT NOT NULL DEFAULT '',
  next_teaser_template TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '{}',
  channel_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS series_parts (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets (id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  hook TEXT NOT NULL DEFAULT '',
  source_filename TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (series_id, part_index)
);
CREATE INDEX IF NOT EXISTS idx_parts_series_order ON series_parts (series_id, part_index);

-- Posting rhythm, editable at runtime. The Cron trigger ticks; this table
-- decides whether anything is actually due (at most once per slot per day).
CREATE TABLE IF NOT EXISTS schedule_slots (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_on TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Default rhythm: three releases a day. Seed only; operators retune later.
INSERT INTO schedule_slots (id, label, hour, minute, timezone, enabled)
SELECT 'slot-lunch', 'Lunch', 12, 0, 'Asia/Bangkok', 1
WHERE NOT EXISTS (SELECT 1 FROM schedule_slots);
INSERT INTO schedule_slots (id, label, hour, minute, timezone, enabled)
SELECT 'slot-evening', 'Evening', 18, 0, 'Asia/Bangkok', 1
WHERE NOT EXISTS (SELECT 1 FROM schedule_slots);
INSERT INTO schedule_slots (id, label, hour, minute, timezone, enabled)
SELECT 'slot-night', 'Night', 21, 0, 'Asia/Bangkok', 1
WHERE NOT EXISTS (SELECT 1 FROM schedule_slots);
