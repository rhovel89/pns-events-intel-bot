"use strict";
// Inclusive local anchor date. Monday-start ISO weeks; alternates every N weeks.
const { DateTime } = require("luxon");
const { dayToLuxonWeekday } = require("./utils");

function anchorDay(raw, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw || ""))) throw new Error("Anchor date must be YYYY-MM-DD.");
  const date = DateTime.fromISO(raw, { zone });
  if (!date.isValid || date.toFormat("yyyy-LL-dd") !== raw) throw new Error("Invalid anchor date.");
  return date.startOf("day");
}

function recurrenceMatches(day, anchor, repeatDays, intervalWeeks = 1) {
  if (!DateTime.isDateTime(day) || !DateTime.isDateTime(anchor) || !day.isValid || !anchor.isValid)
    throw new Error("Invalid recurrence dates.");
  if (![1, 2].includes(Number(intervalWeeks))) throw new Error("Interval must be 1 or 2 weeks.");
  const d = day.startOf("day");
  const a = anchor.setZone(d.zoneName, { keepLocalTime: true }).startOf("day");
  if (d < a) return false;
  if (!repeatDays.some(x => dayToLuxonWeekday(x) === d.weekday)) return false;
  const weeks = Math.round(d.startOf("week").diff(a.startOf("week"), "days").days / 7);
  return weeks >= 0 && weeks % Number(intervalWeeks) === 0;
}

module.exports = { anchorDay, recurrenceMatches };
