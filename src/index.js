require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");

const db = require("./db");
const {
  parseRemindersEnv,
  safeTruncate,
  fmtStartBoth,
  parseStartToUtcMillis,
  normalizeRepeatDays,
  parseHHMM,
  generateOccurrences,
} = require("./utils");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const EVENTS_CHANNEL_ID = process.env.EVENTS_CHANNEL_ID || null;
const DEFAULT_REMINDERS = parseRemindersEnv([60, 15, 5]);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
}

async function scheduleEventReminders(eventId, startTs, remindersArr) {
  const now = Date.now();
  for (const mins of remindersArr) {
    const remindAt = startTs - mins * 60 * 1000;
    if (remindAt > now) {
      await db.query(
        `INSERT INTO event_reminders (event_id, remind_at_ts, fired)
         VALUES ($1,$2,false)`,
        [eventId, remindAt]
      );
    }
  }
}

async function createSingleEvent({ guildId, channelId, name, startTs, notes, createdBy }) {
  const createdTs = Date.now();
  const res = await db.query(
    `INSERT INTO events (guild_id, channel_id, name, start_ts, notes, is_active, created_by, created_ts)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7)
     RETURNING id`,
    [guildId, channelId, name, startTs, notes ?? null, createdBy ?? null, createdTs]
  );
  const eventId = res.rows[0].id;

  // reminders
  await scheduleEventReminders(eventId, startTs, DEFAULT_REMINDERS);
  return eventId;
}

async function postEventCreated(channel, eventId, name, startTs, notes) {
  const embed = new EmbedBuilder()
    .setTitle(`✅ Event Created #${eventId}`)
    .setDescription(`**${name}**\nStart: ${fmtStartBoth(startTs)}${notes ? `\n\n${safeTruncate(notes)}` : ""}`);

  await channel.send({ embeds: [embed] });
}

async function listActiveEvents(guildId) {
  const res = await db.query(
    `SELECT id, name, start_ts, notes
     FROM events
     WHERE guild_id = $1 AND is_active = true
     ORDER BY start_ts ASC`,
    [guildId]
  );
  return res.rows;
}

async function endEvent(guildId, eventId) {
  const endedTs = Date.now();
  const res = await db.query(
    `UPDATE events
     SET is_active = false, ended_ts = $1
     WHERE guild_id = $2 AND id = $3 AND is_active = true
     RETURNING id`,
    [endedTs, guildId, eventId]
  );
  return res.rowCount > 0;
}

// === RECURRING ===
// Matches your schema: tz, is_enabled, channel_id, repeat_days (text[])
async function createTemplate(interaction) {
  const guildId = interaction.guildId;
  const channelId = EVENTS_CHANNEL_ID || interaction.channelId;

  const name = interaction.options.getString("name", true);
  const date = interaction.options.getString("date", true);
  const time = parseHHMM(interaction.options.getString("time", true));
  const repeatDaysRaw = interaction.options.getString("repeat_days", true);
  const weeksAhead = interaction.options.getInteger("weeks_ahead", true);
  const tz = interaction.options.getString("time_zone") || "UTC";
  const notes = interaction.options.getString("notes") || null;

  const repeatDays = normalizeRepeatDays(repeatDaysRaw);
  if (!repeatDays.length) throw new Error("repeat_days must include at least one day (mon..sun).");

  const reminders = DEFAULT_REMINDERS; // store defaults; can upgrade later per-template

  const now = Date.now();

  // Insert template (channel_id is REQUIRED by your schema)
  const tRes = await db.query(
    `INSERT INTO recurring_templates
      (guild_id, channel_id, name, tz, time_hhmm, repeat_days, notes, reminders, weeks_ahead, is_enabled, created_by, created_ts, updated_ts)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12)
     RETURNING id`,
    [
      guildId,
      channelId,
      name,
      tz,
      time,
      repeatDays,
      notes,
      reminders,
      weeksAhead,
      interaction.user.id,
      now,
      now,
    ]
  );

  const templateId = tRes.rows[0].id;

  // Generate occurrences
  const starts = generateOccurrences({
    anchorDate: date,
    timeHHMM: time,
    tz,
    repeatDays,
    weeksAhead,
  });

  // Create event rows + link occurrences
  const createdEventIds = [];
  for (const startTs of starts) {
    const eventId = await createSingleEvent({
      guildId,
      channelId,
      name,
      startTs,
      notes,
      createdBy: interaction.user.id,
    });

    await db.query(
      `INSERT INTO recurring_occurrences (template_id, event_id, start_ts, created_ts)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (template_id, start_ts) DO NOTHING`,
      [templateId, eventId, startTs, now]
    );

    createdEventIds.push(eventId);
  }

  return { templateId, channelId, createdEventIds, name, tz, time, repeatDays, weeksAhead };
}

async function listTemplates(guildId) {
  const res = await db.query(
    `SELECT id, name, tz, time_hhmm, repeat_days, weeks_ahead, is_enabled
     FROM recurring_templates
     WHERE guild_id = $1
     ORDER BY id DESC`,
    [guildId]
  );
  return res.rows;
}

async function disableTemplate(guildId, templateId) {
  const now = Date.now();
  const res = await db.query(
    `UPDATE recurring_templates
     SET is_enabled = false, updated_ts = $1
     WHERE guild_id = $2 AND id = $3
     RETURNING id`,
    [now, guildId, templateId]
  );
  return res.rowCount > 0;
}

async function extendTemplate(guildId, templateId, newWeeksAhead) {
  const now = Date.now();
  // fetch template
  const t = await db.query(
    `SELECT id, channel_id, name, tz, time_hhmm, repeat_days, notes
     FROM recurring_templates
     WHERE guild_id = $1 AND id = $2 AND is_enabled = true`,
    [guildId, templateId]
  );
  if (!t.rowCount) throw new Error("Template not found or disabled.");

  const template = t.rows[0];

  // update weeks_ahead policy
  await db.query(
    `UPDATE recurring_templates SET weeks_ahead = $1, updated_ts = $2 WHERE id = $3`,
    [newWeeksAhead, now, templateId]
  );

  // Determine an anchor date: today in tz
  const anchorDate = require("luxon").DateTime.now().setZone(template.tz).toFormat("yyyy-LL-dd");

  const starts = generateOccurrences({
    anchorDate,
    timeHHMM: template.time_hhmm,
    tz: template.tz,
    repeatDays: template.repeat_days,
    weeksAhead: newWeeksAhead,
  });

  // insert only missing occurrences
  const created = [];
  for (const startTs of starts) {
    const exists = await db.query(
      `SELECT 1 FROM recurring_occurrences WHERE template_id = $1 AND start_ts = $2`,
      [templateId, startTs]
    );
    if (exists.rowCount) continue;

    const eventId = await createSingleEvent({
      guildId,
      channelId: template.channel_id,
      name: template.name,
      startTs,
      notes: template.notes,
      createdBy: "system",
    });

    await db.query(
      `INSERT INTO recurring_occurrences (template_id, event_id, start_ts, created_ts)
       VALUES ($1,$2,$3,$4)`,
      [templateId, eventId, startTs, now]
    );

    created.push(eventId);
  }

  return created;
}

// === REMINDER WORKER ===
async function remindersTick() {
  const now = Date.now();

  const due = await db.query(
    `SELECT er.id, er.event_id, e.guild_id, e.channel_id, e.name, e.start_ts, e.notes
     FROM event_reminders er
     JOIN events e ON e.id = er.event_id
     WHERE er.fired = false AND er.remind_at_ts <= $1 AND e.is_active = true
     ORDER BY er.remind_at_ts ASC
     LIMIT 25`,
    [now]
  );

  for (const row of due.rows) {
    try {
      const guild = await client.guilds.fetch(row.guild_id);
      const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle("⏰ Event Reminder")
          .setDescription(`**${row.name}**\nStart: ${fmtStartBoth(Number(row.start_ts))}${row.notes ? `\n\n${safeTruncate(row.notes)}` : ""}`);
        await channel.send({ embeds: [embed] });
      }
    } catch (_) {
      // ignore send errors
    } finally {
      await db.query(`UPDATE event_reminders SET fired = true WHERE id = $1`, [row.id]);
    }
  }
}

let reminderInterval;

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await db.initDb();
  console.log("Postgres DB initialized.");

  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(remindersTick, 15 * 1000);

  console.log("Schedulers started.");
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // Defer early to avoid "Application did not respond"
    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === "intel") {
      const sub = interaction.options.getSubcommand();
      if (sub === "checkin") {
        await db.query(
          `INSERT INTO checkins (guild_id, user_id, created_ts) VALUES ($1,$2,$3)`,
          [interaction.guildId, interaction.user.id, Date.now()]
        );
        await interaction.editReply("✅ Check-in saved.");
        return;
      }

      if (sub === "leaderboard") {
        const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const res = await db.query(
          `SELECT user_id, COUNT(*) as c
           FROM checkins
           WHERE guild_id = $1 AND created_ts >= $2
           GROUP BY user_id
           ORDER BY c DESC
           LIMIT 10`,
          [interaction.guildId, since]
        );

        if (!res.rowCount) {
          await interaction.editReply("No check-ins in the last 7 days.");
          return;
        }

        const lines = res.rows.map((r, i) => `${i + 1}. <@${r.user_id}> — **${r.c}**`);
        await interaction.editReply(`🏆 Check-in Leaderboard (7 days)\n${lines.join("\n")}`);
        return;
      }
    }

    if (interaction.commandName === "event") {
      const sub = interaction.options.getSubcommand(false);
      const group = interaction.options.getSubcommandGroup(false);

      // === RECURRING GROUP ===
      if (group === "recurring") {
        const rSub = interaction.options.getSubcommand();

        if (!isAdmin(interaction) && rSub !== "list") {
          await interaction.editReply("You need **Manage Server** permission to manage recurring templates.");
          return;
        }

        if (rSub === "create") {
          const result = await createTemplate(interaction);

          const channel = await interaction.guild.channels.fetch(result.channelId).catch(() => null);
          if (channel) {
            // post a summary to the channel (not ephemeral)
            const embed = new EmbedBuilder()
              .setTitle(`🔁 Recurring Template Created #${result.templateId}`)
              .setDescription(
                `**${result.name}**\n` +
                `TZ: **${result.tz}**\n` +
                `Time: **${result.time}**\n` +
                `Days: **${result.repeatDays.join(", ")}**\n` +
                `Weeks ahead: **${result.weeksAhead}**\n` +
                `Created events: **${result.createdEventIds.length}**`
              );
            await channel.send({ embeds: [embed] });
          }

          await interaction.editReply(`✅ Recurring template created (ID **${result.templateId}**). Created **${result.createdEventIds.length}** events.`);
          return;
        }

        if (rSub === "list") {
          const rows = await listTemplates(interaction.guildId);
          if (!rows.length) {
            await interaction.editReply("No recurring templates found.");
            return;
          }

          const lines = rows.map(r => {
            const days = Array.isArray(r.repeat_days) ? r.repeat_days.join(",") : String(r.repeat_days || "");
            return `#${r.id} — **${r.name}** | ${r.time_hhmm} ${r.tz} | [${days}] | weeks:${r.weeks_ahead} | ${r.is_enabled ? "✅" : "⛔"}`;
          });

          await interaction.editReply(lines.join("\n"));
          return;
        }

        if (rSub === "disable") {
          const templateId = interaction.options.getInteger("template_id", true);
          const ok = await disableTemplate(interaction.guildId, templateId);
          await interaction.editReply(ok ? `✅ Template #${templateId} disabled.` : `Template #${templateId} not found.`);
          return;
        }

        if (rSub === "extend") {
          const templateId = interaction.options.getInteger("template_id", true);
          const weeksAhead = interaction.options.getInteger("weeks_ahead", true);
          const created = await extendTemplate(interaction.guildId, templateId, weeksAhead);
          await interaction.editReply(`✅ Extended template #${templateId}. Created **${created.length}** new events.`);
          return;
        }

        if (rSub === "edit") {
          await interaction.editReply("Edit is not yet implemented in this paste. Tell me and I’ll add it next.");
          return;
        }
      }

      // === SINGLE EVENTS ===
      if (sub === "create") {
        const name = interaction.options.getString("name", true);
        const startRaw = interaction.options.getString("start", true);
        const tz = interaction.options.getString("time_zone") || "UTC";
        const notes = interaction.options.getString("notes") || null;

        const startTs = parseStartToUtcMillis({ startRaw, timeZone: tz });
        const channelId = EVENTS_CHANNEL_ID || interaction.channelId;

        const eventId = await createSingleEvent({
          guildId: interaction.guildId,
          channelId,
          name,
          startTs,
          notes,
          createdBy: interaction.user.id,
        });

        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (channel) await postEventCreated(channel, eventId, name, startTs, notes);

        await interaction.editReply(`✅ Event created with ID **${eventId}**.`);
        return;
      }

      if (sub === "list") {
        const rows = await listActiveEvents(interaction.guildId);
        if (!rows.length) {
          await interaction.editReply("No active events.");
          return;
        }
        const lines = rows.map(r => `#${r.id} — **${r.name}** — ${fmtStartBoth(Number(r.start_ts))}`);
        await interaction.editReply(lines.join("\n"));
        return;
      }

      if (sub === "status") {
        const eventId = interaction.options.getInteger("event_id", true);
        const res = await db.query(
          `SELECT id, name, start_ts, notes, is_active FROM events WHERE guild_id = $1 AND id = $2`,
          [interaction.guildId, eventId]
        );
        if (!res.rowCount) {
          await interaction.editReply("Event not found.");
          return;
        }
        const e = res.rows[0];
        await interaction.editReply(`Event #${e.id} — **${e.name}**\nStart: ${fmtStartBoth(Number(e.start_ts))}\nStatus: ${e.is_active ? "ACTIVE" : "ENDED"}`);
        return;
      }

      if (sub === "end") {
        if (!isAdmin(interaction)) {
          await interaction.editReply("You need **Manage Server** to end events.");
          return;
        }
        const eventId = interaction.options.getInteger("event_id", true);
        const ok = await endEvent(interaction.guildId, eventId);
        await interaction.editReply(ok ? `✅ Event #${eventId} ended.` : "Event not found or already ended.");
        return;
      }

      if (sub === "rsvp") {
        const eventId = interaction.options.getInteger("event_id", true);
        const choice = interaction.options.getString("choice", true);

        await db.query(
          `INSERT INTO rsvps (event_id, user_id, choice, created_ts)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (event_id, user_id)
           DO UPDATE SET choice = EXCLUDED.choice`,
          [eventId, interaction.user.id, choice, Date.now()]
        );

        await interaction.editReply(`✅ RSVP saved: **${choice}** for event #${eventId}.`);
        return;
      }

      if (sub === "edit") {
        if (!isAdmin(interaction)) {
          await interaction.editReply("You need **Manage Server** to edit events.");
          return;
        }
        const eventId = interaction.options.getInteger("event_id", true);
        const newName = interaction.options.getString("name");
        const startRaw = interaction.options.getString("start");
        const tz = interaction.options.getString("time_zone") || "UTC";
        const notes = interaction.options.getString("notes");

        const res = await db.query(
          `SELECT id, channel_id, name, start_ts, notes FROM events WHERE guild_id = $1 AND id = $2 AND is_active = true`,
          [interaction.guildId, eventId]
        );
        if (!res.rowCount) {
          await interaction.editReply("Active event not found.");
          return;
        }

        const current = res.rows[0];
        const startTs = startRaw ? parseStartToUtcMillis({ startRaw, timeZone: tz }) : Number(current.start_ts);

        await db.query(
          `UPDATE events SET name = $1, start_ts = $2, notes = $3 WHERE id = $4`,
          [
            newName ?? current.name,
            startTs,
            notes ?? current.notes,
            eventId,
          ]
        );

        await interaction.editReply(`✅ Event #${eventId} updated.`);
        return;
      }
    }

    await interaction.editReply("Command not handled.");
  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred) {
        await interaction.editReply(`⚠️ Error: ${String(err.message || err)}`);
      } else {
        await interaction.reply({ content: `⚠️ Error: ${String(err.message || err)}`, ephemeral: true });
      }
    } catch (_) {
      // ignore
    }
  }
});

client.login(DISCORD_TOKEN);
