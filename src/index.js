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
const { makePool, initDb } = require("./db");

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

let reminderInterval = null;
let recurringInterval = null;

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

// -------------------- EVENTS --------------------

async function createEventReminders(eventId, startTs, remindersArr) {
  const rems = (remindersArr || []).map(m => ({
    remind_at_ts: startTs - m * 60 * 1000
  }));

  for (const r of rems) {
    if (r.remind_at_ts <= nowMs()) continue;
    await pool.query(
      `INSERT INTO event_reminders (event_id, remind_at_ts, fired)
       VALUES ($1, $2, FALSE)`,
      [eventId, r.remind_at_ts]
    );
  }
}

async function createOneTimeEvent({
  guildId,
  channelId,
  name,
  startTs,
  notes,
  mention,
  createdBy,
  recurringTemplateId = null
}) {
  const createdTs = nowMs();

  const res = await pool.query(
    `INSERT INTO events (guild_id, channel_id, name, start_ts, notes, is_active, created_by, created_ts, mention, recurring_template_id)
     VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$9)
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
      recurringTemplateId
    ]
  );

  const eventId = res.rows[0].id;

  const reminders = parseReminders();
  await createEventReminders(eventId, startTs, reminders);

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
  const allowed = ["name", "start_ts", "notes", "mention", "channel_id"];
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
       RETURNING id, name, start_ts, notes, mention, channel_id`, values
    );
    const rescheduled = patch.start_ts !== undefined &&
      Number(patch.start_ts) !== Number(original.rows[0].start_ts);
    if (rescheduled) {
      await db.query(`DELETE FROM event_reminders WHERE event_id=$1 AND fired=FALSE`, [eventId]);
      const times = [...new Set(parseReminders().map(minutes =>
        Number(patch.start_ts) - minutes * 60000).filter(ts => ts > nowMs()))];
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
  createdBy
}) {
  const createdTs = nowMs();

  const res = await pool.query(
    `INSERT INTO recurring_templates
     (guild_id, channel_id, name, tz, time_hhmm, repeat_days, notes, reminders, weeks_ahead, is_enabled, mention, created_by, created_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12)
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
      createdTs
    ]
  );

  return res.rows[0].id;
}

async function listRecurringTemplates(guildId) {
  const res = await pool.query(
    `SELECT id, name, channel_id, tz, time_hhmm, repeat_days, weeks_ahead, is_enabled, mention
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

async function editRecurringTemplate(guildId, templateId, patch) {
  const fields = [];
  const values = [];
  let i = 1;

  const allowed = ["name", "tz", "time_hhmm", "repeat_days", "weeks_ahead", "notes", "mention", "channel_id"];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    fields.push(`${k}=$${i++}`);
    values.push(patch[k]);
  }
  if (!fields.length) return { updated: false, row: null };

  values.push(nowMs(), guildId, templateId);

  const res = await pool.query(
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

async function generateTemplateEvents(template, anchorDateStr) {
  const tz = template.tz || "UTC";
  const { hh, mm } = parseHhMm(template.time_hhmm);
  const repeatDays = template.repeat_days || [];
  const weeksAhead = template.weeks_ahead || 4;

  const anchor = parseYyyyMmDd(anchorDateStr || DateTime.utc().toFormat("yyyy-LL-dd"));

  const startRangeUtc = DateTime.utc();
  const endRangeUtc = DateTime.utc().plus({ days: weeksAhead * 7 });

  let inserted = 0;

  for (let d = anchor; d <= endRangeUtc; d = d.plus({ days: 1 })) {
    const weekday = d.weekday; // 1..7
    const isWanted = repeatDays.some(x => dayToLuxonWeekday(x) === weekday);
    if (!isWanted) continue;

    const local = DateTime.fromObject(
      { year: d.year, month: d.month, day: d.day, hour: hh, minute: mm, second: 0, millisecond: 0 },
      { zone: tz }
    );
    if (!local.isValid) continue;

    const startUtc = local.toUTC();
    const startTs = startUtc.toMillis();

    if (startTs < startRangeUtc.toMillis()) continue;
    if (startTs > endRangeUtc.toMillis()) continue;

    try {
      await createOneTimeEvent({
        guildId: template.guild_id,
        channelId: template.channel_id,
        name: template.name,
        startTs,
        notes: template.notes,
        mention: template.mention || "none",
        createdBy: template.created_by,
        recurringTemplateId: template.id
      });
      inserted += 1;
    } catch {
      // Duplicate insert ignored (unique index in db.js)
    }
  }

  return inserted;
}

async function purgeTemplateEvents(guildId, templateId, fromTs, all) {
  const from = all ? 0 : fromTs;

  const idsRes = await pool.query(
    `SELECT id FROM events
     WHERE guild_id=$1 AND recurring_template_id=$2 AND start_ts >= $3`,
    [guildId, templateId, from]
  );

  const eventIds = idsRes.rows.map(r => r.id);
  if (!eventIds.length) return { deletedEvents: 0 };

  await pool.query(`DELETE FROM event_reminders WHERE event_id = ANY($1::int[])`, [eventIds]);
  await pool.query(`DELETE FROM rsvps WHERE event_id = ANY($1::int[])`, [eventIds]);
  const delRes = await pool.query(`DELETE FROM events WHERE id = ANY($1::int[])`, [eventIds]);

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
    const res = await pool.query(`SELECT * FROM recurring_templates WHERE is_enabled=TRUE`);
    for (const t of res.rows) {
      await generateTemplateEvents(t, DateTime.utc().toFormat("yyyy-LL-dd"));
    }
  } catch (e) {
    console.error("Recurring tick error:", e);
  }
}

// -------------------- REMINDERS --------------------

async function remindersTick() {
  try {
    const res = await pool.query(
      `SELECT er.id as reminder_id, er.event_id, er.remind_at_ts, e.guild_id, e.channel_id, e.name, e.start_ts, e.notes, e.mention
       FROM event_reminders er
       JOIN events e ON e.id = er.event_id
       WHERE er.fired=FALSE
         AND e.is_active=TRUE
         AND er.remind_at_ts <= $1
       ORDER BY er.remind_at_ts ASC
       LIMIT 25`,
      [nowMs()]
    );

    for (const row of res.rows) {
      const ch = await fetchTextChannel(row.guild_id, row.channel_id);
      if (!ch) {
        // Do not silently discard a reminder if the channel is temporarily inaccessible.
        console.warn(`Reminder ${row.reminder_id} cannot access channel ${row.channel_id}`);
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle(`⏰ Event Reminder: ${row.name}`)
        .setDescription(
          [
            `**Starts:** ${fmtStartBoth(row.start_ts)}`,
            row.notes ? `**Notes:** ${safeTruncate(row.notes)}` : ""
          ].filter(Boolean).join("\n")
        )
        .setFooter({ text: `Event ID: ${row.event_id}` });

      const mention = normalizeMention(row.mention || process.env.DEFAULT_MENTION || "none");

      await ch.send({
        content: mentionText(mention),
        embeds: [embed],
        // allow @everyone/@here only when chosen
        allowedMentions: { parse: mention === "everyone" || mention === "here" ? ["everyone"] : [] }
      });

      await pool.query(`UPDATE event_reminders SET fired=TRUE WHERE id=$1`, [row.reminder_id]);
    }
  } catch (e) {
    console.error("Reminders tick error:", e);
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
    const c = counts.rows[0];
    embed.addFields(
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
        guildId, channelId, name, startTs, notes, mention, createdBy: interaction.user.id
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

        const { tz, channelId } = await chooseGuildDefaults(guildId, interaction);

        const notes = interaction.options.getString("notes");
        const mention = normalizeMention(interaction.options.getString("mention") || process.env.DEFAULT_MENTION || "none");
        const repeatDaysArr = normalizeRepeatDays(repeat_days);

        parseHhMm(time); // validate time

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
          createdBy: interaction.user.id
        });

        const tRes = await pool.query(`SELECT * FROM recurring_templates WHERE id=$1`, [templateId]);
        const inserted = await generateTemplateEvents(tRes.rows[0], date);

        return interaction.reply({
          content: `✅ Created recurring template **#${templateId}** and generated **${inserted}** event(s). Reminders will post in <#${channelId}>.`,
          ephemeral: true
        });
      }

      if (sub === "list") {
        await interaction.deferReply({ ephemeral: true });
        const rows = await listRecurringTemplates(guildId);
        const lines = rows.map(r => `#${r.id} • ${r.name} • ${r.time_hhmm} (${r.tz}) • ${r.is_enabled ? "enabled" : "disabled"}`);
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
        const name = interaction.options.getString("name");
        const time = interaction.options.getString("time");
        const zone = interaction.options.getString("time_zone");
        const days = interaction.options.getString("repeat_days");
        const weeks = interaction.options.getInteger("weeks_ahead");
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
        if (weeks !== null) patch.weeks_ahead = weeks;
        if (channel) patch.channel_id = channel.id;
        if (notes !== null) patch.notes = notes;
        if (mention !== null) patch.mention = normalizeMention(mention);
        if (interaction.options.getBoolean("apply_future") && interaction.options.getString("confirm") !== `APPLY ${templateId}`) {
          throw new Error(`Nothing changed. Set confirm to APPLY ${templateId} before regenerating future events.`);
        }
        const result = await editRecurringTemplate(guildId, templateId, patch);
        if (!result.updated) return interaction.reply({ content: "Template not found or no changes.", ephemeral: true });
        if (interaction.options.getBoolean("apply_future")) {
          await purgeTemplateEvents(guildId, templateId, nowMs(), false);
          if (result.row.is_enabled) await generateTemplateEvents(result.row, DateTime.utc().toFormat("yyyy-LL-dd"));
        }
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
  if (!recurringInterval) recurringInterval = setInterval(recurringTick, 10 * 60 * 1000);

  console.log("Schedulers started.");
});

client.login(DISCORD_TOKEN);
