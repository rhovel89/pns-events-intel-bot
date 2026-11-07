"use strict";
const assert = require("node:assert/strict");
const { supportMessage, DONATION_URL } = require("../src/support");
const { SlashCommandBuilder } = require("discord.js");

assert.equal(DONATION_URL, "https://ko-fi.com/sleepyswallow");
console.log("PASS: Donation link is user-approved Ko-fi URL");
const message = supportMessage();
assert.equal(message.embeds.length, 1);
assert.match(message.embeds[0].data.description, /Every command and feature remains free/);
assert.match(message.embeds[0].data.description, /Donating is never required/);
console.log("PASS: Clear voluntary donation and free-feature disclosures");
const buttons = message.components[0].toJSON().components;
assert.equal(buttons.length, 1);
assert.equal(buttons[0].style, 5); // Discord ButtonStyle.Link
assert.equal(buttons[0].url, DONATION_URL);
assert.ok(!buttons[0].custom_id);
console.log("PASS: Link button opens external Ko-fi page without bot interaction");
assert.deepEqual(message.allowedMentions, {parse: []});
console.log("PASS: No unexpected mentions");
const fs = require("node:fs");
const code = fs.readFileSync("src/index.js", "utf8");
const register = fs.readFileSync("src/register-commands.js", "utf8");
assert.match(code, /if \(sub === "support"\)[\s\S]*?interaction\.reply\(\{ \.\.\.supportMessage\(\), ephemeral: true \}\)/);
assert.match(register, /sc\.setName\("support"\)/);
console.log("PASS: Private support command handler and slash command are wired");
console.log("RESULT: 5/5 support checks passed.");
