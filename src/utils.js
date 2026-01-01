function safeTruncate(s, max = 1000) {
  if (!s) return "";
  const str = String(s);
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function parseReminders() {
  const raw = process.env.EVENT_REMINDERS;

  // Default reminders if env is missing/blank
  if (!raw || !raw.trim()) return [60, 15, 5];

  const arr = raw
    .split(",")
    .map(x => parseInt(x.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);

  return arr.length ? arr : [60, 15, 5];
}


// Discord timestamps auto-convert to viewer's local timezone.
// We show both the auto-local Discord timestamp and explicit UTC.
function fmtStartBoth(startTsMs) {
  const unix = Math.floor(Number(startTsMs) / 1000);
  const utc = new Date(Number(startTsMs)).toISOString().replace(".000Z", "Z");
  return `• Local: <t:${unix}:F>  (<t:${unix}:R>)\n• UTC (Game): \`${utc}\``;
}

function normalizeDowToken(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return null;
  if (["mon", "monday"].includes(x)) return "mon";
  if (["tue", "tues", "tuesday"].includes(x)) return "tue";
  if (["wed", "wednesday"].includes(x)) return "wed";
  if (["thu", "thur", "thurs", "thursday"].includes(x)) return "thu";
  if (["fri", "friday"].includes(x)) return "fri";
  if (["sat", "saturday"].includes(x)) return "sat";
  if (["sun", "sunday"].includes(x)) return "sun";
  return null;
}

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

  // canonical order
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return out;
}

function parseRepeatDays(daysStr) {
  const toks = String(daysStr || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const set = new Set();
  for (const t of toks) {
    const n = normalizeDowToken(t);
    if (n) set.add(n);
  }
  return [...set];
}

const DOW_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function dowToIndex(dow) {
  return DOW_ORDER.indexOf(dow);
}

function parseYYYYMMDD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

// Convert a wall-clock time in a timezone to UTC timestamp (ms).
// This uses Intl to compute offset by formatting the time in that TZ.
function zonedDateTimeToUtcMs({ y, mo, d, hh, mm, tz }) {
  const dateUtcGuess = new Date(Date.UTC(y, mo - 1, d, hh, mm, 0));

  // Format the UTC guess in the target timezone, then rebuild as if it were UTC.
  // Difference between guess and rebuilt yields offset.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = fmt.formatToParts(dateUtcGuess);
  const get = (type) => parts.find(p => p.type === type)?.value;

  const zy = Number(get("year"));
  const zmo = Number(get("month"));
  const zd = Number(get("day"));
  const zhh = Number(get("hour"));
  const zmm = Number(get("minute"));
  const zss = Number(get("second"));

  const rebuiltAsUtc = Date.UTC(zy, zmo - 1, zd, zhh, zmm, zss);
  const guessAsUtc = dateUtcGuess.getTime();
  const offsetMs = rebuiltAsUtc - guessAsUtc;

  // Apply offset to align desired wall-clock time in TZ to UTC.
  return Date.UTC(y, mo - 1, d, hh, mm, 0) - offsetMs;
}

// Parse start input used by /event create and /event edit
// Supported:
// - "utcreset"
// - "utc:YYYY-MM-DD HH:mm"
// - "utc:HH:mm" (today UTC)
// - "local:YYYY-MM-DD HH:mm" (uses server tz/env default)
// - "YYYY-MM-DD HH:mm" (assumed UTC unless tz provided)
function parseStartInput(input, { tzDefault = "UTC", resetUtcHour = 0, resetUtcMinute = 0 } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Start time is required." };

  if (raw.toLowerCase() === "utcreset") {
    // Next reset time in UTC
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth() + 1;
    const d = now.getUTCDate();
    const todayReset = Date.UTC(y, mo - 1, d, resetUtcHour, resetUtcMinute, 0);
    const startTs = todayReset <= Date.now() ? todayReset + 24 * 60 * 60 * 1000 : todayReset;
    return { ok: true, startTs };
  }

  // utc:YYYY-MM-DD HH:mm or utc:HH:mm
  if (raw.toLowerCase().startsWith("utc:")) {
    const rest = raw.slice(4).trim();
    const parts = rest.split(" ").filter(Boolean);
    if (parts.length === 1) {
      const hm = parseHHMM(parts[0]);
      if (!hm) return { ok: false, error: "Invalid utc:HH:mm format." };
      const now = new Date();
      const y = now.getUTCFullYear();
      const mo = now.getUTCMonth() + 1;
      const d = now.getUTCDate();
      const startTs = Date.UTC(y, mo - 1, d, hm.hh, hm.mm, 0);
      return { ok: true, startTs };
    }
    if (parts.length >= 2) {
      const dt = parseYYYYMMDD(parts[0]);
      const hm = parseHHMM(parts[1]);
      if (!dt || !hm) return { ok: false, error: "Invalid utc:YYYY-MM-DD HH:mm format." };
      const startTs = Date.UTC(dt.y, dt.mo - 1, dt.d, hm.hh, hm.mm, 0);
      return { ok: true, startTs };
    }
    return { ok: false, error: "Invalid utc: format." };
  }

  // local:YYYY-MM-DD HH:mm (uses tzDefault)
  if (raw.toLowerCase().startsWith("local:")) {
    const rest = raw.slice(6).trim();
    const parts = rest.split(" ").filter(Boolean);
    if (parts.length < 2) return { ok: false, error: "Invalid local:YYYY-MM-DD HH:mm format." };
    const dt = parseYYYYMMDD(parts[0]);
    const hm = parseHHMM(parts[1]);
    if (!dt || !hm) return { ok: false, error: "Invalid local:YYYY-MM-DD HH:mm format." };
    try {
      const startTs = zonedDateTimeToUtcMs({ ...dt, ...hm, tz: tzDefault });
      return { ok: true, startTs };
    } catch {
      return { ok: false, error: `Invalid timezone '${tzDefault}'.` };
    }
  }

  // Plain "YYYY-MM-DD HH:mm" -> assume UTC
  const parts = raw.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const dt = parseYYYYMMDD(parts[0]);
    const hm = parseHHMM(parts[1]);
    if (!dt || !hm) return { ok: false, error: "Invalid start format. Use utcreset or utc:YYYY-MM-DD HH:mm." };
    const startTs = Date.UTC(dt.y, dt.mo - 1, dt.d, hm.hh, hm.mm, 0);
    return { ok: true, startTs };
  }

  return { ok: false, error: "Invalid start format. Use utcreset or utc:YYYY-MM-DD HH:mm." };
}

module.exports = {
  safeTruncate,
  parseReminders,
  fmtStartBoth,
  parseRepeatDays,
  dowToIndex,
  parseYYYYMMDD,
  parseHHMM,
  zonedDateTimeToUtcMs,
  parseStartInput,
  normalizeRepeatDays,
};
