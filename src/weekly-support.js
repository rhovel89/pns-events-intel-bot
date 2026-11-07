"use strict";
// WEEKLY_SUPPORT_V1: Opt-in, per-guild, at-most-once weekly announcement.
const { supportMessage } = require("./support");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BATCH = 20;

async function settings(pool, guildId) {
  const result = await pool.query(
    `SELECT enabled, channel_id, next_due_ts, last_attempt_ts, last_sent_ts
       FROM guild_support_reminders WHERE guild_id=$1`, [guildId]);
  return result.rows[0] || { enabled: false, channel_id: null, next_due_ts: null, last_attempt_ts: null, last_sent_ts: null };
}

async function enable(pool, guildId, channelId, now = Date.now()) {
  if (!guildId || !channelId) throw new Error("A server and text channel are required.");
  // An explicit enable always resets the next due time to seven days from now.
  const next = now + WEEK_MS;
  await pool.query(`INSERT INTO guild_support_reminders
      (guild_id, enabled, channel_id, next_due_ts, updated_ts)
      VALUES ($1, TRUE, $2, $3, $4)
      ON CONFLICT (guild_id) DO UPDATE SET enabled=TRUE,
        channel_id=EXCLUDED.channel_id, next_due_ts=EXCLUDED.next_due_ts,
        updated_ts=EXCLUDED.updated_ts`, [guildId, channelId, next, now]);
  return next;
}

async function disable(pool, guildId, now = Date.now()) {
  await pool.query(`INSERT INTO guild_support_reminders
      (guild_id, enabled, updated_ts) VALUES ($1,FALSE,$2)
      ON CONFLICT (guild_id) DO UPDATE SET enabled=FALSE,
        next_due_ts=NULL, updated_ts=EXCLUDED.updated_ts`, [guildId, now]);
}

function announcementMessage() {
  const message = supportMessage();
  return { ...message, allowedMentions: { parse: [], users: [], roles: [] } };
}

/**
 * Advance next_due_ts BEFORE attempting a Discord send, atomically and within
 * one PostgreSQL statement. Concurrent schedulers cannot claim the same week.
 * Deliberately at-most-once: if Discord rejects the send, that week's reminder
 * is skipped instead of retried (avoids duplicate fundraising announcements).
 */
async function weeklySupportTick(pool, fetchTextChannel, logger = console, now = Date.now()) {
  const claim = await pool.query(`WITH eligible AS (
      SELECT guild_id FROM guild_support_reminders
      WHERE enabled=TRUE AND channel_id IS NOT NULL AND next_due_ts <= $1
      ORDER BY next_due_ts, guild_id LIMIT ${MAX_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE guild_support_reminders AS r
    SET next_due_ts=$2, last_attempt_ts=$1, updated_ts=$1
    FROM eligible WHERE r.guild_id=eligible.guild_id
    RETURNING r.guild_id, r.channel_id`, [now, now + WEEK_MS]);

  let sent = 0;
  for (const item of claim.rows) {
    try {
      // Respect disable/channel changes made after claim, before network call.
      const current = await settings(pool, item.guild_id);
      if (!current.enabled || current.channel_id !== item.channel_id) continue;
      const channel = await fetchTextChannel(item.guild_id, item.channel_id);
      if (!channel || !channel.guildId || channel.guildId !== item.guild_id ||
          typeof channel.send !== "function" || channel.isDMBased?.()) {
        logger.warn?.(`Weekly support: channel not available for guild ${item.guild_id}`);
        continue;
      }
      const message = await channel.send(announcementMessage());
      await pool.query(`UPDATE guild_support_reminders
        SET last_sent_ts=$2, last_message_id=$3
        WHERE guild_id=$1 AND last_attempt_ts=$4`,
      [item.guild_id, Date.now(), message?.id || null, now]);
      sent++;
    } catch (error) {
      logger.error?.(`Weekly support send failed in guild ${item.guild_id}: ${error?.message || error}`);
    }
  }
  return { claimed: claim.rows.length, sent };
}

module.exports = { WEEK_MS, settings, enable, disable, announcementMessage, weeklySupportTick };
