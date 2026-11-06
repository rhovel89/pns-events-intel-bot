"use strict";
const assert = require("node:assert/strict");
const { DateTime } = require("luxon");
const { anchorDay, recurrenceMatches } = require("../src/recurrence");
let passed = 0;
function check(name, fn) { fn(); console.log(`PASS: ${name}`); passed++; }
const zone = "America/Chicago", anchor = anchorDay("2026-11-04", zone);
const day = s => anchorDay(s, zone);
const match = (s, days, interval=2) => recurrenceMatches(day(s), anchor, days, interval);
check("Anchor weekday and before-anchor dates", () => {
  assert.equal(match("2026-11-02", ["mon"]), false);
  assert.equal(match("2026-11-04", ["wed"]), true);
});
check("Every other Wednesday alternates", () => {
  assert.equal(match("2026-11-11", ["wed"]), false);
  assert.equal(match("2026-11-18", ["wed"]), true);
  assert.equal(match("2026-11-25", ["wed"]), false);
});
check("Multiple selected weekdays share same on-week", () => {
  assert.equal(match("2026-11-06", ["wed", "fri"]), true);
  assert.equal(match("2026-11-13", ["wed", "fri"]), false);
  assert.equal(match("2026-11-20", ["wed", "fri"]), true);
});
check("Weekly legacy remains every week", () => {
  assert.equal(match("2026-11-11", ["wed"], 1), true);
  assert.equal(match("2026-11-18", ["wed"], 1), true);
});
check("Year boundary preserves parity", () => {
  const a = anchorDay("2026-12-30", zone);
  assert.equal(recurrenceMatches(day("2027-01-06"), a, ["wed"], 2), false);
  assert.equal(recurrenceMatches(day("2027-01-13"), a, ["wed"], 2), true);
});
check("Spring and fall DST preserve the alternating week", () => {
  const a = anchorDay("2026-02-23", zone);
  assert.equal(recurrenceMatches(day("2026-03-09"), a, ["mon"], 2), true);
  const b = anchorDay("2026-10-19", zone);
  assert.equal(recurrenceMatches(day("2026-11-02"), b, ["mon"], 2), true);
});
check("Leap day and date validation", () => {
  assert.equal(anchorDay("2028-02-29", zone).day, 29);
  assert.throws(() => anchorDay("2027-02-29", zone));
});
check("Invalid intervals rejected", () => {
  assert.throws(() => recurrenceMatches(day("2026-11-04"), anchor, ["wed"], 0));
  assert.throws(() => recurrenceMatches(day("2026-11-04"), anchor, ["wed"], 3));
});
console.log(`RESULT: ${passed}/8 recurrence checks passed.`);
