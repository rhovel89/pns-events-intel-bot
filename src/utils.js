function toUnixSeconds(ms) {
  return Math.floor(ms / 1000);
}

function fmtDiscordTs(ms) {
  return `<t:${toUnixSeconds(ms)}:F> (<t:${toUnixSeconds(ms)}:R>)`;
}

function parseReminders(envVal) {
  const raw = (envVal || "60,15,5")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const mins = raw
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && n > 0);

  return [...new Set(mins)].sort((a, b) => b - a);
}

function safeTruncate(str, max = 900) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function parseDateTimeLocalMs(input) {
  // "YYYY-MM-DD HH:mm" interpreted in server local TZ
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;

  const [_, y, m, d, hh, mm] = match;
  const dt = new Date(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    0,
    0
  );
  return dt.getTime();
}

function parseDateTimeUtcMs(input) {
  // "YYYY-MM-DD HH:mm" interpreted as UTC
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;

  const [_, y, m, d, hh, mm] = match;
  return Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    0,
    0
  );
}

function nextResetUtcMs({ resetUtcHour, resetUtcMinute }) {
  const now = new Date();

  let candidate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    resetUtcHour,
    resetUtcMinute,
    0,
    0
  );

  if (candidate <= now.getTime()) {
    candidate = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      resetUtcHour,
      resetUtcMinute,
      0,
      0
    );
  }
  return candidate;
}

function fmtUtcDateTime(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function fmtStartBoth(ms) {
  return `**Your local time:** ${fmtDiscordTs(ms)}\n**UTC (game time):** ${fmtUtcDateTime(ms)}`;
}

module.exports = {
  fmtDiscordTs,
  parseReminders,
  safeTruncate,
  parseDateTimeLocalMs,
  parseDateTimeUtcMs,
  nextResetUtcMs,
  fmtUtcDateTime,
  fmtStartBoth
};
