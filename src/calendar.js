"use strict";

// CALENDAR_V1 — read-only, guild-scoped Discord UI; no database migrations.
const { DateTime } = require("luxon");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  escapeMarkdown
} = require("discord.js");

const PREFIX = "713cal";
const MODES = new Set(["day", "week", "month"]);
const LIMIT = 25; // Discord select menus permit at most 25 options.

function validDay(raw, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw || "")) throw new Error("Date must be YYYY-MM-DD.");
  const dt = DateTime.fromISO(raw, { zone });
  if (!dt.isValid || dt.toFormat("yyyy-LL-dd") !== raw) throw new Error("Invalid calendar date.");
  return dt.startOf("day");
}

function calendarRange(mode, date) {
  if (!MODES.has(mode)) throw new Error("Unknown calendar view.");
  const from = mode === "week" ? date.startOf("week") : mode === "month" ? date.startOf("month") : date.startOf("day");
  return { from, to: from.plus({ [mode === "day" ? "days" : mode === "week" ? "weeks" : "months"]: 1 }) };
}

function identifier(userId, mode, date, action) {
  return [PREFIX, userId, mode, date, action].join("|");
}

function parseIdentifier(raw) {
  const parts = (raw || "").split("|");
  if (parts.length !== 5 || parts[0] !== PREFIX || !/^\d{10,22}$/.test(parts[1]) ||
      !MODES.has(parts[2]) || !/^\d{4}-\d{2}-\d{2}$/.test(parts[3]) ||
      !["prev", "next", "today", "day", "week", "month", "pick", "back"].includes(parts[4])) {
    throw new Error("Invalid or outdated calendar control. Run /event calendar again.");
  }
  return { owner: parts[1], mode: parts[2], date: parts[3], action: parts[4] };
}

function addNavButtons(userId, mode, date) {
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(identifier(userId, mode, date, "prev")).setLabel("◀ Previous").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(identifier(userId, mode, date, "today")).setLabel("Today").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(identifier(userId, mode, date, "next")).setLabel("Next ▶").setStyle(ButtonStyle.Secondary)
  );
  const modes = new ActionRowBuilder().addComponents(
    ...["day", "week", "month"].map(m => new ButtonBuilder()
      .setCustomId(identifier(userId, mode, date, m))
      .setLabel(m === "day" ? "Day" : m === "week" ? "Week" : "Month")
      .setStyle(mode === m ? ButtonStyle.Success : ButtonStyle.Secondary))
  );
  return [nav, modes];
}

function displayName(raw, max = 72) {
  const safe = escapeMarkdown(String(raw || "Untitled").replace(/\s+/g, " ").replace(/@/g, "＠"));
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

function createCalendar({ pool, getGuildSettings }) {
  async function zoneForGuild(guildId) {
    const settings = await getGuildSettings(guildId);
    const zone = settings?.time_zone || "UTC";
    return DateTime.now().setZone(zone).isValid ? zone : "UTC";
  }

  async function renderCalendar(guildId, userId, mode = "week", dateRaw = null) {
    if (!MODES.has(mode)) throw new Error("View must be day, week or month.");
    const zone = await zoneForGuild(guildId);
    const date = dateRaw ? validDay(dateRaw, zone) : DateTime.now().setZone(zone).startOf("day");
    const { from, to } = calendarRange(mode, date);
    const result = await pool.query(`
      SELECT id, name, start_ts, channel_id, recurring_template_id
      FROM events
      WHERE guild_id=$1 AND is_active=TRUE AND start_ts >= $2 AND start_ts < $3
      ORDER BY start_ts ASC, id ASC LIMIT $4
    `, [guildId, from.toMillis(), to.toMillis(), LIMIT + 1]);
    const rows = result.rows.slice(0, LIMIT);
    const overflow = result.rows.length > LIMIT;
    const title = mode === "day" ? from.toFormat("cccc, LLLL d, yyyy") :
      mode === "week" ? `${from.toFormat("LLL d")} – ${to.minus({ days: 1 }).toFormat("LLL d, yyyy")}` : from.toFormat("LLLL yyyy");

    const lines = [];
    let lastDay = "";
    for (const event of rows) {
      const local = DateTime.fromMillis(Number(event.start_ts), { zone });
      const day = local.toFormat("yyyy-LL-dd");
      if (day !== lastDay) {
        lines.push(`**${local.toFormat("ccc, LLL d")}**`);
        lastDay = day;
      }
      const unix = Math.floor(Number(event.start_ts) / 1000);
      lines.push(`• **${local.toFormat("HH:mm")}** · ${displayName(event.name, 65)} · <t:${unix}:R> · \`#${event.id}\``);
    }
    if (!rows.length) lines.push("No events scheduled in this period. 🌙");
    if (overflow) lines.push("_More events exist. Switch to Week or Day to see the rest._");

    const embed = new EmbedBuilder().setColor(0x91eb42)
      .setTitle(`🧟 SleepySwallow • ${mode[0].toUpperCase() + mode.slice(1)} Calendar`)
      .setDescription(`**${title}**\n**Alliance time zone:** ${zone}\n\n${lines.join("\n").slice(0, 3850)}`)
      .setFooter({ text: `713 Event Reminders • ${rows.length}${overflow ? "+" : ""} events displayed • Private to you` });
    const dateKey = date.toFormat("yyyy-LL-dd");
    const components = addNavButtons(userId, mode, dateKey);
    if (rows.length) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(identifier(userId, mode, dateKey, "pick"))
        .setPlaceholder("🔎 Select an event for details")
        .addOptions(rows.map(event => {
          const local = DateTime.fromMillis(Number(event.start_ts), { zone });
          return {
            label: `${local.toFormat("LLL d HH:mm")} · ${String(event.name || "Untitled")}`.replace(/[\r\n]/g, " ").slice(0, 100),
            value: String(event.id),
            description: `Event #${event.id}${event.recurring_template_id ? " · Recurring" : ""}`.slice(0, 100)
          };
        }));
      components.push(new ActionRowBuilder().addComponents(select));
    }
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
  }

  async function renderDetails(guildId, userId, mode, date, eventId) {
    const zone = await zoneForGuild(guildId);
    const day = validDay(date, zone);
    const { from, to } = calendarRange(mode, day);
    const result = await pool.query(`
      SELECT id, name, start_ts, notes, mention, channel_id, recurring_template_id
      FROM events
      WHERE guild_id=$1 AND id=$2 AND is_active=TRUE AND start_ts >= $3 AND start_ts < $4
    `, [guildId, eventId, from.toMillis(), to.toMillis()]);
    const back = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(identifier(userId, mode, date, "back")).setLabel("◀ Back to calendar").setStyle(ButtonStyle.Primary)
    );
    if (!result.rowCount) return {
      content: "This event was moved, ended, or is no longer in the selected calendar period.",
      embeds: [], components: [back], allowedMentions: { parse: [] }
    };
    const event = result.rows[0];
    const unix = Math.floor(Number(event.start_ts) / 1000);
    const local = DateTime.fromMillis(Number(event.start_ts), { zone });
    const embed = new EmbedBuilder().setColor(0xb05afa)
      .setTitle(`🧟 Event #${event.id} • ${displayName(event.name, 140)}`)
      .addFields(
        { name: "Alliance time", value: `${local.toFormat("cccc, LLL d yyyy · HH:mm")} (${zone})` },
        { name: "Your local time", value: `<t:${unix}:F> · <t:${unix}:R>` },
        { name: "Reminder channel", value: `<#${event.channel_id}>` },
        { name: "Type", value: event.recurring_template_id ? "Recurring occurrence" : "One-time event" }
      )
      .setFooter({ text: "Read-only event details • Administrators can use /event edit" });
    if (event.notes) embed.addFields({ name: "Notes", value: displayName(event.notes, 950) });
    return { content: "", embeds: [embed], components: [back], allowedMentions: { parse: [] } };
  }

  async function handleComponent(interaction) {
    if (!interaction.customId.startsWith(`${PREFIX}|`)) return false;
    try {
      if (!interaction.guildId) throw new Error("Calendar controls only work in a server.");
      const parsed = parseIdentifier(interaction.customId);
      if (parsed.owner !== interaction.user.id) {
        await interaction.reply({ content: "This calendar belongs to another member. Run `/event calendar` to open your own.", ephemeral: true });
        return true;
      }
      const zone = await zoneForGuild(interaction.guildId);
      const date = validDay(parsed.date, zone);
      let response;
      if (interaction.isStringSelectMenu() && parsed.action === "pick") {
        const selected = interaction.values[0];
        if (!/^\d{1,10}$/.test(selected)) throw new Error("Invalid event selection.");
        response = await renderDetails(interaction.guildId, parsed.owner, parsed.mode, parsed.date, Number(selected));
      } else if (interaction.isButton() && parsed.action !== "pick") {
        let next = date;
        let mode = parsed.mode;
        if (parsed.action === "today") next = DateTime.now().setZone(zone).startOf("day");
        else if (parsed.action === "prev" || parsed.action === "next") {
          const amount = parsed.action === "prev" ? -1 : 1;
          next = calendarRange(mode, date).from.plus({ [mode === "day" ? "days" : mode === "week" ? "weeks" : "months"]: amount });
        } else if (MODES.has(parsed.action)) mode = parsed.action;
        if (parsed.action === "back") mode = parsed.mode;
        response = await renderCalendar(interaction.guildId, parsed.owner, mode, next.toFormat("yyyy-LL-dd"));
      } else throw new Error("Unsupported calendar interaction.");
      await interaction.update({ content: "", ...response });
    } catch (err) {
      console.error("Calendar UI error:", err);
      const content = `Calendar could not refresh: ${String(err.message || "unknown error").slice(0, 150)}`;
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
    return true;
  }
  return { renderCalendar, handleComponent };
}

module.exports = { createCalendar, calendarRange, validDay, parseIdentifier };
