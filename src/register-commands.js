require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in environment.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Event tools (multi-event, UTC-aligned)")
    .addSubcommand(sc =>
      sc.setName("create")
        .setDescription("Create an event (start: utcreset or utc:YYYY-MM-DD HH:mm)")
        .addStringOption(o => o.setName("name").setDescription("Event name").setRequired(true))
        .addStringOption(o => o.setName("start").setDescription("utcreset OR utc:YYYY-MM-DD HH:mm OR local YYYY-MM-DD HH:mm").setRequired(true))
        .addStringOption(o => o.setName("notes").setDescription("Optional notes / prep reminders").setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName("list")
        .setDescription("List active events")
    )
    .addSubcommand(sc =>
      sc.setName("status")
        .setDescription("Show event status")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("rsvp")
        .setDescription("RSVP to an event by ID")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
        .addStringOption(o =>
          o.setName("choice")
            .setDescription("Your RSVP")
            .setRequired(true)
            .addChoices(
              { name: "Yes", value: "YES" },
              { name: "No", value: "NO" },
              { name: "Maybe", value: "MAYBE" }
            )
        )
    )
    .addSubcommand(sc =>
      sc.setName("end")
        .setDescription("End/close an event by ID")
        .addIntegerOption(o => o.setName("event_id").setDescription("Event ID").setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName("intel")
    .setDescription("Alliance intelligence tools")
    .addSubcommand(sc =>
      sc.setName("checkin")
        .setDescription("Mark yourself active (quick check-in)")
    )
    .addSubcommand(sc =>
      sc.setName("leaderboard")
        .setDescription("Show check-in leaderboard (last 7 days)")
    ),

  new SlashCommandBuilder()
    .setName("inactive")
    .setDescription("Inactivity checks based on check-ins")
    .addSubcommand(sc =>
      sc.setName("check")
        .setDescription("List members without a check-in within X days")
        .addIntegerOption(o => o.setName("days").setDescription("Days since last check-in (default 7)").setRequired(false))
    )
].map(c => c.toJSON());

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
