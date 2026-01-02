const { DateTime } = require("luxon");

// ENV reminders like "60,15,5"
function parseRemindersEnv(defaultArr = [60, 15, 5]) {
  const raw = process.env.EVENT_REMINDERS;
  if (!raw || !raw.trim()) return [...defaultArr];

  const arr = raw
    .split(",")
    .map(x => parseInt(x.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);

  return arr.length ? arr : [...defaultArr];
}

function safeTruncate(s, max = 900) {
  if (!s) return s;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Reset in UTC (game time). Default 00:00 UTC unless env overrides.
function nextUtcResetTs(now = Date.now()) {
  const hour = parseInt(process.env.RESET_UTC_HOUR ?? "0", 10);
  const minute = parseInt(process.env.RESET_UTC_MINUTE ?? "0", 10);

  const dtNow = DateTime.fromMillis(now, { zone: "utc" });
  let reset = dtNow.set({ hour, minute, second: 0, millisecond: 0 });
  if (reset.toMillis() <= now) reset = reset.plus({ days: 1 });
  return reset.toMillis();
}

// Discord can render local time with <t:unix:F>. We also show explicit UTC text.
function fmtStartBoth(startTsMs) {
  const unix = Math.floor(startTsMs / 1000);
  const utc = DateTime.fromMillis(startTsMs, { zone: "utc" }).toFormat("yyyy-LL-dd HH:mm 'UTC'");
  return `<t:${unix}:F> • **${utc}**`;
}

// Accepted inputs:
// - "utcreset"
// - "utc:YYYY-MM-DD HH:mm"
// - "YYYY-MM-DD HH:mm" with optional IANA timeZone param
function parseStartToUtcMillis({ startRaw, timeZone = "UTC" }) {
  const s = String(startRaw || "").trim();
  if (!s) throw new Error("Missing start.");

  if (s.toLowerCase() === "utcreset") {
    return nextUtcResetTs(Date.now());
  }

  if (s.toLowerCase().startsWith("utc:")) {
    const raw = s.slice(4).trim();
    const dt = DateTime.fromFormat(raw, "yyyy-LL-dd HH:mm", { zone: "utc" });
    if (!dt.isValid) throw new Error("Invalid utc: format. Use utc:YYYY-MM-DD HH:mm");
    return dt.toMillis();
  }

  const dt = DateTime.fromFormat(s, "yyyy-LL-dd HH:mm", { zone: timeZone || "UTC" });
  if (!dt.isValid) throw new Error("Invalid date/time. Use YYYY-MM-DD HH:mm");
  return dt.toUTC().toMillis();
}

// "wed,sun" => ["wed","sun"] in canonical order
function normalizeRepeatDays(input) {
  const map = {
    mon: "mon", monday: "mon",
    tue: "tue", tues: "tue", tuesday: "tue",
    wed: "wed", wednesday: "wed",
    thu: "thu", thur: "thu", thurs: "thu", thursday: "thu",
    fri: "fri", friday: "fri",
    sat: "sat", saturday: "sat",
    sun: "sun", sunday: "sun",
  };

  const raw = String(input || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .split(",")
    .filter(Boolean);

  const out = [];
  for (const token of raw) {
    const v = map[token];
    if (v && !out.includes(v)) out.push(v);
  }

  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return out;
}

// Parse "HH:MM" 24h
function parseHHMM(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || "").trim());
  if (!m) throw new Error("Time must be HH:MM (24-hour).");
  return `${m[1]}:${m[2]}`;
}

// Generate next N weeks of occurrences for repeat days at time in tz, anchored by a date
function generateOccurrences({ anchorDate, timeHHMM, tz, repeatDays, weeksAhead }) {
  const [hh, mm] = timeHHMM.split(":").map(n => parseInt(n, 10));
  const anchor = DateTime.fromFormat(anchorDate, "yyyy-LL-dd", { zone: tz });
  if (!anchor.isValid) throw new Error("Anchor date must be YYYY-MM-DD.");

  const end = anchor.plus({ weeks: weeksAhead }).endOf("day");
  const dayIndex = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

  const targets = repeatDays.map(d => dayIndex[d]).filter(Boolean);
  if (!targets.length) throw new Error("repeat_days must include at least one valid day (mon..sun).");

  // start from anchor day 00:00 in tz
  let cursor = anchor.startOf("day");
  const out = [];

  while (cursor <= end) {
    if (targets.includes(cursor.weekday)) {
      const local = cursor.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
      out.push(local.toUTC().toMillis());
    }
    cursor = cursor.plus({ days: 1 });
  }

  // sort ascending
  out.sort((a, b) => a - b);
  return out;
}

module.exports = {
  parseRemindersEnv,
  safeTruncate,
  nextUtcResetTs,
  fmtStartBoth,
  parseStartToUtcMillis,
  normalizeRepeatDays,
  parseHHMM,
  generateOccurrences,
};
