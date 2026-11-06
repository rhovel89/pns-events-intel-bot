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
      interval_weeks INT NOT NULL DEFAULT 1,
      anchor_date DATE,
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

  // ALLIANCE_SETUP_V1: per-server defaults; existing event rows remain untouched.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      time_zone TEXT NOT NULL DEFAULT 'UTC',
      default_channel_id TEXT,
      updated_ts BIGINT NOT NULL
    );
  `);

  // Safety upgrades (in case tables existed older)
  // RELIABILITY_V1: support metadata edits on existing databases.
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_ts BIGINT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS mention TEXT DEFAULT 'none';`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring_template_id INT;`);
  await pool.query(`ALTER TABLE recurring_templates ADD COLUMN IF NOT EXISTS mention TEXT DEFAULT 'none';`);
  // BIWEEKLY_V1: safe additive migration. Legacy templates remain weekly.
  await pool.query(`ALTER TABLE recurring_templates ADD COLUMN IF NOT EXISTS interval_weeks INT NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE recurring_templates ADD COLUMN IF NOT EXISTS anchor_date DATE;`);

  // DELIVERY_V2: idempotent delivery claims, retries and traceability.
  // Null claim_until / next_attempt_ts mean immediately eligible when due.
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS claim_token TEXT;`);
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS claim_until BIGINT;`);
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS next_attempt_ts BIGINT;`);
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS last_error TEXT;`);
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS sent_at BIGINT;`);
  await pool.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS sent_message_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS event_reminders_delivery_v2_idx
    ON event_reminders (remind_at_ts, next_attempt_ts) WHERE fired=FALSE;`);

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
