const { DateTime } = require("luxon");

// Env helpers
function parseReminders(remStr = process.env.EVENT_REMINDERS, fallbackArr = [60, 15, 5]) {
  const raw = (remStr ?? "").trim();
  if (!raw) return [...fallbackArr];
  return raw
    .split(",")
    .map(x => parseInt(x.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);
}

function safeTruncate(s, max = 900) {
  if (!s) return s;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Reset (game time) in UTC
function nextUtcResetTs(now = Date.now()) {
  const hour = parseInt(process.env.RESET_UTC_HOUR ?? "0", 10);
  const minute = parseInt(process.env.RESET_UTC_MINUTE ?? "0", 10);

  const dtNow = DateTime.fromMillis(now, { zone: "utc" });
  let reset = dtNow.set({ hour, minute, second: 0, millisecond: 0 });
  if (reset.toMillis() <= now) reset = reset.plus({ days: 1 });
  return reset.toMillis();
}

// Discord local + explicit UTC line
function fmtStartBoth(startTsMs) {
  const ms = Number(startTsMs);
  if (!Number.isFinite(ms)) return "**Invalid time**";

  const unix = Math.floor(ms / 1000);
  const utc = DateTime.fromMillis(ms, { zone: "utc" }).toFormat("yyyy-LL-dd HH:mm 'UTC'");
  return `<t:${unix}:F>  •  **${utc}**`;
}

// Parse start input for manual events
// Accepted:
// - "utcreset"
// - "utc:YYYY-MM-DD HH:mm"
// - "YYYY-MM-DD HH:mm" + optional timeZone param (IANA)
function parseStartToUtcMillis({ startRaw, timeZone = "UTC" }) {
  const s = (startRaw || "").trim();
  if (!s) throw new Error("Missing start time.");

  if (s.toLowerCase() === "utcreset") {
    return nextUtcResetTs(Date.now());
  }

  if (s.toLowerCase().startsWith("utc:")) {
    const rest = s.slice(4).trim(); // YYYY-MM-DD HH:mm
    const dt = DateTime.fromFormat(rest, "yyyy-LL-dd HH:mm", { zone: "utc" });
    if (!dt.isValid) throw new Error("Invalid utc: format. Use utc:YYYY-MM-DD HH:mm");
    return dt.toMillis();
  }

  // non-utc: interpret in given timeZone
  const tz = (timeZone || "UTC").trim() || "UTC";
  const dt = DateTime.fromFormat(s, "yyyy-LL-dd HH:mm", { zone: tz });
  if (!dt.isValid) throw new Error("Invalid start format. Use YYYY-MM-DD HH:mm (and optional time_zone).");
  return dt.toUTC().toMillis();
}

function normalizeMention(v) {
  const x = (v || "none").toLowerCase().trim();
  if (x === "everyone") return "everyone";
  if (x === "here") return "here";
  return "none";
}

function mentionText(v) {
  if (v === "everyone") return "@everyone ";
  if (v === "here") return "@here ";
  return "";
}

// repeat_days: "mon,wed,sun" -> ["mon","wed","sun"]
function normalizeRepeatDays(raw) {
  const map = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  const items = (raw || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  const out = [];
  for (const d of items) {
    const dd = d.slice(0, 3);
    if (map.has(dd) && !out.includes(dd)) out.push(dd);
  }
  if (!out.length) throw new Error("repeat_days must include at least one day (mon,tue,wed,thu,fri,sat,sun).");
  return out;
}

function dayToLuxonWeekday(d3) {
  // Luxon weekday: 1=Mon ... 7=Sun
  const m = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  return m[d3];
}

module.exports = {
  parseReminders,
  safeTruncate,
  nextUtcResetTs,
  fmtStartBoth,
  parseStartToUtcMillis,
  normalizeMention,
  mentionText,
  normalizeRepeatDays,
  dayToLuxonWeekday
};
