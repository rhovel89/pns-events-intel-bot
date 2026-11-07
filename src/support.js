"use strict";
// VOLUNTARY_SUPPORT_V1. Read-only, no payment processing or database writes.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const DONATION_URL = "https://ko-fi.com/sleepyswallow";

function supportMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x91eb42)
    .setTitle("🧟💚 Help Keep SleepySwallow Alive!")
    .setDescription([
      "Our sleepy zombie bird keeps your alliance organized and ready for battle!",
      "",
      "Voluntary tips help support hosting, maintenance, and future improvements.",
      "**Every command and feature remains free for everyone.**",
      "Donating is never required, and does not change access or permissions.",
      "",
      "Thank you for supporting 713 Event Reminders! 💜"
    ].join("\n"))
    .setFooter({ text: "No payments are collected through Discord or the bot." });
  const button = new ButtonBuilder()
    .setLabel("💚 Support SleepySwallow")
    .setStyle(ButtonStyle.Link)
    .setURL(DONATION_URL);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { parse: [] }
  };
}
module.exports = { supportMessage, DONATION_URL };
