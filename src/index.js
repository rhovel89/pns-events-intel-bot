require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require("discord.js");

const { DateTime } = require("luxon");
const { randomUUID } = require("node:crypto");
const { makePool, initDb } = require("./db");
const { createCalendar } = require("./calendar");
const { supportMessage } = require("./support"); // VOLUNTARY_SUPPORT_V1
const standalone = require("./standalone-reminders");
const { readChoices, offsetsFromRow, OPTION_NAMES, LEGACY } = require("./reminder-options");
const weeklySupport = require("./weekly-support"); // WEEKLY_SUPPORT_V1
const { anchorDay, recurrenceMatches } = require("./recurrence");

const {
  parseReminders,
  safeTruncate,
  fmtStartBoth,
  parseStartToUtcMillis,
  normalizeMention,
  mentionText,
  normalizeRepeatDays,
  dayToLuxonWeekday
} = require("./utils");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

// Postgres pool (Railway: DATABASE_URL)
const pool = makePool();

// Discord client (only need Guilds for slash commands)
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let standaloneInterval = null;
let standaloneTickBusy = false;
async function safeStandaloneTick() {
  if (standaloneTickBusy) return;
  standaloneTickBusy=true;
  try { await standalone.tick(pool,fetchTextChannel); }
  catch(e){console.error("Standalone reminder tick failed:",e)}
  finally {standaloneTickBusy=false;}
}
let reminderInterval = null;
let recurringInterval = null;
let weeklySupportInterval = null;
let weeklySupportTickBusy = false;

function nowMs() {
  return Date.now();
}

// Fetch text channel safely
async function fetchTextChannel(guildId, channelId) {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch) return null;
    if (ch.isTextBased && ch.guildId === guildId) return ch;
    return null;
  } catch {
    return null;
  }
}

// Permission gate
function requireManageGuild(interaction) {
  const ok = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
  if (!ok) {
    interaction.reply({ content: "You need **Manage Server** permission for this action.", ephemeral: true }).catch(() => {});
    return true;
  }
  return false;
}

// ALLIANCE_SETUP_V1: defaults are scoped to the invoking Discord guild.
async function getGuildSettings(guildId) {
  const result = await pool.query(
    `SELECT time_zone, default_channel_id FROM guild_settings WHERE guild_id=$1`,
    [guildId]
  );
  return result.rows[0] || { time_zone: "UTC", default_channel_id: null };
}

function validZone(zone) {
  const z = (zone || "").trim();
  if (!z || !DateTime.local().setZone(z).isValid) {
    throw new Error("Invalid time zone. Use an IANA time zone such as America/Chicago or UTC.");
  }
  return z;
}

async function chooseGuildDefaults(guildId, interaction) {
  const cfg = await getGuildSettings(guildId);
  const tz = validZone(interaction.options.getString("time_zone") || cfg.time_zone);
  const supplied = interaction.options.getChannel("channel");
  const channelId = supplied?.id || cfg.default_channel_id || interaction.channelId;
  // Settings may refer to a deleted channel, but never to a channel in another guild.
  const dest = await fetchTextChannel(guildId, channelId);
  if (!dest) throw new Error("Configured reminder channel is inaccessible. Use /event setup to choose a valid channel.");
  return { tz, channelId };
}

// CALENDAR_V1: member-facing, read-only, per-guild event calendar.
const calendar = createCalendar({ pool, getGuildSettings });

// -------------------- EVENTS --------------------

async function createEventReminders(eventId, startTs, remindersArr, db = pool) {
  const rems = (remindersArr || []).map(m => ({
    remind_at_ts: startTs - m * 60 * 1000
  }));

  for (const r of rems) {
    if (r.remind_at_ts <= nowMs()) continue;
    await db.query(
      `INSERT INTO event_reminders (event_id, remind_at_ts, fired)
       VALUES ($1, $2, FALSE)`,
      [eventId, r.remind_at_ts]
    );
  }
}

async function createOneTimeEvent({
  reminderOffsets = null,
  guildId,
  channelId,
  name,
  startTs,
  notes,
  mention,
  createdBy,
  recurringTemplateId = null,
  db = pool
}) {
  const createdTs = nowMs();

  const res = await db.query(
    `INSERT INTO events (guild_id, channel_id, name, start_ts, notes, is_active, created_by, created_ts, mention, recurring_template_id, reminder_offsets)
     VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$9,$10::int[])
     ON CONFLICT (recurring_template_id, start_ts) WHERE recurring_template_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      guildId,
      channelId,
      name,
      startTs,
      notes ?? null,
      createdBy ?? null,
      createdTs,
      mention ?? "none",
      recurringTemplateId,
      reminderOffsets
    ]
  );

  if (!res.rowCount) return null; // Already generated occurrence; do not duplicate reminders.
  const eventId = res.rows[0].id;
  const reminders = offsetsFromRow(reminderOffsets, parseReminders());
  await createEventReminders(eventId, startTs, reminders, db);
  return eventId;
}

async function listActiveEvents(guildId) {
  const res = await pool.query(
    `SELECT id, name, start_ts::bigint as start_ts, notes, mention
     FROM events
     WHERE guild_id=$1 AND is_active=TRUE
     ORDER BY start_ts ASC
     LIMIT 25`,
    [guildId]
  );
  return res.rows;
}

async function endEvent(guildId, eventId) {
  const res = await pool.query(
    `UPDATE events
     SET is_active=FALSE, ended_ts=$3
     WHERE guild_id=$1 AND id=$2 AND is_active=TRUE
     RETURNING id, name`,
    [guildId, eventId, nowMs()]
  );
  return res.rowCount ? res.rows[0] : null;
}

// RELIABILITY_V1: atomic per-event edit and pending reminder reschedule.
async function editEvent(guildId, eventId, patch) {
  const allowed = ["name", "start_ts", "notes", "mention", "channel_id", "reminder_offsets"];
  const fields = allowed.filter(k => patch[k] !== undefined);
  if (!fields.length) return { updated: false, row: null, rescheduled: false };
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const original = await db.query(
      `SELECT id, start_ts, is_active FROM events WHERE guild_id=$1 AND id=$2 FOR UPDATE`,
      [guildId, eventId]
    );
    if (!original.rowCount || !original.rows[0].is_active) {
      await db.query("ROLLBACK");
      return { updated: false, row: null, rescheduled: false };
    }
    if (patch.start_ts !== undefined && Number(patch.start_ts) <= nowMs()) {
      throw new Error("Edited event must start in the future.");
    }
    const values = fields.map(k => patch[k]);
    const assignments = fields.map((k, i) => `${k}=$${i+1}`);
    values.push(nowMs(), guildId, eventId);
    const i = fields.length;
    const res = await db.query(
      `UPDATE events SET ${assignments.join(", ")}, updated_ts=$${i+1}
       WHERE guild_id=$${i+2} AND id=$${i+3} AND is_active=TRUE
       RETURNING id, name, start_ts, notes, mention, channel_id, reminder_offsets`, values
    );
    const rescheduled = (patch.start_ts !== undefined &&
      Number(patch.start_ts) !== Number(original.rows[0].start_ts)) || patch.reminder_offsets !== undefined;
    if (rescheduled) {
      await db.query(`DELETE FROM event_reminders WHERE event_id=$1 AND fired=FALSE`, [eventId]);
      const offsets = offsetsFromRow(res.rows[0].reminder_offsets, parseReminders());
      const times = [...new Set(offsets.map(minutes =>
        Number(res.rows[0].start_ts) - minutes * 60000).filter(ts => ts > nowMs()))];
      for (const ts of times) {
        await db.query(`INSERT INTO event_reminders (event_id, remind_at_ts, fired)
          VALUES ($1,$2,FALSE)`, [eventId, ts]);
      }
    }
    await db.query("COMMIT");
    return { updated: res.rowCount > 0, row: res.rows[0] || null, rescheduled };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

// -------------------- RECURRING --------------------

async function createRecurringTemplate({
  guildId,
  channelId,
  name,
  tz,
  timeHhmm,
  repeatDaysArr,
  notes,
  remindersStr,
  weeksAhead,
  mention,
  createdBy,
  intervalWeeks = 1,
  anchorDate,
  reminderOffsets = null
}) {
  const createdTs = nowMs();

  const res = await pool.query(
    `INSERT INTO recurring_templates
     (guild_id, channel_id, name, tz, time_hhmm, repeat_days, notes, reminders, weeks_ahead, is_enabled, mention, created_by, created_ts, interval_weeks, anchor_date, reminder_offsets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12,$13,$14::date,$15::int[])
     RETURNING id`,
    [
      guildId,
      channelId,
      name,
      tz,
      timeHhmm,
      repeatDaysArr,
      notes ?? null,
      remindersStr ?? null,
      weeksAhead,
      mention ?? "none",
      createdBy ?? null,
      createdTs,
      intervalWeeks,
      anchorDate,
      reminderOffsets
    ]
  );

  return res.rows[0].id;
}

async function listRecurringTemplates(guildId) {
  const res = await pool.query(
    `SELECT id, name, channel_id, tz, time_hhmm, repeat_days, weeks_ahead, is_enabled, mention,
       interval_weeks, anchor_date::text AS anchor_date
     FROM recurring_templates
     WHERE guild_id=$1
     ORDER BY id DESC
     LIMIT 50`,
    [guildId]
  );
  return res.rows;
}

async function setTemplateEnabled(guildId, templateId, enabled) {
  const res = await pool.query(
    `UPDATE recurring_templates
     SET is_enabled=$3, updated_ts=$4
     WHERE guild_id=$1 AND id=$2
     RETURNING id, name, is_enabled`,
    [guildId, templateId, enabled, nowMs()]
  );
  return res.rowCount ? res.rows[0] : null;
}

async function editRecurringTemplate(guildId, templateId, patch, db = pool) {
  const fields = [];
  const values = [];
  let i = 1;

  const allowed = ["name", "tz", "time_hhmm", "repeat_days", "weeks_ahead", "notes", "mention", "channel_id", "interval_weeks", "anchor_date", "reminder_offsets"];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    fields.push(`${k}=$${i++}`);
    values.push(patch[k]);
  }
  if (!fields.length) return { updated: false, row: null };

  values.push(nowMs(), guildId, templateId);

  const res = await db.query(
    `UPDATE recurring_templates
     SET ${fields.join(", ")}, updated_ts=$${i}
     WHERE guild_id=$${i + 1} AND id=$${i + 2}
     RETURNING *`,
    values
  );

  return { updated: res.rowCount > 0, row: res.rowCount ? res.rows[0] : null };
}

function parseHhMm(timeStr) {
  const s = (timeStr || "").trim();
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error("time must be HH:MM (24h).");
  return { hh: parseInt(m[1], 10), mm: parseInt(m[2], 10) };
}

function parseYyyyMmDd(dateStr) {
  const dt = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: "utc" });
  if (!dt.isValid) throw new Error("date must be YYYY-MM-DD");
  return dt.startOf("day");
}

async function generateTemplateEvents(template, anchorDateStr, db = pool) {
  const tz = validZone(template.tz || "UTC");
  const { hh, mm } = parseHhMm(template.time_hhmm);
  const repeatDays = template.repeat_days || [];
  const weeksAhead = Math.min(52, Math.max(1, Number(template.weeks_ahead) || 4));
  const intervalWeeks = Number(template.interval_weeks ?? 1);
  // Persisted anchor is essential: a scheduler restart must not flip the alternating weeks.
  const storedAnchor = Object.prototype.toString.call(template.anchor_date) === "[object Date]"
    ? DateTime.fromJSDate(template.anchor_date, { zone: "UTC" }).toFormat("yyyy-LL-dd")
    : template.anchor_date ? String(template.anchor_date).slice(0, 10) : null;
  const anchor = anchorDay(storedAnchor || anchorDateStr ||
    DateTime.now().setZone(tz).toFormat("yyyy-LL-dd"), tz);
  const todayLocal = DateTime.now().setZone(tz).startOf("day");
  const requestedFrom = anchorDateStr ? anchorDay(anchorDateStr, tz) : todayLocal;
  const from = requestedFrom > todayLocal ? requestedFrom : todayLocal;
  const startRangeUtc = DateTime.utc();
  const endRangeUtc = startRangeUtc.plus({ days: weeksAhead * 7 });
  let inserted = 0;
  for (let d = from; d.toMillis() <= endRangeUtc.plus({days: 2}).toMillis(); d = d.plus({ days: 1 })) {
    if (!recurrenceMatches(d, anchor, repeatDays, intervalWeeks)) continue;
    const local = d.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (!local.isValid || local.hour !== hh || local.minute !== mm) continue;
    const startTs = local.toUTC().toMillis();
    if (startTs < startRangeUtc.toMillis() || startTs > endRangeUtc.toMillis()) continue;

    try {
      const eventId = await createOneTimeEvent({
        guildId: template.guild_id,
        channelId: template.channel_id,
        name: template.name,
        startTs,
        notes: template.notes,
        mention: template.mention || "none",
        createdBy: template.created_by,
        recurringTemplateId: template.id,
        reminderOffsets: template.reminder_offsets,
        db
      });
      if (eventId !== null) inserted += 1;
    } catch (err) {
      // Never conceal database failures during regeneration.
      throw err;
    }
  }

  return inserted;
}

async function purgeTemplateEvents(guildId, templateId, fromTs, all, db = pool) {
  const from = all ? 0 : fromTs;

  const idsRes = await db.query(
    `SELECT id FROM events
     WHERE guild_id=$1 AND recurring_template_id=$2 AND start_ts >= $3`,
    [guildId, templateId, from]
  );

  const eventIds = idsRes.rows.map(r => r.id);
  if (!eventIds.length) return { deletedEvents: 0 };

  await db.query(`DELETE FROM event_reminders WHERE event_id = ANY($1::int[])`, [eventIds]);
  await db.query(`DELETE FROM rsvps WHERE event_id = ANY($1::int[])`, [eventIds]);
  const delRes = await db.query(`DELETE FROM events WHERE guild_id=$2 AND id = ANY($1::int[])`, [eventIds, guildId]);

  return { deletedEvents: delRes.rowCount || 0 };
}

async function deleteTemplate(guildId, templateId) {
  const res = await pool.query(
    `DELETE FROM recurring_templates WHERE guild_id=$1 AND id=$2 RETURNING id, name`,
    [guildId, templateId]
  );
  return res.rowCount ? res.rows[0] : null;
}

// Background generator tick
async function recurringTick() {
  try {
    const res = await pool.query(`SELECT id FROM recurring_templates WHERE is_enabled=TRUE`);
    for (const t of res.rows) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const locked = await db.query(
          `SELECT * FROM recurring_templates WHERE id=$1 AND is_enabled=TRUE FOR UPDATE`, [t.id]);
        if (locked.rowCount) await generateTemplateEvents(locked.rows[0], undefined, db);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        console.error(`Recurring template #${t.id} generation error:`, err);
      } finally {
        db.release();
      }
    }
  } catch (e) {
    console.error("Recurring tick error:", e);
  }
}

// -------------------- REMINDERS --------------------

// DELIVERY_V2: atomic claims, bounded leases, delayed retries, and send acknowledgments.
// A send can succeed before its ack reaches Postgres; therefore retries remain
// AT-LEAST-ONCE, not exactly-once. Discord does not provide an idempotency key here.
const CLAIM_LEASE_MS = 120000;
const CLAIM_BATCH_SIZE = 1;
let reminderTickInProgress = false;

async function claimDueReminders() {
  const token = randomUUID();
  const now = nowMs();
  const result = await pool.query(`
    WITH due AS (
      SELECT er.id
      FROM event_reminders er
      JOIN events e ON e.id=er.event_id
      WHERE er.fired=FALSE AND e.is_active=TRUE
        AND er.remind_at_ts <= $1
        AND (er.next_attempt_ts IS NULL OR er.next_attempt_ts <= $1)
        AND (er.claim_until IS NULL OR er.claim_until <= $1)
      ORDER BY er.remind_at_ts, er.id
      FOR UPDATE OF er SKIP LOCKED
      LIMIT $2
    )
    UPDATE event_reminders er
       SET claim_token=$3, claim_until=$4, attempts=er.attempts+1
      FROM due WHERE er.id=due.id
    RETURNING er.id AS reminder_id, er.event_id, er.remind_at_ts, er.attempts
  `, [now, CLAIM_BATCH_SIZE, token, now + CLAIM_LEASE_MS]);
  return { token, rows: result.rows };
}

async function markDelivered(row, token, messageId) {
  const result = await pool.query(`
    UPDATE event_reminders
       SET fired=TRUE, sent_at=$3, sent_message_id=$4,
           claim_token=NULL, claim_until=NULL, next_attempt_ts=NULL, last_error=NULL
     WHERE id=$1 AND claim_token=$2 AND fired=FALSE
  `, [row.reminder_id, token, nowMs(), messageId || null]);
  if (result.rowCount !== 1) {
    console.warn(`Reminder ${row.reminder_id} send succeeded, but delivery acknowledgement lost claim ownership; duplicate-risk review needed.`);
  }
}

async function markDeliveryFailure(row, token, err) {
  const message = String(err?.message || err || 'Unknown delivery failure').slice(0, 400);
  const attempts = Math.max(1, Number(row.attempts) || 1);
  const backoff = Math.min(600000, 30000 * Math.pow(2, Math.min(5, attempts - 1)));
  await pool.query(`
    UPDATE event_reminders
       SET claim_token=NULL, claim_until=NULL, last_error=$3, next_attempt_ts=$4
     WHERE id=$1 AND claim_token=$2 AND fired=FALSE
  `, [row.reminder_id, token, message, nowMs() + backoff]);
  console.warn(`Reminder ${row.reminder_id} delivery attempt ${attempts} failed: ${message}`);
}

async function remindersTick() {
  if (reminderTickInProgress) return;
  reminderTickInProgress = true;
  try {
    const { token, rows } = await claimDueReminders();
    for (const row of rows) {
      try {
        // Fetch current event data, scoped by the same event ID; an edited/ended
        // event may no longer be eligible after it was claimed.
        const latest = await pool.query(`
          SELECT e.guild_id, e.channel_id, e.name, e.start_ts, e.notes, e.mention,
                 e.is_active, er.fired, er.remind_at_ts
          FROM event_reminders er JOIN events e ON e.id=er.event_id
          WHERE er.id=$1 AND er.claim_token=$2
        `, [row.reminder_id, token]);
        if (!latest.rowCount || !latest.rows[0].is_active || latest.rows[0].fired) continue;
        const event = latest.rows[0];
        // A different event edit can move or replace the reminder after the claim.
        if (Number(event.remind_at_ts) !== Number(row.remind_at_ts)) continue;
        const ch = await fetchTextChannel(event.guild_id, event.channel_id);
        if (!ch) throw new Error(`Reminder channel inaccessible: ${event.channel_id}`);
        const embed = new EmbedBuilder()
          .setTitle(`⏰ Event Reminder: ${event.name}`)
          .setDescription([
            `**Starts:** ${fmtStartBoth(event.start_ts)}`,
            event.notes ? `**Notes:** ${safeTruncate(event.notes)}` : ''
          ].filter(Boolean).join('\n'))
          .setFooter({ text: `Event ID: ${row.event_id}` });
        const mention = normalizeMention(event.mention || process.env.DEFAULT_MENTION || 'none');
        const msg = await ch.send({
          content: mentionText(mention), embeds: [embed],
          allowedMentions: { parse: mention === 'everyone' || mention === 'here' ? ['everyone'] : [] }
        });
        await markDelivered(row, token, msg?.id);
      } catch (e) {
        try { await markDeliveryFailure(row, token, e); }
        catch (dbErr) { console.error(`Reminder ${row.reminder_id} retry metadata error:`, dbErr); }
      }
    }
  } catch (e) {
    console.error('Reminders tick error:', e);
  } finally {
    reminderTickInProgress = false;
  }
}

// ADMIN_DASHBOARD_V1 — read-only, guild-scoped dashboard. No destructive buttons.
const DASH_PREFIX = "713dash:";
const DASH_VIEWS = ["overview", "upcoming", "reminders", "recurring"];

function dashboardButtons(active) {
  const labels = {
    overview: "Overview", upcoming: "Upcoming", reminders: "Reminders", recurring: "Recurring"
  };
  return [new ActionRowBuilder().addComponents(
    DASH_VIEWS.map((view) => new ButtonBuilder()
      .setCustomId(`${DASH_PREFIX}${view}`)
      .setLabel(labels[view])
      .setStyle(active === view ? ButtonStyle.Primary : ButtonStyle.Secondary))
  )];
}

function dashboardEventLine(event) {
  const timestamp = Math.floor(Number(event.start_ts) / 1000);
  // A Discord timestamp automatically renders in the reader's locale.
  return `#${event.id} • ${safeTruncate(event.name, 85)} • <t:${timestamp}:f> • <#${event.channel_id}>`;
}

async function dashboardContent(guildId, guildName, view) {
  if (!DASH_VIEWS.includes(view)) throw new Error("Unknown dashboard view.");
  const cfg = await getGuildSettings(guildId);
  const safeName = safeTruncate((guildName || "Alliance").replace(/@/g, "＠"), 90);
  const embed = new EmbedBuilder()
    .setTitle(`🛡️ 713 Alliance Admin • ${view.charAt(0).toUpperCase() + view.slice(1)}`)
    .setColor(0x2a9dbe)
    .setDescription(`**Server:** ${safeName}\n**Time zone:** ${cfg.time_zone}\n**Default channel:** ${cfg.default_channel_id ? `<#${cfg.default_channel_id}>` : "Current channel"}`)
    .setFooter({ text: "Private administrator view • Data is limited to this Discord server" });

  if (view === "overview") {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM events WHERE guild_id=$1 AND is_active=TRUE AND start_ts >= $2) AS future_events,
        (SELECT COUNT(*)::int FROM recurring_templates WHERE guild_id=$1 AND is_enabled=TRUE) AS enabled_templates,
        (SELECT COUNT(*)::int FROM event_reminders er JOIN events e ON e.id=er.event_id
          WHERE e.guild_id=$1 AND e.is_active=TRUE AND er.fired=FALSE AND e.start_ts >= $2) AS pending_reminders,
        (SELECT COUNT(*)::int FROM event_reminders er JOIN events e ON e.id=er.event_id
          WHERE e.guild_id=$1 AND e.is_active=TRUE AND er.fired=FALSE AND er.remind_at_ts <= $2) AS due_reminders`,
      [guildId, nowMs()]
    );
    const row = result.rows[0];
    embed.addFields(
      { name: "Upcoming active events", value: String(row.future_events), inline: true },
      { name: "Enabled recurring templates", value: String(row.enabled_templates), inline: true },
      { name: "Pending reminders", value: String(row.pending_reminders), inline: true },
      { name: "Reminders due/overdue", value: String(row.due_reminders), inline: true },
      { name: "Manage", value: "`/event quick` • `/event setup` • `/event list`\n`/event edit` and `/event end` require an explicit event ID." }
    );
  } else if (view === "upcoming") {
    const result = await pool.query(`
      SELECT id, name, start_ts, channel_id FROM events
      WHERE guild_id=$1 AND is_active=TRUE AND start_ts >= $2
      ORDER BY start_ts ASC LIMIT 8`, [guildId, nowMs()]);
    embed.addFields({ name: "Next eight scheduled events", value: result.rows.length
      ? result.rows.map(dashboardEventLine).join("\n").slice(0, 1000)
      : "No upcoming active events." },
    { name: "Actions", value: "Use `/event quick` to schedule; `/event edit` or `/event end` with a verified event ID to modify." });
  } else if (view === "reminders") {
    const counts = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE er.fired=FALSE)::int AS pending,
             COUNT(*) FILTER (WHERE er.fired=TRUE)::int AS fired,
             COUNT(*) FILTER (WHERE er.fired=FALSE AND er.remind_at_ts <= $2)::int AS due
      FROM event_reminders er
      JOIN events e ON e.id=er.event_id
      WHERE e.guild_id=$1 AND e.is_active=TRUE AND e.start_ts >= $2`, [guildId, nowMs()]);
    const due = await pool.query(`
      SELECT er.event_id, e.name, er.remind_at_ts, e.channel_id
      FROM event_reminders er JOIN events e ON e.id=er.event_id
      WHERE e.guild_id=$1 AND e.is_active=TRUE AND er.fired=FALSE
      ORDER BY er.remind_at_ts ASC LIMIT 6`, [guildId]);
    // DELIVERY_V2 monitor: only this guild, and only active events.
    const delivery = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE er.fired=FALSE AND er.claim_until > $2)::int AS leased,
             COUNT(*) FILTER (WHERE er.fired=FALSE AND er.last_error IS NOT NULL)::int AS retrying,
             COUNT(*) FILTER (WHERE er.fired=FALSE AND er.next_attempt_ts > $2)::int AS deferred,
             COALESCE(MAX(er.attempts),0)::int AS max_attempts
      FROM event_reminders er JOIN events e ON e.id=er.event_id
      WHERE e.guild_id=$1 AND e.is_active=TRUE
    `, [guildId, nowMs()]);
    const c = counts.rows[0];
    const q = delivery.rows[0];
    embed.addFields(
      { name: "Delivery V2 • claim and retry health", value:
        `Leased: **${q.leased}** • Retrying: **${q.retrying}** • Deferred: **${q.deferred}** • Max attempts: **${q.max_attempts}**` },
      { name: "Future-event reminder counts", value: `Pending: **${c.pending}** • Fired: **${c.fired}** • Due/overdue: **${c.due}**` },
      { name: "Next pending reminders", value: due.rows.length
        ? due.rows.map(r => `Event #${r.event_id} • ${safeTruncate(r.name, 65)} • <t:${Math.floor(Number(r.remind_at_ts)/1000)}:R> • <#${r.channel_id}>`).join("\n").slice(0, 1000)
        : "No pending reminders." },
      { name: "Note", value: "Counts reflect database records, not a guarantee of message delivery. A due reminder may be waiting for a channel to become accessible." }
    );
  } else {
    const result = await pool.query(`
      SELECT id, name, is_enabled, time_hhmm, tz, channel_id
      FROM recurring_templates WHERE guild_id=$1 ORDER BY id DESC LIMIT 8`, [guildId]);
    embed.addFields(
      { name: "Recent recurring templates", value: result.rows.length
        ? result.rows.map(t => `#${t.id} • ${safeTruncate(t.name, 70)} • ${t.is_enabled ? "Enabled" : "Disabled"} • ${t.time_hhmm} ${t.tz}`).join("\n").slice(0, 1000)
        : "No recurring templates." },
      { name: "Safe management", value: "Use `/event recurring list` to confirm a template ID, then `/event recurring disable` or `/event recurring edit`. This dashboard does not delete anything." }
    );
  }
  return { embeds: [embed], components: dashboardButtons(view), allowedMentions: { parse: [] } };
}

// -------------------- INTERACTIONS --------------------

client.on(Events.InteractionCreate, async (interaction) => {
  // CALENDAR_V1: only the original viewer can navigate the ephemeral calendar.
  if ((interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith("713cal|")) {
    await calendar.handleComponent(interaction);
    return;
  }
  // ADMIN_DASHBOARD_V1 buttons: private, read-only, no cross-guild access.
  if (interaction.isButton() && interaction.customId.startsWith(DASH_PREFIX)) {
    try {
      if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "Manage Server permission is required.", ephemeral: true });
      }
      const view = interaction.customId.slice(DASH_PREFIX.length);
      if (!DASH_VIEWS.includes(view)) return interaction.reply({ content: "Unknown dashboard view.", ephemeral: true });
      await interaction.deferUpdate();
      return interaction.editReply(await dashboardContent(interaction.guildId, interaction.guild?.name, view));
    } catch (err) {
      console.error("Dashboard button error:", err);
      const response = { content: "Dashboard could not refresh. Try /event dashboard.", components: [] };
      if (interaction.deferred || interaction.replied) return interaction.editReply(response).catch(() => {});
      return interaction.reply({ content: response.content, ephemeral: true }).catch(() => {});
    }
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "event") return;

  try {
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    // Prevent cross-guild channel injection, including on edits.
    const selectedChannel = interaction.options.getChannel("channel");
    if (selectedChannel && selectedChannel.guildId !== guildId) {
      return interaction.reply({ content: "Channel must belong to this server.", ephemeral: true });
    }

    // VOLUNTARY_SUPPORT_V1: voluntary tips only; free access remains unchanged.
    if (sub === "support") {
      return interaction.reply({ ...supportMessage(), ephemeral: true });
    }

    // WEEKLY_SUPPORT_V1: admin-only, explicit per-guild opt-in.
    if (sub === "support-reminders") {
      if (requireManageGuild(interaction)) return;
      const action = interaction.options.getString("action", true);
      if (action === "status") {
        const cfg = await weeklySupport.settings(pool, guildId);
        const due = cfg.next_due_ts ? `Next post: <t:${Math.floor(Number(cfg.next_due_ts) / 1000)}:F>` : "No post scheduled.";
        return interaction.reply({ content:
          `Weekly support announcements: **${cfg.enabled ? "ENABLED" : "DISABLED"}**. ` +
          `${cfg.channel_id ? `Channel: <#${cfg.channel_id}>. ` : ""}${due} Donations are always optional; every feature remains free.`,
          ephemeral: true, allowedMentions: { parse: [] } });
      }
      if (action === "disable") {
        await weeklySupport.disable(pool, guildId);
        return interaction.reply({ content: "✅ Weekly support announcements disabled for this server. The `/event support` command remains available.", ephemeral: true });
      }
      if (action === "enable") {
        const channel = interaction.options.getChannel("channel");
        if (!channel) return interaction.reply({ content: "Select the text channel in which weekly support announcements may appear.", ephemeral: true });
        const usable = await fetchTextChannel(guildId, channel.id);
        if (!usable || typeof usable.send !== "function" || usable.isDMBased?.()) {
          return interaction.reply({ content: "I cannot post in that server text channel. Check bot permissions and try again.", ephemeral: true });
        }
        const me = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.();
        const permissions = usable.permissionsFor?.(me);
        if (!permissions?.has(PermissionsBitField.Flags.SendMessages) ||
            !permissions?.has(PermissionsBitField.Flags.EmbedLinks)) {
          return interaction.reply({ content: "Bot needs Send Messages and Embed Links permissions in that channel.", ephemeral: true });
        }
        const next = await weeklySupport.enable(pool, guildId, channel.id);
        return interaction.reply({ content: `✅ Opted in! First optional donation announcement will appear in <#${channel.id}> <t:${Math.floor(next / 1000)}:R>, then at most once every seven days. Disable anytime with \`/event support-reminders action:Disable\`.`, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return interaction.reply({ content: "Unknown action. Use Status, Enable or Disable.", ephemeral: true });
    }

    // CALENDAR_V1: no Manage Server privilege needed for read-only views.
    if (sub === "calendar") {
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply(await calendar.renderCalendar(
        guildId, interaction.user.id,
        interaction.options.getString("view") || "week",
        interaction.options.getString("date")
      ));
    }

    // ADMIN_DASHBOARD_V1 requires Manage Server; controls only display data.
    if (sub === "dashboard") {
      if (requireManageGuild(interaction)) return;
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply(await dashboardContent(guildId, interaction.guild?.name, "overview"));
    }

    // Setup and help are read-only unless explicitly updating this guild's settings.
    if (sub === "help") {
      return interaction.reply({
        content: [
          "**713 Event Reminders — Alliance Guide**",
          "`/event setup` — view this server's time zone and default reminder channel",
          "`/event setup time_zone:America/Chicago channel:#reminders` — save server defaults (Manage Server required)",
          "`/event calendar` — private interactive day, week or month calendar (all members)",
          "`/event support` — optional donation link; all bot features remain free",
          "`/event quick` — create an event using separate date and time fields",
          "`/event create` — advanced event with custom start/time zone",
          "`/event list`, `/event edit`, `/event end` — manage one-time events",
          "`/event recurring create`, `/event recurring list`, `/event recurring disable` — weekly events",
          "**Time formats:** date `YYYY-MM-DD`, time `HH:mm` (24-hour). Use `UTC` for game/reset time.",
          "Each alliance has separate events and settings. Only members with Manage Server can make changes."
        ].join("\n"),
        ephemeral: true
      });
    }

    if (sub === "setup") {
      const zone = interaction.options.getString("time_zone");
      const channel = interaction.options.getChannel("channel");
      if (zone !== null || channel !== null) {
        if (requireManageGuild(interaction)) return;
        if (zone !== null) validZone(zone);
        if (channel && !(await fetchTextChannel(guildId, channel.id))) {
          throw new Error("Please choose an accessible text channel in this server.");
        }
        const previous = await getGuildSettings(guildId);
        await pool.query(
          `INSERT INTO guild_settings (guild_id, time_zone, default_channel_id, updated_ts)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (guild_id) DO UPDATE SET
             time_zone=EXCLUDED.time_zone,
             default_channel_id=EXCLUDED.default_channel_id,
             updated_ts=EXCLUDED.updated_ts`,
          [guildId, zone === null ? previous.time_zone : validZone(zone), channel?.id || previous.default_channel_id, nowMs()]
        );
      }
      const current = await getGuildSettings(guildId);
      return interaction.reply({
        content: [
          "**713 Event Reminders — This Server**",
          `Time zone: **${current.time_zone}**`,
          `Default reminder channel: ${current.default_channel_id ? `<#${current.default_channel_id}>` : "Current channel (until configured)"}`,
          "To update, run `/event setup` with `time_zone` and/or `channel` (Manage Server required).",
          "This changes defaults for NEW events only; existing event times and channels stay unchanged."
        ].join("\n"),
        ephemeral: true
      });
    }

    // REMINDER_CENTER_V25: Independent alliance message, never a calendar event.
    if (group === "reminder") {
      if (requireManageGuild(interaction)) return;
      if (sub === "create") {
        const message=interaction.options.getString("message",true);
        const when=interaction.options.getString("when",true);
        const { tz, channelId } = await chooseGuildDefaults(guildId,interaction);
        const startNow=nowMs();
        let runAt;
        if (when==="now") runAt=startNow;
        else if (when==="in5") runAt=startNow+5*60000;
        else if (when==="at") {
          const date=interaction.options.getString("date");
          const time=interaction.options.getString("time");
          if (!date || !time) throw new Error("Specify both date and time when choosing At date and time.");
          parseHhMm(time);
          runAt=parseStartToUtcMillis({startRaw:`${date} ${time}`,timeZone:tz});
        } else throw new Error("Unknown reminder timing.");
        let offsets=readChoices(interaction.options,[0]);
        if (when==="now") {
          if (offsets.some(x=>x!==0)) throw new Error("Immediate reminders cannot have earlier warning messages.");
          offsets=[0];
        }
        const item=await standalone.create(pool,{guildId,channelId,message,runAt,offsets,createdBy:interaction.user.id},startNow);
        if (when==="now") void safeStandaloneTick();
        return interaction.reply({content:`🔔 Scheduled standalone reminder #${item.id} in <#${channelId}> for <t:${Math.floor(runAt/1000)}:F>. ${item.count} delivery message(s) queued.`,ephemeral:true,allowedMentions:{parse:[]}});
      }
      if (sub==="edit") {
        const id=interaction.options.getInteger("reminder_id",true);
        const message=interaction.options.getString("message");
        const when=interaction.options.getString("when");
        const date=interaction.options.getString("date");
        const time=interaction.options.getString("time");
        const changes={};
        if (message!==null) changes.message=message;
        if (when!==null) {
          if (when==="now") changes.runAt=nowMs();
          else if (when==="in5") changes.runAt=nowMs()+5*60000;
          else if (when==="at") {
            if(!date || !time) throw new Error("Specify date and time when rescheduling At date and time.");
            parseHhMm(time);
            const cfg=await getGuildSettings(guildId);
            changes.runAt=parseStartToUtcMillis({startRaw:`${date} ${time}`,timeZone:cfg.time_zone});
          } else throw new Error("Unknown reminder timing.");
        }else if (date!==null || time!==null) throw new Error("Select when:At date and time to change the date or time.");
        if (OPTION_NAMES.some(([,name])=>interaction.options.getBoolean(name)!==null))
          changes.offsets=readChoices(interaction.options,[]);
        if (when==="now") {
          if (changes.offsets?.some(x=>x!==0)) throw new Error("Immediate reminders cannot have pre-warnings.");
          changes.offsets=[0];
        }
        const result=await standalone.edit(pool,guildId,id,changes);
        if (when==="now" && result.updated) void safeStandaloneTick();
        return interaction.reply({content:result.updated?
          `✅ Updated standalone reminder #${id}; ${result.count} pending delivery message(s) now scheduled.`:
          `Reminder #${id} not found or already cancelled.`,ephemeral:true});
      }
      if (sub==="list") {
        const entries=await standalone.list(pool,guildId);
        return interaction.reply({content:entries.length?entries.map(x=>`#${x.id} • <t:${Math.floor(Number(x.run_at_ts)/1000)}:F> • <#${x.channel_id}> • ${safeTruncate(x.message,85)}`).join("\n"):"No active standalone reminders.",ephemeral:true,allowedMentions:{parse:[]}});
      }
      if (sub==="cancel") {
        const id=interaction.options.getInteger("reminder_id",true);
        const ok=await standalone.cancel(pool,guildId,id);
        return interaction.reply({content:ok?`✅ Cancelled standalone reminder #${id}.`:`Reminder #${id} not found or already cancelled.`,ephemeral:true});
      }
      return interaction.reply({content:"Unknown standalone reminder command.",ephemeral:true});
    }

    if (sub === "quick") {
      if (requireManageGuild(interaction)) return;
      const name = interaction.options.getString("name", true);
      const date = interaction.options.getString("date", true);
      const time = interaction.options.getString("time", true);
      parseHhMm(time);
      const { tz, channelId } = await chooseGuildDefaults(guildId, interaction);
      const startTs = parseStartToUtcMillis({ startRaw: `${date} ${time}`, timeZone: tz });
      if (startTs <= nowMs()) throw new Error("Event must start in the future.");
      const notes = interaction.options.getString("notes");
      const mention = "none"; // Safe default; explicit mentions remain in advanced create.
      const eventId = await createOneTimeEvent({
        guildId, channelId, name, startTs, notes, mention, createdBy: interaction.user.id,
        reminderOffsets: readChoices(interaction.options, parseReminders())
      });
      const ch = await fetchTextChannel(guildId, channelId);
      const embed = new EmbedBuilder()
        .setTitle(`✅ Event Created: ${name}`)
        .setDescription([`**Starts:** ${fmtStartBoth(startTs)}`, `**Event ID:** ${eventId}`,
          notes ? `**Notes:** ${safeTruncate(notes)}` : ""].filter(Boolean).join("\n"));
      if (ch) await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return interaction.reply({
        content: `✅ Event **#${eventId}** scheduled (${tz}). Reminders will post in <#${channelId}>.`,
        ephemeral: true
      });
    }

    // ===== RECURRING GROUP =====
    if (group === "recurring") {

      if (sub === "create") {
        if (requireManageGuild(interaction)) return;

        const name = interaction.options.getString("name", true);
        const date = interaction.options.getString("date", true);
        const time = interaction.options.getString("time", true);
        const repeat_days = interaction.options.getString("repeat_days", true);
        const weeks_ahead = interaction.options.getInteger("weeks_ahead", true);
        const intervalWeeks = interaction.options.getInteger("interval_weeks") || 1;
        if (![1, 2].includes(intervalWeeks)) throw new Error("Choose Every week or Every other week.");

        const { tz, channelId } = await chooseGuildDefaults(guildId, interaction);

        const notes = interaction.options.getString("notes");
        const mention = normalizeMention(interaction.options.getString("mention") || process.env.DEFAULT_MENTION || "none");
        const repeatDaysArr = normalizeRepeatDays(repeat_days);

        parseHhMm(time); // validate time
        const validatedAnchor = anchorDay(date, tz).toFormat("yyyy-LL-dd");
        if (weeks_ahead < 1 || weeks_ahead > 52) throw new Error("weeks_ahead must be 1–52.");

        const templateId = await createRecurringTemplate({
          guildId,
          channelId,
          name,
          tz,
          timeHhmm: time,
          repeatDaysArr,
          notes,
          remindersStr: process.env.EVENT_REMINDERS || "60,15,5",
          weeksAhead: weeks_ahead,
          mention,
          createdBy: interaction.user.id,
          intervalWeeks,
          anchorDate: validatedAnchor,
          reminderOffsets: readChoices(interaction.options)
        });

        const tRes = await pool.query(`SELECT * FROM recurring_templates WHERE id=$1`, [templateId]);
        const inserted = await generateTemplateEvents(tRes.rows[0], date);

        return interaction.reply({
          content: `✅ Created **${intervalWeeks === 2 ? "every-other-week" : "weekly"}** template **#${templateId}** on **${repeatDaysArr.join(", ")}**, anchored **${validatedAnchor}** (${tz}); generated **${inserted}** event(s). Reminders will post in <#${channelId}>.`,
          ephemeral: true
        });
      }

      if (sub === "list") {
        await interaction.deferReply({ ephemeral: true });
        const rows = await listRecurringTemplates(guildId);
        const lines = rows.map(r => `#${r.id} • ${r.name} • ${r.time_hhmm} (${r.tz}) • ${Number(r.interval_weeks) === 2 ? "every other week" : "weekly"} [${r.repeat_days.join(",")}]${r.anchor_date ? ` • anchor ${r.anchor_date}` : ""} • ${r.is_enabled ? "enabled" : "disabled"}`);
        return interaction.editReply({ content: lines.length ? lines.join("\n").slice(0, 1900) : "No recurring templates." });
      }

      if (sub === "disable" || sub === "enable") {
        if (requireManageGuild(interaction)) return;

        const templateId = interaction.options.getInteger("template_id", true);
        const enabled = sub === "enable";
        const row = await setTemplateEnabled(guildId, templateId, enabled);
        if (!row) return interaction.reply({ content: "Template not found.", ephemeral: true });

        return interaction.reply({
          content: `✅ Template **#${row.id} ${row.name}** is now **${row.is_enabled ? "ENABLED" : "DISABLED"}**.`,
          ephemeral: true
        });
      }

      if (sub === "edit") {
        if (requireManageGuild(interaction)) return;
        const templateId = interaction.options.getInteger("template_id", true);
        const patch = {};
        if (OPTION_NAMES.some(([,name])=>interaction.options.getBoolean(name)!==null))
          patch.reminder_offsets=readChoices(interaction.options,[]);
        const name = interaction.options.getString("name");
        const time = interaction.options.getString("time");
        const zone = interaction.options.getString("time_zone");
        const days = interaction.options.getString("repeat_days");
        const weeks = interaction.options.getInteger("weeks_ahead");
        const intervalWeeks = interaction.options.getInteger("interval_weeks");
        const newAnchor = interaction.options.getString("anchor_date");
        const channel = interaction.options.getChannel("channel");
        const notes = interaction.options.getString("notes");
        const mention = interaction.options.getString("mention");
        if (name !== null) patch.name = name;
        if (time !== null) { parseHhMm(time); patch.time_hhmm = time; }
        if (zone !== null) {
          if (!DateTime.local().setZone(zone).isValid) throw new Error("Invalid IANA time zone");
          patch.tz = zone;
        }
        if (days !== null) patch.repeat_days = normalizeRepeatDays(days);
        if (weeks !== null) {
          if (weeks < 1 || weeks > 52) throw new Error("weeks_ahead must be 1–52.");
          patch.weeks_ahead = weeks;
        }
        if (intervalWeeks !== null) {
          if (![1, 2].includes(intervalWeeks)) throw new Error("Invalid repeat interval.");
          if (intervalWeeks === 2 && newAnchor === null) {
            const current = await pool.query(
              `SELECT anchor_date FROM recurring_templates WHERE guild_id=$1 AND id=$2`,
              [guildId, templateId]);
            if (!current.rowCount) throw new Error("Template not found.");
            if (!current.rows[0].anchor_date) throw new Error("Set anchor_date when changing an older weekly template to every other week.");
          }
          patch.interval_weeks = intervalWeeks;
        }
        if (newAnchor !== null) {
          const existing = await pool.query(`SELECT tz FROM recurring_templates WHERE guild_id=$1 AND id=$2`, [guildId, templateId]);
          if (!existing.rowCount) throw new Error("Template not found.");
          patch.anchor_date = anchorDay(newAnchor, patch.tz || existing.rows[0].tz).toFormat("yyyy-LL-dd");
        }
        if (channel) patch.channel_id = channel.id;
        if (notes !== null) patch.notes = notes;
        if (mention !== null) patch.mention = normalizeMention(mention);
        const applyFuture = interaction.options.getBoolean("apply_future") === true;
        if ((patch.interval_weeks !== undefined || patch.anchor_date !== undefined || patch.reminder_offsets !== undefined) && !applyFuture)
          throw new Error(`Changing the frequency or anchor requires apply_future:true with confirm:APPLY ${templateId} so generated occurrences stay consistent.`);
        if (applyFuture && interaction.options.getString("confirm") !== `APPLY ${templateId}`) {
          throw new Error(`Nothing changed. Set confirm to APPLY ${templateId} before regenerating future events.`);
        }
        if (!Object.keys(patch).length) {
          return interaction.reply({ content: "No changes supplied.", ephemeral: true });
        }
        if (applyFuture) {
          // All edits, deletions, new events, and reminders are one atomic transaction.
          const db = await pool.connect();
          try {
            await db.query("BEGIN");
            const locked = await db.query(
              `SELECT id FROM recurring_templates WHERE guild_id=$1 AND id=$2 FOR UPDATE`,
              [guildId, templateId]);
            if (!locked.rowCount) {
              await db.query("ROLLBACK");
              return interaction.reply({ content: "Template not found.", ephemeral: true });
            }
            const result = await editRecurringTemplate(guildId, templateId, patch, db);
            if (!result.updated) throw new Error("Template could not be updated.");
            const purged = await purgeTemplateEvents(guildId, templateId, nowMs(), false, db);
            const inserted = result.row.is_enabled
              ? await generateTemplateEvents(result.row, undefined, db) : 0;
            await db.query("COMMIT");
            return interaction.reply({ content:
              `✅ Updated recurring template #${templateId}. Regenerated ${inserted} future event(s); replaced ${purged.deletedEvents}.`,
              ephemeral: true });
          } catch (err) {
            await db.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            db.release();
          }
        }
        const result = await editRecurringTemplate(guildId, templateId, patch);
        if (!result.updated) return interaction.reply({ content: "Template not found or no changes.", ephemeral: true });
        return interaction.reply({ content: `Updated recurring template #${templateId}.`, ephemeral: true });
      }

      if (sub === "purge") {
        if (requireManageGuild(interaction)) return;

        const templateId = interaction.options.getInteger("template_id", true);
        const range = interaction.options.getString("range", true);
        const fromStr = interaction.options.getString("from");
        if (interaction.options.getString("confirm") !== `PURGE ${templateId}`) {
          throw new Error(`Nothing deleted. Set confirm to PURGE ${templateId}.`);
        }

        const fromTs = (range === "all")
          ? 0
          : (fromStr ? parseYyyyMmDd(fromStr).toMillis() : nowMs());

        const purge = await purgeTemplateEvents(guildId, templateId, fromTs, range === "all");

        return interaction.reply({
          content: `✅ Purged **${purge.deletedEvents}** generated event(s) for template **#${templateId}** (template kept).`,
          ephemeral: true
        });
      }

      if (sub === "delete") {
        if (requireManageGuild(interaction)) return;

        const templateId = interaction.options.getInteger("template_id", true);
        const scope = interaction.options.getString("scope", true);
        const fromStr = interaction.options.getString("from");
        if (interaction.options.getString("confirm") !== `DELETE ${templateId}`) {
          throw new Error(`Nothing deleted. Set confirm to DELETE ${templateId}.`);
        }

        if (scope === "template_only") {
          await setTemplateEnabled(guildId, templateId, false);
          const del = await deleteTemplate(guildId, templateId);
          if (!del) return interaction.reply({ content: "Template not found.", ephemeral: true });

          return interaction.reply({ content: `✅ Deleted template **#${del.id} ${del.name}** (events left intact).`, ephemeral: true });
        }

        if (scope === "future") {
          const fromTs = fromStr ? parseYyyyMmDd(fromStr).toMillis() : nowMs();
          const purge = await purgeTemplateEvents(guildId, templateId, fromTs, false);
          await setTemplateEnabled(guildId, templateId, false);

          const del = await deleteTemplate(guildId, templateId);
          if (!del) return interaction.reply({ content: "Template not found.", ephemeral: true });

          return interaction.reply({
            content: `✅ Deleted template **#${del.id} ${del.name}** and removed **${purge.deletedEvents}** future generated event(s).`,
            ephemeral: true
          });
        }

        if (scope === "all") {
          const purge = await purgeTemplateEvents(guildId, templateId, 0, true);
          await setTemplateEnabled(guildId, templateId, false);

          const del = await deleteTemplate(guildId, templateId);
          if (!del) return interaction.reply({ content: "Template not found.", ephemeral: true });

          return interaction.reply({
            content: `✅ Deleted template **#${del.id} ${del.name}** and removed **${purge.deletedEvents}** generated event(s).`,
            ephemeral: true
          });
        }

        return interaction.reply({ content: "Invalid scope.", ephemeral: true });
      }

      return interaction.reply({ content: "Unknown recurring subcommand.", ephemeral: true });
    }

    // ===== ONE-TIME COMMANDS =====

    if (sub === "create") {
      if (requireManageGuild(interaction)) return;
      const name = interaction.options.getString("name", true);
      const startRaw = interaction.options.getString("start", true);
      const { tz, channelId } = await chooseGuildDefaults(guildId, interaction);
      const notes = interaction.options.getString("notes");
      const mention = normalizeMention(interaction.options.getString("mention") || process.env.DEFAULT_MENTION || "none");

      const startTs = parseStartToUtcMillis({ startRaw, timeZone: tz });

      const eventId = await createOneTimeEvent({
        reminderOffsets: readChoices(interaction.options, parseReminders()),
        guildId,
        channelId,
        name,
        startTs,
        notes,
        mention,
        createdBy: interaction.user.id
      });

      const embed = new EmbedBuilder()
        .setTitle(`✅ Event Created: ${name}`)
        .setDescription(
          [
            `**Starts:** ${fmtStartBoth(startTs)}`,
            `**Event ID:** ${eventId}`,
            notes ? `**Notes:** ${safeTruncate(notes)}` : "",
            mention !== "none" ? `**Reminder mention:** ${mention === "everyone" ? "@everyone" : "@here"}` : ""
          ].filter(Boolean).join("\n")
        );

      const ch = await fetchTextChannel(guildId, channelId);
      if (ch) await ch.send({ embeds: [embed] });

      return interaction.reply({ content: `✅ Created event **#${eventId}** and reminders will post in <#${channelId}>.`, ephemeral: true });
    }

    if (sub === "list") {
      const rows = await listActiveEvents(guildId);
      if (!rows.length) return interaction.reply({ content: "No active events.", ephemeral: true });

      const lines = rows.map(e => `**#${e.id}** • **${e.name}** • ${fmtStartBoth(e.start_ts)} • mention=${e.mention || "none"}`);
      return interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }

    if (sub === "end") {
      if (requireManageGuild(interaction)) return;

      const eventId = interaction.options.getInteger("event_id", true);
      const ended = await endEvent(guildId, eventId);
      if (!ended) return interaction.reply({ content: "Event not found or already ended.", ephemeral: true });

      return interaction.reply({ content: `✅ Ended event **#${ended.id} ${ended.name}**.`, ephemeral: true });
    }

    if (sub === "edit") {
      if (requireManageGuild(interaction)) return;

      const eventId = interaction.options.getInteger("event_id", true);
      const patch = {};

      const name = interaction.options.getString("name");
      const startRaw = interaction.options.getString("start");
      const tz = validZone(interaction.options.getString("time_zone") || (await getGuildSettings(guildId)).time_zone);
      const channel = interaction.options.getChannel("channel");
      const notes = interaction.options.getString("notes");
      const mention = interaction.options.getString("mention");

      if (name) patch.name = name;
      if (startRaw) patch.start_ts = parseStartToUtcMillis({ startRaw, timeZone: tz });
      if (channel) patch.channel_id = channel.id;
      if (notes !== null && notes !== undefined) patch.notes = notes;
      if (mention) patch.mention = normalizeMention(mention);

      if (OPTION_NAMES.some(([,name])=>interaction.options.getBoolean(name)!==null))
        patch.reminder_offsets=readChoices(interaction.options,[]);
      const result = await editEvent(guildId, eventId, patch);
      if (!result.updated) return interaction.reply({ content: "Event not found or no changes.", ephemeral: true });

      return interaction.reply({ content: `✅ Updated event **#${eventId}**.${result.rescheduled ? " Pending reminders were rescheduled; fired reminders were preserved." : ""}`, ephemeral: true });
    }

    return interaction.reply({ content: "Unknown subcommand.", ephemeral: true });

  } catch (e) {
    console.error("Command error:", e);
    // Prevent "application did not respond"
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Error: ${e.message || "Unknown error"}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `Error: ${e.message || "Unknown error"}`, ephemeral: true });
      }
    } catch {}
  }
});

// -------------------- STARTUP --------------------

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await initDb(pool);
    console.log("Postgres DB initialized.");
  } catch (e) {
    console.error("DB init failed:", e);
    process.exit(1);
  }

  if (!reminderInterval) reminderInterval = setInterval(remindersTick, 15 * 1000);
  if (!standaloneInterval) standaloneInterval=setInterval(safeStandaloneTick,15*1000);
  void safeStandaloneTick();
  if (!recurringInterval) recurringInterval = setInterval(recurringTick, 10 * 60 * 1000);
  // WEEKLY_SUPPORT_V1: no posts unless a server administrator opts in.
  const safeWeeklyTick = async () => {
    if (weeklySupportTickBusy) return;
    weeklySupportTickBusy = true;
    try { await weeklySupport.weeklySupportTick(pool, fetchTextChannel); }
    catch (err) { console.error("Weekly support tick failed:", err); }
    finally { weeklySupportTickBusy = false; }
  };
  if (!weeklySupportInterval) weeklySupportInterval = setInterval(safeWeeklyTick, 60 * 1000);
  void safeWeeklyTick();

  console.log("Schedulers started.");
});

client.login(DISCORD_TOKEN);
