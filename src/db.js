const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("Missing DATABASE_URL in environment.");
    }
    pool = new Pool({
      connectionString: url,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

async function initDb() {
  // Core event tables (single events + RSVPs + reminders)
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      start_ts BIGINT NOT NULL,
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      created_ts BIGINT NOT NULL,
      ended_ts BIGINT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS rsvps (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      choice TEXT NOT NULL,
      created_ts BIGINT NOT NULL,
      UNIQUE(event_id, user_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS event_reminders (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      remind_at_ts BIGINT NOT NULL,
      fired BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_ts BIGINT NOT NULL
    );
  `);

  // Recurring templates (MATCHES YOUR SCHEMA)
  await query(`
    CREATE TABLE IF NOT EXISTS recurring_templates (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      time_hhmm TEXT NOT NULL,
      repeat_days TEXT[] NOT NULL,
      notes TEXT,
      reminders INT[],
      weeks_ahead INT NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      created_ts BIGINT NOT NULL,
      updated_ts BIGINT
    );
  `);

  // Keep track of occurrences created from templates (optional but useful)
  await query(`
    CREATE TABLE IF NOT EXISTS recurring_occurrences (
      id SERIAL PRIMARY KEY,
      template_id INT NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      start_ts BIGINT NOT NULL,
      created_ts BIGINT NOT NULL,
      UNIQUE(template_id, start_ts)
    );
  `);
}

module.exports = { query, initDb };
