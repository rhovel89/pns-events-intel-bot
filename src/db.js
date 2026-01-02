const { Pool } = require("pg");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment.`);
  return v;
}

function makePool() {
  const databaseUrl = requireEnv("DATABASE_URL");
  return new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });
}

async function initDb(pool) {
  // Base tables
  await pool.query(`
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
      ended_ts BIGINT,
      mention TEXT DEFAULT 'none',
      recurring_template_id INT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rsvps (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      choice TEXT NOT NULL,
      created_ts BIGINT NOT NULL,
      UNIQUE(event_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_reminders (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      remind_at_ts BIGINT NOT NULL,
      fired BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_ts BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_templates (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      time_hhmm TEXT NOT NULL,
      repeat_days TEXT[] NOT NULL,
      notes TEXT,
      reminders TEXT,
      weeks_ahead INT NOT NULL DEFAULT 4,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      mention TEXT DEFAULT 'none',
      created_by TEXT,
      created_ts BIGINT NOT NULL,
      updated_ts BIGINT
    );
  `);

  // Safety upgrades (in case tables existed older)
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS mention TEXT DEFAULT 'none';`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring_template_id INT;`);
  await pool.query(`ALTER TABLE recurring_templates ADD COLUMN IF NOT EXISTS mention TEXT DEFAULT 'none';`);

  // Useful index/uniqueness: prevent duplicate generated events for same template+start_ts
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'events_template_start_unique'
      ) THEN
        CREATE UNIQUE INDEX events_template_start_unique
        ON events (recurring_template_id, start_ts)
        WHERE recurring_template_id IS NOT NULL;
      END IF;
    END $$;
  `);
}

module.exports = { makePool, initDb };
