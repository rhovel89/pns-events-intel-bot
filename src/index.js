require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField
} = require("discord.js");
const cron = require("node-cron");
const db = require("./db");
const {
  parseReminders,
  safeTruncate,
  parseDateTimeLocalMs,
  parseDateTimeUtcMs,
  nextResetUtcMs,
  fmtUtcDateTime,
  fmtStartBoth
} = require("./utils");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const TZ = process.env.TZ || "America/Chicago";
const EVENTS_CHANNEL_ID = process.env.EVENTS_CHANNEL_ID || null;
const INTEL_CHANNEL_ID = process.env.INTEL_CHANNEL_ID || null;

const RESET_UTC_HOUR = Number(process.env.RESET_UTC_HOUR ?? 0);
const RESET_UTC_MINUTE = Number(process.env.RESET_UTC_MINUTE ?? 0);

const REMINDERS = parseReminders(process.env.EVENT_REMINDERS);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// ---------- DB helpers ----------
function createEvent({ guildId, channelId, name, startTs, notes, createdBy }) {
  const info = db.prepare(`
    INSERT INTO events (guild_id, channel_id, name, start_ts, notes, created_by, status, created_ts)
    VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
  `).run(guildId, channelId, name, startTs, notes || null, createdBy, Date.now());

  const eventId = info.lastInsertRowid;

  const ins = db.prepare(`
    INSERT OR IGNORE INTO event_reminders (event_id, minutes_before, remind_ts, sent_ts)
    VALUES (?, ?, ?, NULL)
  `);

  for (const m of REMINDERS) {
    const remindTs = startTs - m * 60 * 1000;
    if (remindTs > Date.now() - 60 * 1000) {
      ins.run(eventId, m, remindTs);
    }
  }

  return getEventById(eventId);
}

function getEventById(eventId) {
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId);
}

function listActiveEvents(guildId, limit = 15) {
  return db.prepare(`
    SELECT * FROM events
    WHERE guild_id = ? AND status = 'ACTIVE'
    ORDER BY start_ts ASC
    LIMIT ?
  `).all(guildId, limit);
}

function endEvent(guildId, eventId) {
  const row = db.prepare(`SELECT * FROM events WHERE id = ? AND guild_id = ?`).get(eventId, guildId);
  if (!row) return { ok: false };
  db.prepare(`UPDATE events SET status = 'ENDED' WHERE id = ?`).run(eventId);
  return { ok: true, row };
}

function upsertRsvp(eventId, userId, choice) {
  db.prepare(`
    INSERT INTO rsvps (event_id, user_id, choice, updated_ts)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET
      choice = excluded.choice,
      updated_ts = excluded.updated_ts
  `).run(eventId, userId, choice, Date.now());
}

function getRsvpCounts(eventId) {
  const rows = db.prepare(`
    SELECT choice, COUNT(*) as count
    FROM rsvps
    WHERE event_id = ?
    GROUP BY choice
  `).all(eventId);

  const counts = { YES: 0, NO: 0, MAYBE: 0 };
  for (const r of rows) counts[r.choice] = r.count;
  return counts;
}

function getRsvpLists(eventId) {
  const rows = db.prepare(`
    SELECT user_id, choice
    FROM rsvps
    WHERE event_id = ?
  `).all(eventId);

  const lists = { YES: [], NO: [], MAYBE: [] };
  for (const r of rows) lists[r.choice]?.push(r.user_id);
  return lists;
}

// Intel
function addCheckin(guildId, userId) {
  db.prepare("INSERT INTO checkins (guild_id, user_id, ts) VALUES (?, ?, ?)").run(
    guildId, userId, Date.now()
  );
}

function leaderboard7d(guildId) {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT user_id, COUNT(*) as cnt
    FROM checkins
    WHERE guild_id = ? AND ts >= ?
    GROUP BY user_id
    ORDER BY cnt DESC
    LIMIT 20
  `).all(guildId, since);
}

function lastCheckinByUser(guildId) {
  return db.prepare(`
    SELECT user_id, MAX(ts) as last_ts
    FROM checkins
    WHERE guild_id = ?
    GROUP BY user_id
  `).all(guildId);
}

// ---------- Rendering ----------
function eventEmbed(eventRow) {
  const counts = getRsvpCounts(eventRow.id);
  const lists = getRsvpLists(eventRow.id);

  const embed = new EmbedBuilder()
    .setTitle(`Event #${eventRow.id}: ${eventRow.name}`)
    .setDescription(
      [
        `**Start**\n${fmtStartBoth(eventRow.start_ts)}`,
        eventRow.notes ? `**Notes:** ${safeTruncate(eventRow.notes, 800)}` : null,
        "",
        `**RSVPs:** ✅ Yes ${counts.YES} | ❔ Maybe ${counts.MAYBE} | ❌ No ${counts.NO}`,
        "",
        `**Yes:** ${lists.YES.length ? lists.YES.map(id => `<@${id}>`).join(", ") : "—"}`,
        `**Maybe:** ${lists.MAYBE.length ? lists.MAYBE.map(id => `<@${id}>`).join(", ") : "—"}`,
        `**No:** ${lists.NO.length ? lists.NO.map(id => `<@${id}>`).join(", ") : "—"}`
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: `Status: ${eventRow.status}` })
    .setTimestamp(new Date(eventRow.created_ts));

  return embed;
}

async function postEventMessage(eventRow) {
  const channel = await client.channels.fetch(eventRow.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const msg = await channel.send({ embeds: [eventEmbed(eventRow)] }).catch(() => null);
  if (!msg) return null;

  db.prepare("UPDATE events SET message_id = ? WHERE id = ?").run(msg.id, eventRow.id);
  return msg;
}

async function updateEventMessage(eventId) {
  const eventRow = getEventById(eventId);
  if (!eventRow || !eventRow.message_id) return;

  const channel = await client.channels.fetch(eventRow.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const msg = await channel.messages.fetch(eventRow.message_id).catch(() => null);
  if (!msg) return;

  await msg.edit({ embeds: [eventEmbed(eventRow)] }).catch(() => null);
}

// ---------- Reminder scanner ----------
async function scanAndSendReminders() {
  const now = Date.now();
  const windowStart = now - 30 * 1000;
  const windowEnd = now + 30 * 1000;

  const due = db.prepare(`
    SELECT er.event_id, er.minutes_before, er.remind_ts,
           e.channel_id, e.name, e.start_ts, e.status
    FROM event_reminders er
    JOIN events e ON e.id = er.event_id
    WHERE er.sent_ts IS NULL
      AND e.status = 'ACTIVE'
      AND er.remind_ts BETWEEN ? AND ?
    ORDER BY er.remind_ts ASC
    LIMIT 25
  `).all(windowStart, windowEnd);

  for (const r of due) {
    const channel = await client.channels.fetch(r.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    const embed = new EmbedBuilder()
      .setTitle(`Reminder: ${r.name} (Event #${r.event_id})`)
      .setDescription(
        `Starts in **${r.minutes_before} min**.\n\n**Start**\n${fmtStartBoth(r.start_ts)}\n\nRSVP: \`/event rsvp event_id:${r.event_id}\``
      )
      .setTimestamp(new Date());

    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      db.prepare(`
        UPDATE event_reminders
        SET sent_ts = ?
        WHERE event_id = ? AND minutes_before = ?
      `).run(Date.now(), r.event_id, r.minutes_before);
    }
  }
}

// ---------- Start parsing ----------
function resolveStartTs(startInput) {
  const raw = startInput.trim();
  const s = raw.toLowerCase();

  // UTC reset keywords (game time)
  if (s === "utcreset" || s === "nextutcreset" || s === "utc reset") {
    return nextResetUtcMs({ resetUtcHour: RESET_UTC_HOUR, resetUtcMinute: RESET_UTC_MINUTE });
  }

  // Explicit UTC datetime: "utc:YYYY-MM-DD HH:mm"
  if (s.startsWith("utc:")) {
    const dt = raw.slice(4).trim();
    return parseDateTimeUtcMs(dt);
  }

  // Default: treat input as local server time
  return parseDateTimeLocalMs(raw);
}

// ---------- Interactions ----------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const guild = interaction.guild;
  if (!guild) return;

  try {
    if (interaction.commandName === "event") {
      const sub = interaction.options.getSubcommand();

      if (sub === "create") {
        const member = interaction.member;
        const hasPerm = member.permissions?.has(PermissionsBitField.Flags.ManageGuild);
        if (!hasPerm) {
          await interaction.reply({ content: "You need **Manage Server** permission to create events.", ephemeral: true });
          return;
        }

        const name = interaction.options.getString("name", true);
        const start = interaction.options.getString("start", true);
        const notes = interaction.options.getString("notes") || null;

        const startTs = resolveStartTs(start);
        if (!startTs) {
          await interaction.reply({
            content: "Invalid start. Use `utcreset` or `utc:YYYY-MM-DD HH:mm` or local `YYYY-MM-DD HH:mm`.",
            ephemeral: true
          });
          return;
        }

        const channelId = EVENTS_CHANNEL_ID || interaction.channelId;

        const eventRow = createEvent({
          guildId: guild.id,
          channelId,
          name,
          startTs,
          notes,
          createdBy: interaction.user.id
        });

        await interaction.reply({
          content: `Created **Event #${eventRow.id}**: **${eventRow.name}** in <#${channelId}>.\nStart (UTC): **${fmtUtcDateTime(eventRow.start_ts)}**`,
          ephemeral: true
        });

        await postEventMessage(eventRow);
        return;
      }

      if (sub === "list") {
        const rows = listActiveEvents(guild.id, 15);
        if (!rows.length) {
          await interaction.reply({ content: "No active events.", ephemeral: true });
          return;
        }

        const desc = rows.map(e =>
          `**#${e.id}** — **${e.name}**\n• Local: ${require("./utils").fmtDiscordTs(e.start_ts)}\n• UTC: ${fmtUtcDateTime(e.start_ts)}`
        ).join("\n\n");

        const embed = new EmbedBuilder()
          .setTitle("Active Events")
          .setDescription(desc)
          .setTimestamp(new Date());

        await interaction.reply({ embeds: [embed] });
        return;
      }

      if (sub === "status") {
        const eventId = interaction.options.getInteger("event_id", true);
        const row = getEventById(eventId);
        if (!row || row.guild_id !== guild.id) {
          await interaction.reply({ content: "Event not found for this server.", ephemeral: true });
          return;
        }
        await interaction.reply({ embeds: [eventEmbed(row)] });
        return;
      }

      if (sub === "rsvp") {
        const eventId = interaction.options.getInteger("event_id", true);
        const choice = interaction.options.getString("choice", true);

        const row = getEventById(eventId);
        if (!row || row.guild_id !== guild.id || row.status !== "ACTIVE") {
          await interaction.reply({ content: "That event is not active (or not found).", ephemeral: true });
          return;
        }

        upsertRsvp(eventId, interaction.user.id, choice);
        await interaction.reply({ content: `RSVP saved: **${choice}** for **Event #${row.id} — ${row.name}**.`, ephemeral: true });
        await updateEventMessage(eventId);
        return;
      }

      if (sub === "end") {
        const member = interaction.member;
        const hasPerm = member.permissions?.has(PermissionsBitField.Flags.ManageGuild);
        if (!hasPerm) {
          await interaction.reply({ content: "You need **Manage Server** permission to end events.", ephemeral: true });
          return;
        }

        const eventId = interaction.options.getInteger("event_id", true);
        const res = endEvent(guild.id, eventId);
        if (!res.ok) {
          await interaction.reply({ content: "Event not found for this server.", ephemeral: true });
          return;
        }

        await interaction.reply({ content: `Event ended: **#${eventId} — ${res.row.name}**.`, ephemeral: true });
        await updateEventMessage(eventId);
        return;
      }
    }

    if (interaction.commandName === "intel") {
      const sub = interaction.options.getSubcommand();

      if (sub === "checkin") {
        addCheckin(guild.id, interaction.user.id);
        await interaction.reply({ content: "Check-in recorded. Thank you.", ephemeral: true });
        return;
      }

      if (sub === "leaderboard") {
        const rows = leaderboard7d(guild.id);
        const desc = rows.length
          ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.cnt}`).join("\n")
          : "No check-ins yet in the last 7 days.";

        const embed = new EmbedBuilder()
          .setTitle("Check-in Leaderboard (Last 7 Days)")
          .setDescription(desc)
          .setTimestamp(new Date());

        await interaction.reply({ embeds: [embed] });
        return;
      }
    }

    if (interaction.commandName === "inactive") {
      const days = interaction.options.getInteger("days") || 7;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      const lastRows = lastCheckinByUser(guild.id).filter(r => r.last_ts < cutoff);

      const desc = lastRows.length
        ? lastRows
            .sort((a, b) => a.last_ts - b.last_ts)
            .slice(0, 40)
            .map(r => `<@${r.user_id}> — last check-in ${require("./utils").fmtDiscordTs(r.last_ts)}`)
            .join("\n")
        : `No users found with check-ins older than ${days} days.`;

      const embed = new EmbedBuilder()
        .setTitle(`Inactive Check (>${days} days since check-in)`)
        .setDescription(desc)
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed] });
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "An error occurred while processing that command.", ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: "An error occurred while processing that command.", ephemeral: true }).catch(() => {});
    }
  }
});

// ---------- Cron jobs ----------
function setupCrons() {
  // Scan reminders every minute
  cron.schedule("* * * * *", async () => {
    await scanAndSendReminders();
  }, { timezone: TZ });

  // Daily check-in prompt at 10:00 AM Central (admin convenience)
  cron.schedule("0 10 * * *", async () => {
    if (!INTEL_CHANNEL_ID) return;
    const channel = await client.channels.fetch(INTEL_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle("Daily Check-In")
      .setDescription("Use `/intel checkin` to mark yourself active today.")
      .setTimestamp(new Date());

    await channel.send({ embeds: [embed] }).catch(() => null);
  }, { timezone: TZ });
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  setupCrons();
});

client.login(TOKEN);
