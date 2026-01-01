// Env helpers
function parseReminders() {
  const raw = process.env.EVENT_REMINDERS || "60,15,5";
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

// Formats: Discord auto-local + explicit UTC
function fmtStartBoth(startTsMs) {
  const unix = Math.floor(startTsMs / 1000);
  const utc = DateTime.fromMillis(startTsMs, { zone: "utc" }).toFormat("yyyy-LL-dd HH:mm 'UTC'");
  return `<t:${unix}:F>  •  **${utc}**`;
}

// Parse start input for manual events
// Accepted:
// - "utcreset"
// - "utc:YYYY-MM-DD HH:mm"
// - "YYYY-MM-DD HH:mm" + optional timeZone param (IANA)
function parseStartToUtcMillis({ startRaw, timeZone = "UTC" }) {
  const s = (startRaw || "").trim();

  if (!s) throw new Error("Start is required.");

  if (s.toLowerCase() === "utcreset") {
    return nextUtcResetTs();
  }

  if (s.toLowerCase().startsWith("utc:")) {
    const rest = s.slice(4).trim();
    const dt = DateTime.fromFormat(rest, "yyyy-LL-dd HH:mm", { zone: "utc" });
    if (!dt.isValid) throw new Error("Invalid UTC date/time. Use utc:YYYY-MM-DD HH:mm");
    return dt.toMillis();
  }

  // Interpret as local to provided timeZone (default UTC)
  const dt = DateTime.fromFormat(s, "yyyy-LL-dd HH:mm", { zone: timeZone || "UTC" });
  if (!dt.isValid) throw new Error("Invalid date/time. Use YYYY-MM-DD HH:mm (and a valid time zone).");
  return dt.toUTC().toMillis();
}

// Recurring helpers
function normalizeRepeatDays(input) {
  // expects comma-separated: mon,tue,wed,thu,fri,sat,sun
  const map = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7
  };
  const parts = (input || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  const nums = [];
  for (const p of parts) {
    const n = map[p];
    if (!n) throw new Error("repeat_days must be comma-separated like: mon,wed,sun");
    if (!nums.includes(n)) nums.push(n);
  }
  if (!nums.length) throw new Error("repeat_days is required (e.g., wed,sun).");

  nums.sort((a, b) => a - b);
  // store canonical text: mon,tue,...
  const inv = { 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 7: "sun" };
  return nums.map(n => inv[n]).join(",");
}

function parseHhmm(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((hhmm || "").trim());
  if (!m) throw new Error("time must be HH:MM (24h), e.g., 00:00 or 18:30");
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

function parseYmd(ymd) {
  const dt = DateTime.fromFormat((ymd || "").trim(), "yyyy-LL-dd", { zone: "utc" });
  if (!dt.isValid) throw new Error("date must be YYYY-MM-DD");
  return dt;
}

// Generate occurrence datetimes for template over N weeks starting from anchor date
function generateOccurrences({ anchorDateYmd, timeHhmm, timeZone, repeatDaysCsv, weeksAhead }) {
  const tz = timeZone || "UTC";
  const { hour, minute } = parseHhmm(timeHhmm);

  const repeatNums = normalizeRepeatDays(repeatDaysCsv)
    .split(",")
    .map(d => ({ mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }[d]));

  // anchor date in template tz (use date only)
  const anchorUtc = parseYmd(anchorDateYmd); // as date marker; we’ll rebuild in tz
  const anchorInTz = DateTime.fromObject(
    { year: anchorUtc.year, month: anchorUtc.month, day: anchorUtc.day, hour: 0, minute: 0 },
    { zone: tz }
  );

  const end = anchorInTz.plus({ weeks: weeksAhead });

  const occurrences = [];
  // Iterate day-by-day (simple, reliable)
  for (let d = anchorInTz; d < end; d = d.plus({ days: 1 })) {
    if (!repeatNums.includes(d.weekday)) continue;

    const startLocal = d.set({ hour, minute, second: 0, millisecond: 0 });
    const startUtcMs = startLocal.toUTC().toMillis();

    occurrences.push({
      occurrenceDate: startLocal.toFormat("yyyy-LL-dd"), // date in template tz
      startUtcMs
    });
  }

  return occurrences;
}

module.exports = {
  parseReminders,
  safeTruncate,
  nextUtcResetTs,
  fmtStartBoth,
  parseStartToUtcMillis,
  normalizeRepeatDays,
  parseHhmm,
  generateOccurrences
};
