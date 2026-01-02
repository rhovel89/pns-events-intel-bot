require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in environment.");
  process.exit(1);
}

const mentionChoices = [
  { name: "none", value: "none" },
  { name: "@everyone", value: "everyone" },
  { name: "@here", value: "here" }
];

const commands = [
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Create/manage events (UTC game time + reminders + recurring)")

    // One-time event create
    .addSubcommand(sc =>
      sc.setName("create")
        .setDescription("Create a one-time event")
        // Required first
        .addStringOption(o => o.setName("name").setDescription("Event name").setRequired(true))
        .addStringOption(o => o.setName("start").setDescription("utcreset | utc:YYYY-MM-DD HH:mm | YYYY-MM-DD HH:mm").setRequired(true))
        // Optional after
        .addStringOption(o => o.setName("time_zone").setDescription("IANA zone for non-UTC start (default UTC)").setRequired(false))
        .addChannelOption(o => o.setName("channel").setDescription("Where to post reminders (default: current channel)").addChannelTypes(ChannelType.GuildText).setRequired(false))
        .addStringOption(o => o.setName("notes").setDescription("Optional notes").setRequired(false))
        .addStringOption(o => o.setName("mention").setDescription("Mention when reminders fire").setRequired(false).addChoices(...mentionChoices))
    )

    .addSubcommand(sc =>
      sc.setName("list")
        .setDescription("List active events")
    )

    .addSubcommand(sc =>
      sc.setName("end")
        .setDescription("End an active event")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
    )

    .addSubcommand(sc =>
      sc.setName("edit")
        .setDescription("Edit an event")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
        .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
        .addStringOption(o => o.setName("start").setDescription("utcreset | utc:YYYY-MM-DD HH:mm | YYYY-MM-DD HH:mm").setRequired(false))
        .addStringOption(o => o.setName("time_zone").setDescription("IANA zone for non-UTC start (default UTC)").setRequired(false))
        .addChannelOption(o => o.setName("channel").setDescription("New channel for reminders").addChannelTypes(ChannelType.GuildText).setRequired(false))
        .addStringOption(o => o.setName("notes").setDescription("Replace notes").setRequired(false))
        .addStringOption(o => o.setName("mention").setDescription("Change mention").setRequired(false).addChoices(...mentionChoices))
    )

    // Recurring (as a subcommand group)
    .addSubcommandGroup(g =>
      g.setName("recurring")
        .setDescription("Create/manage recurring event templates (bulk operations included)")

        .addSubcommand(sc =>
          sc.setName("create")
            .setDescription("Create a recurring template and generate occurrences")
            // Required first
            .addStringOption(o => o.setName("name").setDescription("Series name").setRequired(true))
            .addStringOption(o => o.setName("date").setDescription("Anchor date YYYY-MM-DD").setRequired(true))
            .addStringOption(o => o.setName("time").setDescription("Start time HH:MM (24h)").setRequired(true))
            .addStringOption(o => o.setName("repeat_days").setDescription("Comma days: mon,tue,wed,thu,fri,sat,sun").setRequired(true))
            .addIntegerOption(o => o.setName("weeks_ahead").setDescription("How many weeks to generate (e.g., 4, 8)").setRequired(true))
            // Optional after
            .addStringOption(o => o.setName("time_zone").setDescription("IANA zone (default UTC)").setRequired(false))
            .addChannelOption(o => o.setName("channel").setDescription("Where to post reminders (default: current channel)").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("notes").setDescription("Optional series notes").setRequired(false))
            .addStringOption(o => o.setName("mention").setDescription("Mention on reminders").setRequired(false).addChoices(...mentionChoices))
        )

        .addSubcommand(sc =>
          sc.setName("list")
            .setDescription("List recurring templates")
        )

        .addSubcommand(sc =>
          sc.setName("edit")
            .setDescription("Edit a recurring template")
            .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
            .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
            .addStringOption(o => o.setName("time").setDescription("HH:MM (24h)").setRequired(false))
            .addStringOption(o => o.setName("time_zone").setDescription("IANA zone (default UTC)").setRequired(false))
            .addStringOption(o => o.setName("repeat_days").setDescription("Comma days: mon,wed,sun").setRequired(false))
            .addIntegerOption(o => o.setName("weeks_ahead").setDescription("Weeks ahead policy").setRequired(false))
            .addChannelOption(o => o.setName("channel").setDescription("New channel").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("notes").setDescription("Replace notes").setRequired(false))
            .addStringOption(o => o.setName("mention").setDescription("Change mention").setRequired(false).addChoices(...mentionChoices))
            .addBooleanOption(o => o.setName("apply_future").setDescription("If true, purge future and regenerate with new settings").setRequired(false))
        )

        .addSubcommand(sc =>
          sc.setName("disable")
            .setDescription("Disable a recurring template (stops future generation)")
            .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
        )

        .addSubcommand(sc =>
          sc.setName("enable")
            .setDescription("Enable a recurring template")
            .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
        )

        // BULK delete template + occurrences/events
        .addSubcommand(sc =>
          sc.setName("delete")
            .setDescription("Bulk delete a template (and optionally its generated events)")
            .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
            .addStringOption(o =>
              o.setName("scope").setDescription("Delete scope").setRequired(true)
                .addChoices(
                  { name: "template only (stop future)", value: "template_only" },
                  { name: "template + future events", value: "future" },
                  { name: "template + ALL events", value: "all" }
                )
            )
            .addStringOption(o => o.setName("from").setDescription("For scope=future: YYYY-MM-DD (default now)").setRequired(false))
        )

        // BULK purge occurrences/events only, keep template
        .addSubcommand(sc =>
          sc.setName("purge")
            .setDescription("Bulk delete generated events but keep template (useful after edits)")
            .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
            .addStringOption(o =>
              o.setName("range").setDescription("Purge range").setRequired(true)
                .addChoices(
                  { name: "future only", value: "future" },
                  { name: "all", value: "all" }
                )
            )
            .addStringOption(o => o.setName("from").setDescription("For range=future: YYYY-MM-DD (default now)").setRequired(false))
        )
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("Slash commands registered successfully.");
  } catch (err) {
    console.error("Error registering commands:", err);
  }
})();
