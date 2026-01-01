require("dotenv").config();

const cron = require("node-cron");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder
} = require("discord.js");

const { query, initDb } = require("./db");
const {
  parseReminders,
  safeTruncate,
  fmtStartBoth,
  parseStartToUtcMillis,
  normalizeRepeatDays,
  generateOccurrences
} = require("./utils");

// Required env
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN.");
  process.exit(1);
}

// Optional env
const EVENTS_CHANNEL_ID = process.env.EVENTS_CHANNEL_ID || "";
const INTEL_CHANNEL_ID = process.env.INTEL_CHANNEL_ID || "";

const REMINDERS = parseReminders();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

// ---------------- DB Helpers (Postgres) ----------------

async function createEventRow({ guildId, channelId, templateId, occurrenceDate, name, startTs, notes, createdBy }) {
  const createdTs = Date.now();
  const ins = await query(
    `INSERT INTO events (guild_id, channel_id, template_id, occurrence_date, name, start_ts, notes, created_by, status, created_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)
     RETURNING *;`,
    [
      guildId,
      channelId,
      templateId ? String(templateId) : null,
      occurrenceDate || null,
      name,
      String(startTs),
      notes || null,
      createdBy,
      String(createdTs)
    ]
  );
  return ins.rows[0];
}

async function setEventMessageId(eventId, messageId) {
  await query(`UPDATE events SET message_id = $1 WHERE id = $2;`, [messageId, String(eventId)]);
}

async function getEventById(eventId) {
  const res = await query(`SELECT * FROM events WHERE id = $1;`, [String(eventId)]);
  return res.rows[0] || null;
}

async function listActiveEvents(guildId, limit = 15) {
  const res = await query(
    `SELECT * FROM events
     WHERE guild_id = $1 AND status = 'ACTIVE'
     ORDER BY start_ts ASC
     LIMIT $2;`,
    [guildId, limit]
  );
  return res.rows;
}

async function updateEventFields(eventId, patch) {
  const fields = [];
  const values = [];
  let i = 1;

  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (!fields.length) return;

  values.push(String(eventId));
  await query(`UPDATE events SET ${fields.join(", ")} WHERE id = $${i};`, values);
}

async function endEvent(guildId, eventId) {
  const res = await query(`SELECT * FROM events WHERE id = $1 AND guild_id = $2;`, [String(eventId), guildId]);
  if (!res.rows[0]) return { ok: false };
  await query(`UPDATE events SET status = 'ENDED' WHERE id = $1;`, [String(eventId)]);
  return { ok: true, row: res.rows[0] };
}

async function upsertRsvp(eventId, userId, choice) {
  await query(
    `INSERT INTO rsvps (event_id, user_id, choice, updated_ts)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (event_id, user_id) DO UPDATE SET
       choice = EXCLUDED.choice,
       updated_ts = EXCLUDED.updated_ts;`,
    [String(eventId), userId, choice, String(Date.now())]
  );
}

async function getRsvpCounts(eventId) {
  const res = await query(
    `SELECT choice, COUNT(*)::int AS count
     FROM rsvps
     WHERE event_id = $1
     GROUP BY choice;`,
    [String(eventId)]
  );
  const counts = { YES: 0, NO: 0, MAYBE: 0 };
  for (const r of res.rows) counts[r.choice] = r.count;
  return counts;
}

async function getRsvpLists(eventId) {
  const res = await query(
    `SELECT user_id, choice
     FROM rsvps
     WHERE event_id = $1;`,
    [String(eventId)]
  );
  const lists = { YES: [], NO: [], MAYBE: [] };
  for (const r of res.rows) lists[r.choice]?.push(r.user_id);
  return lists;
}

async function insertRemindersForEvent(eventId, startTs) {
  for (const m of REMINDERS) {
    const remindTs = startTs - m * 60 * 1000;
    // skip reminders already in past
    if (remindTs <= Date.now() - 60 * 1000) continue;

    await query(
      `INSERT INTO event_reminders (event_id, minutes_before, remind_ts, sent_ts)
       VALUES ($1,$2,$3,NULL)
       ON CONFLICT (event_id, minutes_before) DO NOTHING;`,
      [String(eventId), m, String(remindTs)]
    );
  }
}

async function eventEmbed(eventRow) {
  const startMs = Number(eventRow.start_ts);
  const counts = await getRsvpCounts(eventRow.id);
  const lists = await getRsvpLists(eventRow.id);

  const lines = [];
  lines.push(`**Start**\n${fmtStartBoth(startMs)}`);

  if (eventRow.notes) lines.push(`**Notes:** ${safeTruncate(eventRow.notes, 900)}`);

  lines.push("");
  lines.push(`**RSVPs:** ✅ Yes ${counts.YES} | ❔ Maybe ${counts.MAYBE} | ❌ No ${counts.NO}`);
  lines.push("");
  lines.push(`**Yes:** ${lists.YES.length ? lists.YES.map(id => `<@${id}>`).join(", ") : "—"}`);
  lines.push(`**Maybe:** ${lists.MAYBE.length ? lists.MAYBE.map(id => `<@${id}>`).join(", ") : "—"}`);
  lines.push(`**No:** ${lists.NO.length ? lists.NO.map(id => `<@${id}>`).join(", ") : "—"}`);

  if (eventRow.template_id) {
    lines.push("");
    lines.push(`**Series:** Template #${eventRow.template_id}`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`Event #${eventRow.id}: ${eventRow.name}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Status: ${eventRow.status}` })
    .setTimestamp(new Date(Number(eventRow.created_ts)));

  return embed;
}

async function resolvePostingChannel(interaction, guildId) {
  // If EVENTS_CHANNEL_ID is set, force posts there.
  if (EVENTS_CHANNEL_ID) {
    const ch = await client.channels.fetch(EVENTS_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) return ch;
  }
  // fallback to channel command invoked in
  return interaction.channel;
}

async function postOrUpdateEventMessage(eventRow, channel) {
  if (!channel || !channel.isTextBased()) return;

  // If we have a message id, try to edit
  if (eventRow.message_id) {
    const msg = await channel.messages.fetch(eventRow.message_id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [await eventEmbed(eventRow)] }).catch(() => null);
      return;
    }
  }

  // else create
  const msg = await channel.send({ embeds: [await eventEmbed(eventRow)] }).catch(() => null);
  if (msg) {
    await setEventMessageId(eventRow.id, msg.id);
  }
}

async function updateEventMessage(eventId) {
  const row = await getEventById(eventId);
  if (!row) return;

  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  await postOrUpdateEventMessage(row, channel);
}

// ---------------- Recurring Templates ----------------

async function createTemplate({ guildId, name, dateYmd, timeHhmm, timeZone, repeatDays, weeksAhead, notes, createdBy }) {
  const createdTs = Date.now();

  const ins = await query(
    `INSERT INTO recurring_templates
      (guild_id, name, time_hhmm, time_zone, repeat_days, weeks_ahead, notes, created_by, active, created_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)
     RETURNING *;`,
    [
      guildId,
      name,
      timeHhmm,
      (timeZone || "UTC").trim(),
      normalizeRepeatDays(repeatDays),
      weeksAhead,
      notes || null,
      createdBy,
      String(createdTs)
    ]
  );

  // We keep the anchor date as the first generation anchor (not stored). We generate immediately using dateYmd.
  const template = ins.rows[0];
  template._anchorDateYmd = dateYmd;

  return template;
}

async function getTemplate(guildId, templateId) {
  const res = await query(
    `SELECT * FROM recurring_templates WHERE id = $1 AND guild_id = $2;`,
    [String(templateId), guildId]
  );
  return res.rows[0] || null;
}

async function listTemplates(guildId) {
  const res = await query(
    `SELECT * FROM recurring_templates
     WHERE guild_id = $1
     ORDER BY id DESC
     LIMIT 25;`,
    [guildId]
  );
  return res.rows;
}

async function disableTemplate(guildId, templateId) {
  await query(
    `UPDATE recurring_templates SET active = FALSE WHERE id = $1 AND guild_id = $2;`,
    [String(templateId), guildId]
  );
}

async function editTemplate(guildId, templateId, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (!fields.length) return;

  vals.push(String(templateId), guildId);
  await query(
    `UPDATE recurring_templates SET ${fields.join(", ")} WHERE id = $${i++} AND guild_id = $${i};`,
    vals
  );
}

async function generateFromTemplate({ guildId, template, anchorDateYmd, channelId, createdBy }) {
  const weeksAhead = Number(template.weeks_ahead);
  const occs = generateOccurrences({
    anchorDateYmd,
    timeHhmm: template.time_hhmm,
    timeZone: template.time_zone,
    repeatDaysCsv: template.repeat_days,
    weeksAhead
  });

  let created = 0;
  for (const occ of occs) {
    // Insert occurrence; unique index prevents duplicates
    try {
      const row = await createEventRow({
        guildId,
        channelId,
        templateId: template.id,
        occurrenceDate: occ.occurrenceDate,
        name: template.name,
        startTs: occ.startUtcMs,
        notes: template.notes,
        createdBy
      });
      await insertRemindersForEvent(row.id, Number(row.start_ts));
      created++;
    } catch (e) {
      // Duplicate insert due to unique constraint -> ignore
    }
  }

  return { created, total: occs.length };
}

async function applyTemplateToExistingFutureOccurrences(guildId, template, nowMs = Date.now()) {
  // Update future ACTIVE occurrences for this template: name/notes and recompute start_ts using occurrence_date + template time/tz
  const res = await query(
    `SELECT id, occurrence_date
     FROM events
     WHERE guild_id = $1
       AND template_id = $2
       AND status = 'ACTIVE'
       AND start_ts::bigint > $3
       AND occurrence_date IS NOT NULL;`,
    [guildId, String(template.id), String(nowMs)]
  );

  // Regenerate each event start_ts using its stored occurrence_date (date in template tz)
  // Use a one-week generation window trick: build from that date only.
  for (const r of res.rows) {
    const ymd = r.occurrence_date.toISOString().slice(0, 10); // YYYY-MM-DD
    const occs = generateOccurrences({
      anchorDateYmd: ymd,
      timeHhmm: template.time_hhmm,
      timeZone: template.time_zone,
      repeatDaysCsv: normalizeRepeatDays(template.repeat_days),
      weeksAhead: 1
    });

    // Find exact occurrence matching that date
    const occ = occs.find(x => x.occurrenceDate === ymd);
    if (!occ) continue;

    await updateEventFields(r.id, {
      name: template.name,
      notes: template.notes || null,
      start_ts: String(occ.startUtcMs)
    });

    // Rebuild reminders for that event (simple approach: delete + reinsert)
    await query(`DELETE FROM event_reminders WHERE event_id = $1;`, [String(r.id)]);
    await insertRemindersForEvent(r.id, occ.startUtcMs);

    await updateEventMessage(r.id);
  }
}

// ---------------- Reminders ----------------

async function scanAndSendReminders() {
  const now = Date.now();
  const windowStart = now - 30 * 1000;
  const windowEnd = now + 30 * 1000;

  const dueRes = await query(
    `SELECT er.event_id, er.minutes_before, er.remind_ts,
            e.channel_id, e.name, e.start_ts, e.status
     FROM event_reminders er
     JOIN events e ON e.id = er.event_id
     WHERE er.sent_ts IS NULL
       AND e.status = 'ACTIVE'
       AND er.remind_ts::bigint BETWEEN $1 AND $2
     ORDER BY er.remind_ts ASC
     LIMIT 25;`,
    [String(windowStart), String(windowEnd)]
  );

  for (const r of dueRes.rows) {
    const channel = await client.channels.fetch(r.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    const startTs = Number(r.start_ts);

    const embed = new EmbedBuilder()
      .setTitle(`Reminder: ${r.name} (Event #${r.event_id})`)
      .setDescription(
        `Starts in **${r.minutes_before} min**.\n\n**Start**\n${fmtStartBoth(startTs)}\n\nRSVP: \`/event rsvp event_id:${r.event_id}\``
      )
      .setTimestamp(new Date());

    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      await query(
        `UPDATE event_reminders
         SET sent_ts = $1
         WHERE event_id = $2 AND minutes_before = $3;`,
        [String(Date.now()), String(r.event_id), r.minutes_before]
      );
    }
  }
}

// Daily recurring “top-up” (keeps series healthy on Railway)
async function topUpRecurringTemplates() {
  // Simple policy: re-generate from "today" for weeks_ahead in template tz.
  // Since unique constraint prevents duplicates, this is safe.
  const guilds = client.guilds.cache.map(g => g.id);
  for (const guildId of guilds) {
    const tRes = await query(
      `SELECT * FROM recurring_templates WHERE guild_id = $1 AND active = TRUE;`,
      [guildId]
    );
    if (!tRes.rows.length) continue;

    // Use today (UTC date string) as anchor for top-up
    const todayUtc = new Date().toISOString().slice(0, 10);

    for (const t of tRes.rows) {
      const channelId = EVENTS_CHANNEL_ID || null;
      const channel = channelId
        ? await client.channels.fetch(channelId).catch(() => null)
        : null;

      // If no forced channel, we cannot safely post series to unknown channel; skip.
      // (You can remove this skip if you want it to default to command channel only.)
      if (!EVENTS_CHANNEL_ID || !channel || !channel.isTextBased()) continue;

      await generateFromTemplate({
        guildId,
        template: t,
        anchorDateYmd: todayUtc,
        channelId: channel.id,
        createdBy: t.created_by
      });
    }
  }
}

// ---------------- Command handlers ----------------

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "event") {
      const guildId = interaction.guildId;
      if (!guildId) return;

      // Recurring group?
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(true);

      // ---------- Recurring ----------
      if (group === "recurring") {
        if (sub === "create") {
          await interaction.deferReply({ ephemeral: true });

          const name = interaction.options.getString("name", true);
          const date = interaction.options.getString("date", true);
          const time = interaction.options.getString("time", true);
          const timeZone = interaction.options.getString("time_zone") || "UTC";
          const repeatDays = interaction.options.getString("repeat_days", true);
          const weeksAhead = interaction.options.getInteger("weeks_ahead", true);
          const notes = interaction.options.getString("notes") || null;

          const postChannel = await resolvePostingChannel(interaction, guildId);
          if (!postChannel || !postChannel.isTextBased()) {
            return interaction.editReply("I cannot post to the configured events channel. Check channel ID and permissions.");
          }

          const template = await createTemplate({
            guildId,
            name,
            dateYmd: date,
            timeHhmm: time,
            timeZone,
            repeatDays,
            weeksAhead,
            notes,
            createdBy: interaction.user.id
          });

          // Generate initial occurrences using the provided anchor date
          const { created, total } = await generateFromTemplate({
            guildId,
            template,
            anchorDateYmd: date,
            channelId: postChannel.id,
            createdBy: interaction.user.id
          });

          return interaction.editReply(
            `Recurring template **#${template.id}** created.\nGenerated **${created}** events (out of ${total} candidates) into ${postChannel}.`
          );
        }

        if (sub === "list") {
          await interaction.deferReply({ ephemeral: true });

          const rows = await listTemplates(guildId);
          if (!rows.length) return interaction.editReply("No recurring templates found.");

          const lines = rows.map(t => {
            const active = t.active ? "ACTIVE" : "DISABLED";
            return `**#${t.id}** • ${t.name} • ${t.repeat_days.toUpperCase()} @ ${t.time_hhmm} (${t.time_zone}) • weeks_ahead=${t.weeks_ahead} • ${active}`;
          });

          return interaction.editReply(lines.join("\n"));
        }

        if (sub === "disable") {
          await interaction.deferReply({ ephemeral: true });

          const templateId = interaction.options.getInteger("template_id", true);
          const t = await getTemplate(guildId, templateId);
          if (!t) return interaction.editReply("Template not found.");

          await disableTemplate(guildId, templateId);
          return interaction.editReply(`Template #${templateId} disabled.`);
        }

        if (sub === "extend") {
          await interaction.deferReply({ ephemeral: true });

          const templateId = interaction.options.getInteger("template_id", true);
          const weeksAhead = interaction.options.getInteger("weeks_ahead", true);

          const t = await getTemplate(guildId, templateId);
          if (!t) return interaction.editReply("Template not found.");

          await editTemplate(guildId, templateId, { weeks_ahead: weeksAhead });

          const postChannel = await resolvePostingChannel(interaction, guildId);
          if (!postChannel || !postChannel.isTextBased()) {
            return interaction.editReply("I cannot post to the configured events channel. Check channel ID and permissions.");
          }

          // Use today as anchor for extension generation
          const todayUtc = new Date().toISOString().slice(0, 10);

          const updated = await getTemplate(guildId, templateId);
          const { created } = await generateFromTemplate({
            guildId,
            template: updated,
            anchorDateYmd: todayUtc,
            channelId: postChannel.id,
            createdBy: interaction.user.id
          });

          return interaction.editReply(`Template #${templateId} updated to weeks_ahead=${weeksAhead}. Generated ${created} additional events.`);
        }

        if (sub === "edit") {
          await interaction.deferReply({ ephemeral: true });

          const templateId = interaction.options.getInteger("template_id", true);
          const t = await getTemplate(guildId, templateId);
          if (!t) return interaction.editReply("Template not found.");

          const patch = {};
          const name = interaction.options.getString("name");
          const time = interaction.options.getString("time");
          const timeZone = interaction.options.getString("time_zone");
          const repeatDays = interaction.options.getString("repeat_days");
          const weeksAhead = interaction.options.getInteger("weeks_ahead");
          const notes = interaction.options.getString("notes");
          const applyToExisting = interaction.options.getBoolean("apply_to_existing") || false;

          if (name) patch.name = name;
          if (time) patch.time_hhmm = time;
          if (timeZone) patch.time_zone = timeZone.trim();
          if (repeatDays) patch.repeat_days = normalizeRepeatDays(repeatDays);
          if (Number.isFinite(weeksAhead)) patch.weeks_ahead = weeksAhead;
          if (notes !== null) patch.notes = notes; // can set empty string if desired

          await editTemplate(guildId, templateId, patch);

          const updated = await getTemplate(guildId, templateId);

          // Optionally apply to already-created future occurrences
          if (applyToExisting) {
            await applyTemplateToExistingFutureOccurrences(guildId, updated);
          }

          return interaction.editReply(`Template #${templateId} updated.${applyToExisting ? " Applied to existing future occurrences." : ""}`);
        }

        return;
      }

      // ---------- Non-recurring ----------
      if (sub === "create") {
        await interaction.deferReply({ ephemeral: true });

        const name = interaction.options.getString("name", true);
        const startRaw = interaction.options.getString("start", true);
        const timeZone = interaction.options.getString("time_zone") || "UTC";
        const notes = interaction.options.getString("notes") || null;

        const startTs = parseStartToUtcMillis({ startRaw, timeZone });

        const postChannel = await resolvePostingChannel(interaction, guildId);
        if (!postChannel || !postChannel.isTextBased()) {
          return interaction.editReply("I cannot post to the configured events channel. Check channel ID and permissions.");
        }

        const row = await createEventRow({
          guildId,
          channelId: postChannel.id,
          templateId: null,
          occurrenceDate: null,
          name,
          startTs,
          notes,
          createdBy: interaction.user.id
        });

        await insertRemindersForEvent(row.id, startTs);
        await postOrUpdateEventMessage(row, postChannel);

        return interaction.editReply(`Created **Event #${row.id}** in ${postChannel}.`);
      }

      if (sub === "list") {
        await interaction.deferReply({ ephemeral: true });

        const rows = await listActiveEvents(guildId, 20);
        if (!rows.length) return interaction.editReply("No active events.");

        const lines = rows.map(r => `**#${r.id}** • ${r.name} • ${fmtStartBoth(Number(r.start_ts))}`);
        return interaction.editReply(lines.join("\n"));
      }

      if (sub === "status") {
        await interaction.deferReply({ ephemeral: true });

        const eventId = interaction.options.getInteger("event_id", true);
        const row = await getEventById(eventId);
        if (!row) return interaction.editReply("Event not found.");

        const embed = await eventEmbed(row);
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === "rsvp") {
        await interaction.deferReply({ ephemeral: true });

        const eventId = interaction.options.getInteger("event_id", true);
        const choice = interaction.options.getString("choice", true);

        const row = await getEventById(eventId);
        if (!row || row.status !== "ACTIVE") return interaction.editReply("Event not found or not active.");

        await upsertRsvp(eventId, interaction.user.id, choice);
        await updateEventMessage(eventId);

        return interaction.editReply(`RSVP saved for Event #${eventId}: **${choice}**`);
      }

      if (sub === "end") {
        await interaction.deferReply({ ephemeral: true });

        const eventId = interaction.options.getInteger("event_id", true);
        const res = await endEvent(guildId, eventId);
        if (!res.ok) return interaction.editReply("Event not found.");

        await updateEventMessage(eventId);
        return interaction.editReply(`Event #${eventId} ended.`);
      }

      if (sub === "edit") {
        await interaction.deferReply({ ephemeral: true });

        const eventId = interaction.options.getInteger("event_id", true);
        const row = await getEventById(eventId);
        if (!row) return interaction.editReply("Event not found.");

        const patch = {};
        const name = interaction.options.getString("name");
        const startRaw = interaction.options.getString("start");
        const timeZone = interaction.options.getString("time_zone") || "UTC";
        const notes = interaction.options.getString("notes");

        if (name) patch.name = name;
        if (notes !== null) patch.notes = notes;

        if (startRaw) {
          const startTs = parseStartToUtcMillis({ startRaw, timeZone });
          patch.start_ts = String(startTs);

          // rebuild reminders
          await query(`DELETE FROM event_reminders WHERE event_id = $1;`, [String(eventId)]);
          await insertRemindersForEvent(eventId, startTs);
        }

        await updateEventFields(eventId, patch);
        await updateEventMessage(eventId);

        return interaction.editReply(`Event #${eventId} updated.`);
      }
    }

    if (interaction.commandName === "intel") {
      const sub = interaction.options.getSubcommand(true);
      const guildId = interaction.guildId;
      if (!guildId) return;

      if (sub === "checkin") {
        await interaction.deferReply({ ephemeral: true });

        await query(`INSERT INTO checkins (guild_id, user_id, ts) VALUES ($1,$2,$3);`, [
          guildId,
          interaction.user.id,
          String(Date.now())
        ]);

        if (INTEL_CHANNEL_ID) {
          const ch = await client.channels.fetch(INTEL_CHANNEL_ID).catch(() => null);
          if (ch && ch.isTextBased()) {
            await ch.send(`✅ Check-in: <@${interaction.user.id}>`).catch(() => null);
          }
        }

        return interaction.editReply("Check-in recorded.");
      }

      if (sub === "leaderboard") {
        await interaction.deferReply({ ephemeral: true });

        const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const res = await query(
          `SELECT user_id, COUNT(*)::int AS cnt
           FROM checkins
           WHERE guild_id = $1 AND ts::bigint >= $2
           GROUP BY user_id
           ORDER BY cnt DESC
           LIMIT 20;`,
          [guildId, String(since)]
        );

        if (!res.rows.length) return interaction.editReply("No check-ins in the last 7 days.");

        const lines = res.rows.map((r, i) => `${i + 1}. <@${r.user_id}> — **${r.cnt}**`);
        return interaction.editReply(lines.join("\n"));
      }
    }

    if (interaction.commandName === "inactive") {
      const sub = interaction.options.getSubcommand(true);
      const guildId = interaction.guildId;
      if (!guildId) return;

      if (sub === "check") {
        await interaction.deferReply({ ephemeral: true });

        const days = interaction.options.getInteger("days") || 7;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        // Last check-in per user
        const res = await query(
          `SELECT user_id, MAX(ts)::bigint AS last_ts
           FROM checkins
           WHERE guild_id = $1
           GROUP BY user_id;`,
          [guildId]
        );

        const lastMap = new Map(res.rows.map(r => [r.user_id, Number(r.last_ts)]));

        // Compare against guild members
        const guild = interaction.guild;
        await guild.members.fetch().catch(() => null);

        const inactive = [];
        for (const [, m] of guild.members.cache) {
          if (m.user.bot) continue;
          const last = lastMap.get(m.id);
          if (!last || last < cutoff) inactive.push(m.id);
        }

        if (!inactive.length) return interaction.editReply(`No members are inactive by check-ins (>${days} days).`);

        const list = inactive.slice(0, 40).map(id => `<@${id}>`).join(", ");
        const more = inactive.length > 40 ? `\n…and ${inactive.length - 40} more.` : "";
        return interaction.editReply(`Inactive (no check-in within **${days}** days):\n${list}${more}`);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("An error occurred while processing that command. Check logs.").catch(() => null);
    } else {
      await interaction.reply({ content: "An error occurred while processing that command. Check logs.", ephemeral: true }).catch(() => null);
    }
  }
});

// ---------------- Startup / Cron ----------------

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDb();

  // Scan reminders every minute
  cron.schedule("*/1 * * * *", async () => {
    await scanAndSendReminders().catch(() => null);
  });

  // Top-up recurring templates daily at 00:05 UTC (requires EVENTS_CHANNEL_ID to be set)
  cron.schedule("5 0 * * *", async () => {
    await topUpRecurringTemplates().catch(() => null);
  }, { timezone: "UTC" });

  console.log("Schedulers started.");
});

client.login(TOKEN);
