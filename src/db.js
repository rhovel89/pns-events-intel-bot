const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL in environment. Add Postgres in Railway and ensure DATABASE_URL is set.");
  process.exit(1);
}

const isRailway =
  !!process.env.RAILWAY_ENVIRONMENT ||
  /railway/i.test(process.env.DATABASE_URL) ||
  /sslmode=require/i.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRailway ? { rejectUnauthorized: false } : undefined
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      name TEXT NOT NULL,
      start_ts BIGINT NOT NULL,
      notes TEXT,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_ts BIGINT NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS rsvps (
      event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      choice TEXT NOT NULL,
      updated_ts BIGINT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS event_reminders (
      event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      minutes_before INT NOT NULL,
      remind_ts BIGINT NOT NULL,
      sent_ts BIGINT,
      PRIMARY KEY (event_id, minutes_before)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ts BIGINT NOT NULL
    );
  `);

  // Recurring templates
  await query(`
    CREATE TABLE IF NOT EXISTS recurring_templates (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      time_hhmm TEXT NOT NULL,
      repeat_days TEXT NOT NULL,
      notes TEXT,
      reminders TEXT,
      weeks_ahead INT NOT NULL DEFAULT 4,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_ts BIGINT NOT NULL,
      updated_ts BIGINT NOT NULL
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_events_guild_status_start ON events (guild_id, status, start_ts);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_events_template_start ON events (template_id, start_ts);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_reminders_due ON event_reminders (remind_ts, sent_ts);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_checkins_guild_user_ts ON checkins (guild_id, user_id, ts);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_templates_enabled ON recurring_templates (guild_id, is_enabled);`);

  console.log("Postgres DB initialized.");
}

module.exports = { pool, query, initDb };
