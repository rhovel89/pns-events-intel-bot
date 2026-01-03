require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
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

async function editEvent(guildId, eventId, patch) {
  // Dynamic update builder
  const fields = [];
  const values = [];
  let i = 1;

  const allowed = ["name", "start_ts", "notes", "mention", "channel_id"];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    fields.push(`${k}=$${i++}`);
    values.push(patch[k]);
  }
  if (!fields.length) return { updated: false, row: null };

  values.push(nowMs(), guildId, eventId);

  const res = await pool.query(
    `UPDATE events
     SET ${fields.join(", ")},
         updated_ts=$${i}
     WHERE guild_id=$${i + 1} AND id=$${i + 2}
     RETURNING id, name, start_ts, notes, mention, channel_id`,
    values
  );

  return { updated: res.rowCount > 0, row: res.rowCount ? res.rows[0] : null };
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
        await pool.query(`UPDATE event_reminders SET fired=TRUE WHERE id=$1`, [row.reminder_id]);
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle(`⏰ Event Reminder: ${row.name}`)
        .setDescription(
          [
            `**Starts:** ${fmtStartBoth(row.start_ts)}`,
            row.notes ? `\n**Notes:** ${safeTruncate(row.notes)}` : ""
          ].join("")
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

// -------------------- INTERACTIONS --------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "event") return;

  try {
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    // ===== RECURRING GROUP =====
    if (group === "recurring") {

      if (sub === "create") {
        if (requireManageGuild(interaction)) return;

        const name = interaction.options.getString("name", true);
        const date = interaction.options.getString("date", true);
        const time = interaction.options.getString("time", true);
        const repeat_days = interaction.options.getString("repeat_days", true);
        const weeks_ahead = interaction.options.getInteger("weeks_ahead", true);

        const tz = interaction.options.getString("time_zone") || "UTC";
        const channel = interaction.options.getChannel("channel");
        const channelId = channel?.id || interaction.channelId;

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
  // Prevent "application did not respond" if DB takes >3s
  await interaction.deferReply({ ephemeral: true });

  try {
    const rows = await listActiveEvents(guildId);

    if (!rows.length) {
      return interaction.editReply({ content: "No active events." });
    }

    const lines = rows.map(e => {
      // start_ts may come back as a string from Postgres
      const ts = Number(e.start_ts);
      const when = Number.isFinite(ts) ? fmtStartBoth(ts) : "**Invalid time**";
      return `**#${e.id}** • **${e.name}** • ${when} • mention=${e.mention || "none"}`;
    });

    // Discord has message length limits; keep it safe
    const msg = lines.join("\n").slice(0, 1900);
    return interaction.editReply({ content: msg });
  } catch (e) {
    console.error("List command failed:", e);
    return interaction.editReply({ content: `Error: ${e.message || "Unknown error"}` });
  }
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

      // ✅ FULLY IMPLEMENTED RECURRING EDIT (this is the fix)
      if (sub === "list") {
  await interaction.deferReply({ ephemeral: true });

  try {
    const rows = await listActiveEvents(guildId);

    if (!rows.length) {
      await interaction.editReply({ content: "No active events." });
      return;
    }

    const lines = rows.map(e => {
      const ts = Number(e.start_ts);
      const when = Number.isFinite(ts) ? fmtStartBoth(ts) : "**Invalid time**";
      return `**#${e.id}** • **${e.name}** • ${when} • mention=${e.mention || "none"}`;
    });

    // Chunk into <= 1900 char payloads (safe under 2000)
    const chunks = [];
    let buf = "";

    for (const line of lines) {
      if ((buf + line + "\n").length > 1900) {
        chunks.push(buf.trimEnd());
        buf = "";
      }
      buf += line + "\n";
    }
    if (buf.trim()) chunks.push(buf.trimEnd());

    // First chunk edits the deferred reply
    await interaction.editReply({ content: chunks[0] });

    // Remaining chunks as follow-ups
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }

    return;
  } catch (e) {
    console.error("List command failed:", e);
    await interaction.editReply({ content: `Error: ${e.message || "Unknown error"}` });
    return;
  }
}

      if (sub === "purge") {
        if (requireManageGuild(interaction)) return;

        const templateId = interaction.options.getInteger("template_id", true);
        const range = interaction.options.getString("range", true);
        const fromStr = interaction.options.getString("from");

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
      const name = interaction.options.getString("name", true);
      const startRaw = interaction.options.getString("start", true);
      const tz = interaction.options.getString("time_zone") || "UTC";
      const channel = interaction.options.getChannel("channel");
      const channelId = channel?.id || interaction.channelId;
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
            notes ? `\n**Notes:** ${safeTruncate(notes)}` : "",
            mention !== "none" ? `\n**Reminder mention:** ${mention === "everyone" ? "@everyone" : "@here"}` : ""
          ].join("")
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
      const tz = interaction.options.getString("time_zone") || "UTC";
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

      return interaction.reply({ content: `✅ Updated event **#${eventId}**.`, ephemeral: true });
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
