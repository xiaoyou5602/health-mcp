// Firmware nightly summaries, never represented as RMSSD time-series measurements.
const SOURCE = "huawei_sleep_statistics";

function normalizeSleepHrv(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.source !== SOURCE) return null;
  const timestamp = (value) => typeof value === "string" && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  if (![raw.sleep_start, raw.sleep_end, raw.captured_at].every(timestamp)) return null;
  const start = Date.parse(raw.sleep_start), end = Date.parse(raw.sleep_end);
  if (end <= start || end - start > 2 * 86400000 || Date.parse(raw.captured_at) < end) return null;
  const validMs = (value) => Number.isInteger(value) && value > 0 && value <= 200;
  if (!validMs(raw.average_ms)) return null;
  const baseline = validMs(raw.baseline_lower_ms) && validMs(raw.baseline_upper_ms)
    && raw.baseline_lower_ms <= raw.baseline_upper_ms;
  return {
    source: SOURCE, sleep_start: raw.sleep_start, sleep_end: raw.sleep_end,
    average_ms: raw.average_ms,
    baseline_lower_ms: baseline ? raw.baseline_lower_ms : null,
    baseline_upper_ms: baseline ? raw.baseline_upper_ms : null,
    captured_at: raw.captured_at,
  };
}

function mergeSleepHrv(stored, incoming) {
  const next = normalizeSleepHrv(incoming);
  const previous = normalizeSleepHrv(stored);
  if (!next) return previous;
  if (!previous) return next;
  const wakeDifference = Date.parse(next.sleep_end) - Date.parse(previous.sleep_end);
  return wakeDifference > 0 || (wakeDifference === 0
    && Date.parse(next.captured_at) >= Date.parse(previous.captured_at)) ? next : previous;
}

module.exports = { normalizeSleepHrv, mergeSleepHrv };
