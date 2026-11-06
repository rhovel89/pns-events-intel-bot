"use strict";
// Run with: node tests/calendar-tests.js (after npm ci). No DB or Discord login.
const assert = require("node:assert/strict");
const { DateTime } = require("luxon");
const { createCalendar, calendarRange, validDay, parseIdentifier } = require("../src/calendar");

async function main() {
  const zone = "America/Chicago";
  const day = validDay("2026-11-06", zone);
  assert.equal(calendarRange("day", day).from.toFormat("yyyy-LL-dd"), "2026-11-06");
  assert.equal(calendarRange("week", day).from.toFormat("yyyy-LL-dd"), "2026-11-02");
  assert.equal(calendarRange("month", day).to.toFormat("yyyy-LL-dd"), "2026-12-01");
  console.log("PASS: date, Monday-start week, month and timezone math");
  assert.throws(() => validDay("2026-02-30", zone));
  assert.throws(() => validDay("2026-11-6", zone));
  assert.throws(() => parseIdentifier("713cal|someone|week|2026-11-06|prev"));
  console.log("PASS: invalid date and tampered control IDs rejected");

  const guild = "111111111111111111", anotherGuild = "999999999999999999";
  const user = "222222222222222222", anotherUser = "333333333333333333";
  const event = { id: 42, name: "Reservoir War", channel_id: "444444444444444444", notes: "Battle prep", mention: "none", recurring_template_id: null,
    start_ts: DateTime.fromISO("2026-11-06T19:00", { zone }).toMillis() };
  const queries = [];
  const pool = { query: async (sql, args) => {
    queries.push({ sql, args });
    assert.equal(args[0], guild, "Every event query MUST filter by invoking guild");
    assert.match(sql, /guild_id\s*=\s*\$1/);
    return { rows: sql.includes("AND id=$2") ? [event] : [event], rowCount: 1 };
  } };
  const ui = createCalendar({ pool, getGuildSettings: async () => ({ time_zone: zone }) });
  const view = await ui.renderCalendar(guild, user, "week", "2026-11-06");
  assert.match(view.embeds[0].data.description, /Reservoir War/);
  assert.match(view.embeds[0].data.description, /America\/Chicago/);
  assert.equal(view.components.length, 3);
  assert.equal(view.components[2].toJSON().components[0].options[0].value, "42");
  console.log("PASS: per-guild query, week calendar, event picker, timezone display");

  let rejected = null;
  await ui.handleComponent({
    customId: `713cal|${user}|week|2026-11-06|next`,
    guildId: guild, user: { id: anotherUser }, isButton: () => true,
    isStringSelectMenu: () => false,
    reply: async payload => { rejected = payload; }
  });
  assert.match(rejected.content, /belongs to another member/);
  console.log("PASS: calendar controls are owner-bound");

  let updated;
  await ui.handleComponent({
    customId: `713cal|${user}|week|2026-11-06|pick`,
    guildId: guild, user: { id: user }, isButton: () => false,
    isStringSelectMenu: () => true, values: ["42"],
    update: async payload => { updated = payload; }
  });
  assert.match(updated.embeds[0].data.title, /Reservoir War/);
  assert.match(updated.embeds[0].data.fields[0].value, /America\/Chicago/);
  assert.equal(queries.at(-1).args[1], 42);
  console.log("PASS: event details are read-only and guild-scoped");

  let moved;
  await ui.handleComponent({
    customId: `713cal|${user}|week|2026-11-06|next`, guildId: guild,
    user: { id: user }, isButton: () => true,
    isStringSelectMenu: () => false,
    update: async payload => { moved = payload; }
  });
  assert.match(moved.embeds[0].data.description, /Nov 9/);
  assert.ok(queries.length >= 3);
  console.log("PASS: interactive next-week navigation");
  console.log("RESULT: 6/6 calendar unit/integration-stub checks passed.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
