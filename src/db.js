const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(process.cwd(), "data.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  notes TEXT,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rsvps (
  event_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS event_reminders (
  event_id INTEGER NOT NULL,
  minutes_before INTEGER NOT NULL,
  remind_ts INTEGER NOT NULL,
  sent_ts INTEGER,
  PRIMARY KEY (event_id, minutes_before),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS checkins (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_guild_status_start ON events (guild_id, status, start_ts);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON event_reminders (remind_ts, sent_ts);
CREATE INDEX IF NOT EXISTS idx_checkins_guild_user_ts ON checkins (guild_id, user_id, ts);
`);

module.exports = db;
