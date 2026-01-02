require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in environment.");
  process.exit(1);
}

const eventCmd = new SlashCommandBuilder()
  .setName("event")
  .setDescription("Create/manage events (UTC game time + reminders + recurring).")

  .addSubcommand(sc =>
    sc.setName("create")
      .setDescription("Create a single event. start: utcreset | utc:YYYY-MM-DD HH:mm | YYYY-MM-DD HH:mm")
      .addStringOption(o => o.setName("name").setDescription("Event name").setRequired(true))
      .addStringOption(o => o.setName("start").setDescription("utcreset OR utc:YYYY-MM-DD HH:mm OR YYYY-MM-DD HH:mm").setRequired(true))
      .addStringOption(o => o.setName("time_zone").setDescription("IANA zone for non-utc start (default UTC), e.g., America/Chicago").setRequired(false))
      .addStringOption(o => o.setName("notes").setDescription("Optional notes").setRequired(false))
  )
  .addSubcommand(sc => sc.setName("list").setDescription("List active events"))
  .addSubcommand(sc =>
    sc.setName("status")
      .setDescription("Show an event’s status")
      .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("rsvp")
      .setDescription("RSVP to an event")
      .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
      .addStringOption(o =>
        o.setName("choice")
          .setDescription("Your RSVP")
          .setRequired(true)
          .addChoices(
            { name: "Yes", value: "YES" },
            { name: "Maybe", value: "MAYBE" },
            { name: "No", value: "NO" }
          )
      )
  )
  .addSubcommand(sc =>
    sc.setName("end")
      .setDescription("End/close an event")
      .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("edit")
      .setDescription("Edit a single event occurrence")
      .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
      .addStringOption(o => o.setName("start").setDescription("utcreset | utc:YYYY-MM-DD HH:mm | YYYY-MM-DD HH:mm").setRequired(false))
      .addStringOption(o => o.setName("time_zone").setDescription("IANA zone for non-utc start (default UTC)").setRequired(false))
      .addStringOption(o => o.setName("notes").setDescription("Replace notes").setRequired(false))
  )

  .addSubcommandGroup(g =>
    g.setName("recurring")
      .setDescription("Recurring templates (days of week + weeks ahead)")
      .addSubcommand(sc =>
        sc.setName("create")
          .setDescription("Create a recurring template and generate occurrences")
          // REQUIRED first
          .addStringOption(o => o.setName("name").setDescription("Series name").setRequired(true))
          .addStringOption(o => o.setName("date").setDescription("Anchor date YYYY-MM-DD").setRequired(true))
          .addStringOption(o => o.setName("time").setDescription("Start time HH:MM (24h)").setRequired(true))
          .addStringOption(o => o.setName("repeat_days").setDescription("Comma days: mon,tue,wed,thu,fri,sat,sun (e.g., wed,sun)").setRequired(true))
          .addIntegerOption(o => o.setName("weeks_ahead").setDescription("How many weeks to generate (e.g., 4, 8)").setRequired(true))
          // OPTIONAL after
          .addStringOption(o => o.setName("time_zone").setDescription("IANA time zone (default UTC)").setRequired(false))
          .addStringOption(o => o.setName("notes").setDescription("Optional series notes").setRequired(false))
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
          .addStringOption(o => o.setName("time_zone").setDescription("IANA zone").setRequired(false))
          .addStringOption(o => o.setName("repeat_days").setDescription("Comma days: mon,wed,sun").setRequired(false))
          .addIntegerOption(o => o.setName("weeks_ahead").setDescription("Weeks ahead").setRequired(false))
          .addStringOption(o => o.setName("notes").setDescription("Replace notes").setRequired(false))
          .addBooleanOption(o => o.setName("apply_to_existing").setDescription("Update future occurrences already created").setRequired(false))
      )
      .addSubcommand(sc =>
        sc.setName("extend")
          .setDescription("Generate more occurrences for an existing template")
          .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
          .addIntegerOption(o => o.setName("weeks_ahead").setDescription("Generate up to this many weeks ahead").setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName("disable")
          .setDescription("Disable a recurring template")
          .addIntegerOption(o => o.setName("template_id").setDescription("Template ID").setRequired(true))
      )
  );

const intelCmd = new SlashCommandBuilder()
  .setName("intel")
  .setDescription("Alliance intel tools")
  .addSubcommand(sc => sc.setName("checkin").setDescription("Mark yourself active (quick check-in)"))
  .addSubcommand(sc => sc.setName("leaderboard").setDescription("Show check-in leaderboard (last 7 days)"));

const commands = [eventCmd, intelCmd].map(c => c.toJSON());
const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
