require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");
const { addChoiceOptions } = require("./reminder-options");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
// GUILD preserves existing single-server behavior. GLOBAL enables multi-server commands.
const commandScope = (process.env.COMMAND_SCOPE || "GUILD").toUpperCase();
if (!["GUILD", "GLOBAL"].includes(commandScope)) throw new Error("Invalid COMMAND_SCOPE");

if (!token || !clientId || (commandScope === "GUILD" && !guildId)) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID or required GUILD_ID.");
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

    // CALENDAR_V1: read-only calendar, available to all server members.
    .addSubcommand(sc =>
      sc.setName("calendar")
        .setDescription("View your alliance event calendar with interactive navigation")
        .addStringOption(o => o.setName("view").setDescription("Day, week or month (default week)")
          .addChoices(
            { name: "Day", value: "day" },
            { name: "Week", value: "week" },
            { name: "Month", value: "month" }
          ))
        .addStringOption(o => o.setName("date").setDescription("Optional YYYY-MM-DD; defaults to today"))
    )

    // VOLUNTARY_SUPPORT_V1: private support link, available to every member.
    .addSubcommand(sc => sc.setName("support")
      .setDescription("Optional donation link — every bot feature stays free"))

    // WEEKLY_SUPPORT_V1: administrator-enabled channel post, disabled by default.
    .addSubcommand(sc => sc.setName("support-reminders")
      .setDescription("Manage optional weekly support announcements for this server")
      .addStringOption(o => o.setName("action")
        .setDescription("View, enable or disable weekly announcements")
        .setRequired(true)
        .addChoices(
          { name: "Status", value: "status" },
          { name: "Enable", value: "enable" },
          { name: "Disable", value: "disable" }
        ))
      .addChannelOption(o => o.setName("channel")
        .setDescription("Required when enabling; weekly announcements go here")
        .addChannelTypes(ChannelType.GuildText)))

    // ADMIN_DASHBOARD_V1: ephemeral administrator overview and read-only buttons.
    .addSubcommand(sc =>
      sc.setName("dashboard")
        .setDescription("Private alliance admin overview, events and reminder status")
    )

    .addSubcommand(sc =>
      sc.setName("help")
        .setDescription("How to configure this alliance and schedule events")
    )

    .addSubcommand(sc =>
      sc.setName("setup")
        .setDescription("View or set this server's default time zone and reminder channel")
        .addStringOption(o => o.setName("time_zone").setDescription("IANA zone, e.g. America/Chicago or UTC"))
        .addChannelOption(o => o.setName("channel").setDescription("Default reminder channel").addChannelTypes(ChannelType.GuildText))
    )

    // Standalone, alliance-scoped reminders (not associated with event calendar).
    .addSubcommandGroup(g => g.setName("reminder")
      .setDescription("Standalone alliance reminders")
      .addSubcommand(sc => addChoiceOptions(sc.setName("create")
        .setDescription("Send now, in 5 minutes, or at a chosen date/time")
        .addStringOption(o=>o.setName("message").setDescription("Reminder text (1-1500 characters)").setRequired(true))
        .addStringOption(o=>o.setName("when").setDescription("Delivery timing").setRequired(true)
          .addChoices({name:"Immediately",value:"now"}, {name:"In 5 minutes",value:"in5"}, {name:"At date and time",value:"at"}))
        .addStringOption(o=>o.setName("date").setDescription("For at: YYYY-MM-DD"))
        .addStringOption(o=>o.setName("time").setDescription("For at: HH:mm (24-hour)"))
        .addChannelOption(o=>o.setName("channel").setDescription("Target text channel").addChannelTypes(ChannelType.GuildText))))
      .addSubcommand(sc=>addChoiceOptions(sc.setName("edit")
        .setDescription("Edit unsent standalone reminder deliveries")
        .addIntegerOption(o=>o.setName("reminder_id").setDescription("Reminder ID").setRequired(true))
        .addStringOption(o=>o.setName("message").setDescription("Replacement reminder text"))
        .addStringOption(o=>o.setName("when").setDescription("Change delivery time")
          .addChoices({name:"Immediately",value:"now"},{name:"In 5 minutes",value:"in5"},{name:"At date and time",value:"at"}))
        .addStringOption(o=>o.setName("date").setDescription("For at: YYYY-MM-DD"))
        .addStringOption(o=>o.setName("time").setDescription("For at: HH:mm"))))
      .addSubcommand(sc=>sc.setName("list").setDescription("List this alliance's upcoming standalone reminders"))
      .addSubcommand(sc=>sc.setName("cancel").setDescription("Cancel a standalone reminder")
        .addIntegerOption(o=>o.setName("reminder_id").setDescription("Reminder ID").setRequired(true))))

    .addSubcommand(sc =>
      sc.setName("quick")
        .setDescription("Quick event: name, date, time; uses this server's defaults")
        .addStringOption(o => o.setName("name").setDescription("Event name").setRequired(true))
        .addStringOption(o => o.setName("date").setDescription("YYYY-MM-DD").setRequired(true))
        .addStringOption(o => o.setName("time").setDescription("HH:mm (24-hour) in server's time zone").setRequired(true))
        .addStringOption(o => o.setName("notes").setDescription("Optional notes"))
        .addBooleanOption(o=>o.setName("alert_60").setDescription("1 hour before"))
        .addBooleanOption(o=>o.setName("alert_45").setDescription("45 minutes before"))
        .addBooleanOption(o=>o.setName("alert_30").setDescription("30 minutes before"))
        .addBooleanOption(o=>o.setName("alert_15").setDescription("15 minutes before"))
        .addBooleanOption(o=>o.setName("alert_5").setDescription("5 minutes before"))
        .addBooleanOption(o=>o.setName("alert_at_time").setDescription("At event start"))
    )

    // One-time event create
    .addSubcommand(sc => addChoiceOptions(
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
    ))

    .addSubcommand(sc =>
      sc.setName("list")
        .setDescription("List active events")
    )

    .addSubcommand(sc =>
      sc.setName("end")
        .setDescription("End an active event")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
    )

    .addSubcommand(sc => addChoiceOptions(
      sc.setName("edit")
        .setDescription("Edit an event")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
        .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
        .addStringOption(o => o.setName("start").setDescription("utcreset | utc:YYYY-MM-DD HH:mm | YYYY-MM-DD HH:mm").setRequired(false))
        .addStringOption(o => o.setName("time_zone").setDescription("IANA zone for non-UTC start (default UTC)").setRequired(false))
        .addChannelOption(o => o.setName("channel").setDescription("New channel for reminders").addChannelTypes(ChannelType.GuildText).setRequired(false))
        .addStringOption(o => o.setName("notes").setDescription("Replace notes").setRequired(false))
        .addStringOption(o => o.setName("mention").setDescription("Change mention").setRequired(false).addChoices(...mentionChoices))
    ))

    // Recurring (as a subcommand group)
    .addSubcommandGroup(g =>
      g.setName("recurring")
        .setDescription("Create/manage recurring event templates (bulk operations included)")

        .addSubcommand(sc => addChoiceOptions(
          sc.setName("create")
            .setDescription("Create a recurring template and generate occurrences")
            // Required first
            .addStringOption(o => o.setName("name").setDescription("Series name").setRequired(true))
            .addStringOption(o => o.setName("date").setDescription("Anchor date YYYY-MM-DD").setRequired(true))
            .addStringOption(o => o.setName("time").setDescription("Start time HH:MM (24h)").setRequired(true))
            .addStringOption(o => o.setName("repeat_days").setDescription("Comma days: mon,tue,wed,thu,fri,sat,sun").setRequired(true))
            .addIntegerOption(o => o.setName("weeks_ahead").setDescription("How many weeks to generate (1–52)").setRequired(true).setMinValue(1).setMaxValue(52))
            // Optional after
            .addIntegerOption(o => o.setName("interval_weeks").setDescription("Repeat interval").addChoices(
              { name: "Every week", value: 1 }, { name: "Every other week", value: 2 }))
            .addStringOption(o => o.setName("time_zone").setDescription("IANA zone (default UTC)").setRequired(false))
            .addChannelOption(o => o.setName("channel").setDescription("Where to post reminders (default: current channel)").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("notes").setDescription("Optional series notes").setRequired(false))
            .addStringOption(o => o.setName("mention").setDescription("Mention on reminders").setRequired(false).addChoices(...mentionChoices))
        ))

        .addSubcommand(sc =>
          sc.setName("list")
            .setDescription("List recurring templates")
        )

        .addSubcommand(sc => addChoiceOptions(
          sc.setName("edit")
            .setDescription("Edit a recurring template")
            .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
            .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
            .addStringOption(o => o.setName("time").setDescription("HH:MM (24h)").setRequired(false))
            .addStringOption(o => o.setName("time_zone").setDescription("IANA zone (default UTC)").setRequired(false))
            .addStringOption(o => o.setName("repeat_days").setDescription("Comma days: mon,wed,sun").setRequired(false))
            .addIntegerOption(o => o.setName("weeks_ahead").setDescription("Weeks ahead policy").setRequired(false).setMinValue(1).setMaxValue(52))
            .addIntegerOption(o => o.setName("interval_weeks").setDescription("Every week or every other week").addChoices(
              { name: "Every week", value: 1 }, { name: "Every other week", value: 2 }))
            .addStringOption(o => o.setName("anchor_date").setDescription("YYYY-MM-DD: defines active alternating weeks"))
            .addChannelOption(o => o.setName("channel").setDescription("New channel").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("notes").setDescription("Replace notes").setRequired(false))
            .addStringOption(o => o.setName("mention").setDescription("Change mention").setRequired(false).addChoices(...mentionChoices))
            .addBooleanOption(o => o.setName("apply_future").setDescription("If true, purge future and regenerate with new settings").setRequired(false))
            .addStringOption(o => o.setName("confirm").setDescription("For apply_future: type APPLY <template_id>").setRequired(false))
        ))

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
            .addStringOption(o => o.setName("confirm").setDescription("Required: type DELETE <template_id>").setRequired(false))
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
            .addStringOption(o => o.setName("confirm").setDescription("Required: type PURGE <template_id>").setRequired(false))
        )
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Registering slash commands...");
    const route = commandScope === "GLOBAL"
      ? Routes.applicationCommands(clientId)
      : Routes.applicationGuildCommands(clientId, guildId);
    await rest.put(route, { body: commands });
    console.log(`${commandScope} slash commands registered successfully.`);
  } catch (err) {
    console.error("Error registering commands:", err);
  }
})();
