require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { hostHeaderValidation } = require("@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js");
const { z } = require("zod");
const { buildAllowedHosts, installRequestObservability, mountMcpEndpoint } = require("./shared/http-runtime");

const DEFAULT_DATA_DIR = "/var/lib/health-mcp";
const VALID_TYPES = new Set(["steps", "heart_rate", "sleep", "all"]);
const DATA_TYPES = ["current_status", "steps", "heart_rate", "sleep", "daily_summary", "all"];
const TIME_RANGES = ["three_days", "today"];
const HEART_RATE_DETAILS = ["daily", "hourly"];
const MAX_READ_DAYS = 62;
const MAX_WORKOUTS_PER_DAY = 128;
const MAX_WORKOUT_SECONDS = 7 * 24 * 60 * 60;
const TZ = process.env.HEALTH_TZ || "Asia/Shanghai";

function formatLocalDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function validDate(value) {
  return parseDateDay(value) !== null;
}

function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function recordPath(dataDir, date) {
  if (!validDate(date)) throw new Error("date must be YYYY-MM-DD");
  return path.join(ensureDataDir(dataDir), `${date}.json`);
}

function writeRecordAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readRecord(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseDateDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const millis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(millis);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
    ? Math.floor(millis / 86400000) : null;
}

function normalizePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function normalizeCycleConfig(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  if (body.enabled === false) return { enabled: false };
  if (body.enabled !== true) throw new Error("enabled must be true or false");
  const lastStart = String(body.last_start || "");
  const lastConfirmed = body.last_confirmed ? String(body.last_confirmed) : null;
  if (parseDateDay(lastStart) === null) throw new Error("last_start must be YYYY-MM-DD");
  if (lastConfirmed !== null && parseDateDay(lastConfirmed) === null) throw new Error("last_confirmed must be YYYY-MM-DD");
  const cycleLengthDays = normalizePositiveInteger(body.cycle_length_days, "cycle_length_days");
  const cyclePeriodDays = normalizePositiveInteger(body.cycle_period_days, "cycle_period_days");
  if (cyclePeriodDays > cycleLengthDays) throw new Error("cycle_period_days must not exceed cycle_length_days");
  return { enabled: true, last_start: lastStart, cycle_length_days: cycleLengthDays, cycle_period_days: cyclePeriodDays, ...(lastConfirmed === null ? {} : { last_confirmed: lastConfirmed }) };
}

function cyclePath(dataDir) { return path.join(ensureDataDir(dataDir), "cycle.json"); }
function readCycleConfig(dataDir) {
  const config = readRecord(cyclePath(dataDir), null);
  if (!config) return null;
  try { const normalized = normalizeCycleConfig(config); return normalized.enabled ? normalized : null; } catch { return null; }
}
function storeCycleConfig(dataDir, body) {
  const config = normalizeCycleConfig(body);
  if (!config.enabled) { try { fs.unlinkSync(cyclePath(dataDir)); } catch (error) { if (error.code !== "ENOENT") throw error; } return config; }
  writeRecordAtomic(cyclePath(dataDir), config);
  return config;
}
function cycleContextForDate(config, date) {
  if (!config || config.enabled !== true) return null;
  const targetDay = parseDateDay(date); const anchorDay = parseDateDay(config.last_start);
  const cycleLengthDays = Number(config.cycle_length_days); const cyclePeriodDays = Number(config.cycle_period_days);
  if (targetDay === null || anchorDay === null || !Number.isSafeInteger(cycleLengthDays) || cycleLengthDays <= 0 || !Number.isSafeInteger(cyclePeriodDays) || cyclePeriodDays <= 0 || cyclePeriodDays > cycleLengthDays) return null;
  const offset = ((targetDay - anchorDay) % cycleLengthDays + cycleLengthDays) % cycleLengthDays;
  const cycleStartDay = targetDay - offset;
  const confirmedDay = parseDateDay(config.last_confirmed);
  const confirmed = confirmedDay !== null && confirmedDay >= cycleStartDay && confirmedDay < cycleStartDay + cycleLengthDays;
  const periodDay = offset + 1;
  if (periodDay <= cyclePeriodDays) return { period_day: periodDay, confirmed };
  const daysUntilPeriod = cycleLengthDays - offset;
  return daysUntilPeriod <= 3 ? { days_until_period: daysUntilPeriod, confirmed } : null;
}

function normalizeSleepSession(rawSession) {
  if (!rawSession || typeof rawSession !== "object") return null;
  const endDate = new Date(rawSession.session_end_time || rawSession.end || "");
  const durationSeconds = Math.max(0, Number(rawSession.duration_seconds || 0));
  if (Number.isNaN(endDate.getTime()) || durationSeconds <= 0) return null;

  const stages = (Array.isArray(rawSession.stages) ? rawSession.stages : [])
    .map((stage) => {
      const start = new Date(stage.start_time || "");
      const end = new Date(stage.end_time || "");
      const seconds = Math.max(0, Number(stage.duration_seconds || 0));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
      return {
        stage: String(stage.stage || "unknown"),
        start: start.toISOString(),
        end: end.toISOString(),
        duration_seconds: seconds || Math.round((end - start) / 1000),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));

  const explicitStart = new Date(rawSession.session_start_time || rawSession.start || "");
  const derivedStart = stages[0]?.start || new Date(endDate.getTime() - durationSeconds * 1000).toISOString();
  const start = Number.isNaN(explicitStart.getTime()) ? derivedStart : explicitStart.toISOString();
  const end = endDate.toISOString();
  return {
    session_key: `${end}|${Math.round(durationSeconds)}`,
    start,
    end,
    duration_min: Math.round(durationSeconds / 60),
    score: Number(rawSession.score || 0),
    stages,
  };
}

function sleepStageMetricKey(stage) {
  const name = String(stage ?? "").trim().toLowerCase();
  if (name === "1" || name === "3" || name === "7" || name.includes("awake") || name.includes("out_of_bed")) {
    return "awake_min";
  }
  if (name === "4" || name.includes("light")) return "light_min";
  if (name === "5" || name.includes("deep")) return "deep_min";
  if (name === "6" || name.includes("rem")) return "rem_min";
  return null;
}

function summarizeSleepSessions(sessions, updatedAt) {
  const summary = {
    duration_min: 0,
    deep_min: 0,
    light_min: 0,
    rem_min: 0,
    awake_min: 0,
    start: sessions[0]?.start || "",
    end: sessions[sessions.length - 1]?.end || "",
    score: 0,
    updatedAt,
  };
  let scored = 0;
  for (const session of sessions) {
    summary.duration_min += Number(session.duration_min || 0);
    if (session.score > 0) {
      summary.score += session.score;
      scored += 1;
    }
    for (const stage of session.stages || []) {
      const minutes = Math.round(Number(stage.duration_seconds || 0) / 60);
      const key = sleepStageMetricKey(stage.stage);
      if (key) summary[key] += minutes;
    }
  }
  summary.score = scored ? Math.round(summary.score / scored) : 0;
  return summary;
}

// Two sessions are the same night when their [start, end] spans overlap. A night that grew between
// uploads (a later fetch extended its tail) comes back with a later end; keyed on end|duration it
// would land beside the stored short version and be summed twice, so instead it replaces it. Truly
// separate sessions on one day (a nap and the night) do not overlap and are both kept.
function sleepSessionsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// The more complete version of a night: the one that ends later, tie-broken by more sleep captured.
// A re-send only ever extends a session, so this keeps the corrected value and drops the stale one.
function moreCompleteSleepSession(a, b) {
  if (a.end !== b.end) return a.end > b.end ? a : b;
  return Number(b.duration_min || 0) > Number(a.duration_min || 0) ? b : a;
}

function upsertSleepSession(sessions, incoming) {
  const overlapIndex = sessions.findIndex((existing) => sleepSessionsOverlap(existing, incoming));
  if (overlapIndex === -1) {
    sessions.push(incoming);
  } else {
    sessions[overlapIndex] = moreCompleteSleepSession(sessions[overlapIndex], incoming);
  }
}

function normalizeWorkoutNumber(value, name, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number)) || number < min || number > max) {
    throw new Error(`${name} is invalid`);
  }
  return number;
}

function normalizeWorkoutTimestamp(value, name) {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${name} must be an ISO 8601 timestamp with an offset`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis % 1000 !== 0) throw new Error(`${name} is invalid`);
  return { text: value, millis };
}

function normalizeWorkoutSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("workout must be an object");
  if (typeof raw.id !== "string") throw new Error("workout id is invalid");
  const identity = /^gbw1:([1-9]\d{0,14}):(-?\d+):(\d{1,3}):(\d+)$/.exec(raw.id);
  if (!identity) throw new Error("workout id is invalid");

  const localId = Number(identity[1]);
  const identityStart = Number(identity[2]);
  const identityRawType = Number(identity[3]);
  const identityActivityKind = Number(identity[4]);
  if (![localId, identityStart, identityRawType, identityActivityKind].every(Number.isSafeInteger)) {
    throw new Error("workout id is invalid");
  }

  const rawType = normalizeWorkoutNumber(raw.raw_type, "raw_type", { integer: true, min: 0, max: 255 });
  const activityKind = normalizeWorkoutNumber(raw.activity_kind, "activity_kind", { integer: true, min: 0, max: 2147483647 });
  const start = normalizeWorkoutTimestamp(raw.start_time, "start_time");
  const end = normalizeWorkoutTimestamp(raw.end_time, "end_time");
  const captured = normalizeWorkoutTimestamp(raw.captured_at, "captured_at");
  const timezone = typeof raw.timezone === "string" && /^[A-Za-z0-9_+./:-]{1,64}$/.test(raw.timezone)
    ? raw.timezone : null;
  if (!timezone) throw new Error("timezone is invalid");

  const startSeconds = start.millis / 1000;
  const elapsedSeconds = (end.millis - start.millis) / 1000;
  if (identityStart !== startSeconds || identityRawType !== rawType || identityActivityKind !== activityKind) {
    throw new Error("workout id does not match its fields");
  }
  if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 1 || elapsedSeconds > MAX_WORKOUT_SECONDS || captured.millis < end.millis) {
    throw new Error("workout timestamps are invalid");
  }

  const activeSeconds = normalizeWorkoutNumber(raw.active_seconds, "active_seconds", { integer: true, min: 0, max: elapsedSeconds });
  if (activeSeconds === null) throw new Error("active_seconds is required");
  const totalSeconds = normalizeWorkoutNumber(raw.total_seconds, "total_seconds", { integer: true, min: activeSeconds, max: elapsedSeconds });
  const distanceMeters = normalizeWorkoutNumber(raw.distance_meters, "distance_meters", { max: 10000000 });
  const activeCalories = normalizeWorkoutNumber(raw.active_calories, "active_calories", { max: 10000000 });
  const averageHeartRate = normalizeWorkoutNumber(raw.average_heart_rate, "average_heart_rate", { integer: true, min: 1, max: 300 });
  const minHeartRate = normalizeWorkoutNumber(raw.min_heart_rate, "min_heart_rate", { integer: true, min: 1, max: 300 });
  const maxHeartRate = normalizeWorkoutNumber(raw.max_heart_rate, "max_heart_rate", { integer: true, min: 1, max: 300 });
  if ([averageHeartRate, minHeartRate, maxHeartRate].includes(255)) throw new Error("heart rate is invalid");
  if (minHeartRate !== null && maxHeartRate !== null && minHeartRate > maxHeartRate) throw new Error("heart rate range is invalid");
  if (averageHeartRate !== null && ((minHeartRate !== null && averageHeartRate < minHeartRate) || (maxHeartRate !== null && averageHeartRate > maxHeartRate))) {
    throw new Error("average heart rate is outside its range");
  }

  return {
    id: raw.id,
    raw_type: rawType,
    activity_kind: activityKind,
    start_time: start.text,
    end_time: end.text,
    timezone,
    captured_at: captured.text,
    active_seconds: activeSeconds,
    total_seconds: totalSeconds,
    distance_meters: distanceMeters,
    active_calories: activeCalories,
    average_heart_rate: averageHeartRate,
    min_heart_rate: minHeartRate,
    max_heart_rate: maxHeartRate,
  };
}

function mergeWorkoutSummaries(stored, incoming) {
  const workouts = [];
  const positions = new Map();
  const keep = (raw, replace) => {
    let normalized;
    try {
      normalized = normalizeWorkoutSummary(raw);
    } catch {
      return;
    }
    const position = positions.get(normalized.id);
    if (position !== undefined) {
      if (replace) workouts[position] = normalized;
      return;
    }
    if (workouts.length >= MAX_WORKOUTS_PER_DAY) return;
    positions.set(normalized.id, workouts.length);
    workouts.push(normalized);
  };
  for (const workout of Array.isArray(stored) ? stored : []) keep(workout, false);
  for (const workout of incoming) keep(workout, true);
  return workouts.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
}

function mergeSleepSessionsForDate(dataDir, date, incoming, updatedAt) {
  const filePath = recordPath(dataDir, date);
  const record = readRecord(filePath, { date });
  const stored = Array.isArray(record.sleep_sessions) ? record.sleep_sessions : [];
  // Rebuild through the same overlap rule so a file written by the old end|duration merge, which
  // could hold one night twice, heals itself the next time any data for its date arrives.
  const sessions = [];
  for (const session of stored) upsertSleepSession(sessions, session);
  for (const session of incoming) upsertSleepSession(sessions, session);
  record.sleep_sessions = sessions.sort((a, b) => a.end.localeCompare(b.end));
  record.sleep = summarizeSleepSessions(record.sleep_sessions, updatedAt);
  writeRecordAtomic(filePath, record);
  return record;
}

function mergeHealthData(dataDir, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  const date = body.date || formatLocalDate(new Date());
  const filePath = recordPath(dataDir, date);
  let current = readRecord(filePath, { date });
  if (!current.date) current.date = date;

  const type = body.type;
  const data = body.data || {};
  const now = new Date().toISOString();
  const sleepSessionsByDate = new Map();

  if (Array.isArray(body.sleep)) {
    for (const rawSession of body.sleep) {
      const session = normalizeSleepSession(rawSession);
      if (!session) continue;
      const sessionDate = formatLocalDate(new Date(session.end));
      if (!sleepSessionsByDate.has(sessionDate)) sleepSessionsByDate.set(sessionDate, []);
      sleepSessionsByDate.get(sessionDate).push(session);
    }
    for (const [sessionDate, sessions] of sleepSessionsByDate) {
      mergeSleepSessionsForDate(dataDir, sessionDate, sessions, now);
    }
    if (sleepSessionsByDate.has(date)) {
      current = readRecord(filePath, current);
    } else if (current.sleep?.end) {
      const incomingEnds = new Set([...sleepSessionsByDate.values()].flat().map((session) => session.end));
      const oldEnd = new Date(current.sleep.end);
      if (!Number.isNaN(oldEnd.getTime()) && incomingEnds.has(oldEnd.toISOString())) {
        delete current.sleep;
        delete current.sleep_sessions;
      }
    }
  }

  if (type === "steps" || body.steps !== undefined) {
    let newTotal = 0;
    if (Array.isArray(body.steps)) {
      for (const entry of body.steps) newTotal = Math.max(newTotal, Number(entry.count || 0));
    } else {
      const value = type === "steps" ? data : (body.steps || {});
      newTotal = Number(value.total || value.count || value.value || 0);
    }
    current.steps = { total: Math.max(current.steps?.total || 0, newTotal), updatedAt: now };
  }

  if (type === "heart_rate" || body.heart_rate !== undefined) {
    if (!current.heart_rate) current.heart_rate = { samples: [] };
    if (!Array.isArray(current.heart_rate.samples)) current.heart_rate.samples = [];
    const entries = Array.isArray(body.heart_rate)
      ? body.heart_rate
      : [(type === "heart_rate" ? data : (body.heart_rate || {}))];
    for (const entry of entries) {
      const ts = entry.timestamp || entry.ts || entry.time || now;
      const bpm = Number(entry.value || entry.bpm || 0);
      if (bpm > 0 && !current.heart_rate.samples.some((sample) => sample.ts === ts)) {
        current.heart_rate.samples.push({ ts, bpm });
      }
      if (entry.resting || entry.resting_bpm) {
        current.heart_rate.resting = Number(entry.resting || entry.resting_bpm);
      }
    }
    current.heart_rate.samples.sort((a, b) => a.ts.localeCompare(b.ts));
    if (current.heart_rate.samples.length > 288) current.heart_rate.samples = current.heart_rate.samples.slice(-288);
    const bpms = current.heart_rate.samples.map((sample) => sample.bpm).filter((bpm) => bpm > 0);
    if (bpms.length) current.heart_rate.avg = Math.round(bpms.reduce((sum, bpm) => sum + bpm, 0) / bpms.length);
    current.heart_rate.updatedAt = now;
  }

  if (Array.isArray(body.workouts)) {
    const workouts = mergeWorkoutSummaries(current.workouts, body.workouts);
    if (workouts.length) current.workouts = workouts;
    else delete current.workouts;
  }

  for (const caloriesType of ["active_calories", "total_calories"]) {
    if (body[caloriesType] !== undefined) {
      const total = Array.isArray(body[caloriesType])
        ? body[caloriesType].reduce((sum, entry) => sum + Number(entry.calories || 0), 0)
        : 0;
      current[caloriesType] = { total, updatedAt: now };
    }
  }
  if (type === "calories" || type === "active_calories") {
    if (!current.active_calories) current.active_calories = { total: 0, updatedAt: now };
    current.active_calories.total += Number(data.calories || data.total || 0);
    current.active_calories.updatedAt = now;
  }

  if (type === "sleep" || (body.sleep !== undefined && !Array.isArray(body.sleep))) {
    const value = type === "sleep" ? data : (body.sleep || {});
    current.sleep = {
      duration_min: Number(value.duration_min || value.duration || 0),
      deep_min: Number(value.deep_min || value.deep || 0),
      light_min: Number(value.light_min || value.light || 0),
      rem_min: Number(value.rem_min || value.rem || 0),
      awake_min: Number(value.awake_min || value.awake || 0),
      start: value.start || value.startTime || "",
      end: value.end || value.endTime || "",
      score: Number(value.score || 0),
      updatedAt: now,
    };
  }

  writeRecordAtomic(filePath, current);
  return current;
}

function readHealthRecords(dataDir, days, type, now = new Date()) {
  const records = [];
  const cycleConfig = readCycleConfig(dataDir);
  for (let index = 0; index < days; index += 1) {
    const dateValue = new Date(now);
    dateValue.setDate(dateValue.getDate() - index);
    const date = formatLocalDate(dateValue);
    const filePath = recordPath(dataDir, date);
    if (!fs.existsSync(filePath)) continue;
    const record = readRecord(filePath, null);
    if (!record) continue;
    const cycle = cycleContextForDate(cycleConfig, record.date || date);
    if (type && type !== "all") {
      const filtered = { date: record.date || date };
      if (record[type]) filtered[type] = record[type];
      if (type === "sleep" && record.sleep_sessions) filtered.sleep_sessions = record.sleep_sessions;
      if (cycle) filtered.cycle = cycle;
      records.push(filtered);
    } else {
      if (cycle) record.cycle = cycle;
      records.push(record);
    }
  }
  return records;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function latestSample(record) {
  return (record?.heart_rate?.samples || [])
    .map((sample) => ({ time: new Date(sample.ts || sample.timestamp || sample.time || ""), value: nullableNumber(sample.bpm ?? sample.value) }))
    .filter((sample) => !Number.isNaN(sample.time.getTime()) && sample.value !== null)
    .sort((a, b) => a.time - b.time).at(-1)?.value ?? null;
}

function heartRateSummary(record) {
  const values = (record?.heart_rate?.samples || []).map((sample) => nullableNumber(sample.bpm ?? sample.value)).filter((value) => value !== null);
  return {
    hr_max: values.length ? Math.max(...values) : null,
    hr_min: values.length ? Math.min(...values) : null,
    hr_avg: nullableNumber(record?.heart_rate?.avg) ?? (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null),
    hr_resting: nullableNumber(record?.heart_rate?.resting),
  };
}

function dailySummary(record) {
  return {
    date: record.date,
    steps: nullableNumber(record?.steps?.total),
    calories: nullableNumber(record?.active_calories?.total ?? record?.total_calories?.total),
    ...heartRateSummary(record),
    stress_avg: nullableNumber(record?.stress?.avg ?? record?.stress),
    spo2_avg: nullableNumber(record?.spo2?.avg ?? record?.spo2 ?? record?.blood_oxygen),
    sleep: record.sleep ? {
      duration_min: nullableNumber(record.sleep.duration_min), deep_min: nullableNumber(record.sleep.deep_min),
      light_min: nullableNumber(record.sleep.light_min), rem_min: nullableNumber(record.sleep.rem_min),
      awake_min: nullableNumber(record.sleep.awake_min), score: nullableNumber(record.sleep.score),
    } : null,
  };
}

function formatSleepClock(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function sleepSession(record, session) {
  const stageMinutes = (names) => (session.stages || []).reduce((total, stage) => String(stage.stage ?? "").toLowerCase() && names.some((name) => String(stage.stage ?? "").toLowerCase() === name || String(stage.stage ?? "").toLowerCase().includes(name)) ? total + Math.round(Number(stage.duration_seconds || 0) / 60) : total, 0);
  const deep = stageMinutes(["5", "deep"]); const light = stageMinutes(["4", "light"]); const rem = stageMinutes(["6", "rem"]); const awake = stageMinutes(["1", "3", "7", "awake", "out_of_bed"]);
  const duration = nullableNumber(session.duration_min) ?? 0;
  const result = { type: awake > 0 && deep === 0 && light === 0 && rem === 0 ? "nap" : "sleep", start: formatSleepClock(session.start), end: formatSleepClock(session.end), total_minutes: duration, duration_text: `${Math.floor(duration / 60)}h ${duration % 60}min` };
  if (result.type === "sleep") Object.assign(result, { deep_sleep_minutes: deep || nullableNumber(record?.sleep?.deep_min) || 0, light_sleep_minutes: light || nullableNumber(record?.sleep?.light_min) || 0, rem_sleep_minutes: rem || nullableNumber(record?.sleep?.rem_min) || 0 });
  return result;
}

function sleepSessions(records) {
  return records.flatMap((record) => {
    const sessions = Array.isArray(record.sleep_sessions) && record.sleep_sessions.length ? record.sleep_sessions : (record.sleep?.start || record.sleep?.end ? [record.sleep] : []);
    return sessions.map((session) => ({ session: sleepSession(record, session), end: new Date(session.end || "").getTime() }));
  }).sort((a, b) => b.end - a.end).map(({ session }) => session);
}

function hourlyHeartRateSummaries(records) {
  const buckets = new Map();
  for (const record of records) for (const sample of record?.heart_rate?.samples || []) {
    const value = nullableNumber(sample.bpm ?? sample.value); const date = new Date(sample.ts || sample.timestamp || sample.time || "");
    if (value === null || Number.isNaN(date.getTime())) continue;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
    const hour = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00`;
    if (!buckets.has(hour)) buckets.set(hour, []); buckets.get(hour).push(value);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, values]) => ({ hour, hr_max: Math.max(...values), hr_min: Math.min(...values), hr_avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), sample_count: values.length }));
}

function parseHealthToolRequest(args = {}) {
  const dataType = DATA_TYPES.includes(args.data_type) ? args.data_type : "current_status";
  const customDays = Number.isSafeInteger(args.days) && args.days >= 1 && args.days <= MAX_READ_DAYS ? args.days : null;
  const timeRange = customDays !== null ? "custom" : (args.time_range === "today" ? "today" : "three_days");
  return { dataType, timeRange, days: customDays ?? (timeRange === "today" ? 1 : 3) };
}

function readHealthToolResult(dataDir, args = {}) {
  const { dataType, timeRange, days } = parseHealthToolRequest(args);
  const today = formatLocalDate(new Date());
  const records = readHealthRecords(dataDir, dataType === "current_status" ? 3 : days, "all");
  const summaries = records.map(dailySummary).sort((a, b) => a.date.localeCompare(b.date));
  const todayRecord = records.find((record) => record.date === today) || {};
  const sleep = sleepSessions(records);
  const resultBase = { success: true, data_type: dataType };
  const withCycle = (result) => todayRecord.cycle ? { ...result, cycle: todayRecord.cycle } : result;
  if (dataType === "current_status") return withCycle({ ...resultBase, today_steps: summaries.find((summary) => summary.date === today)?.steps ?? null, today_calories: summaries.find((summary) => summary.date === today)?.calories ?? null, heart_rate: latestSample(todayRecord), spo2: nullableNumber(todayRecord.spo2 ?? todayRecord.blood_oxygen), stress: nullableNumber(todayRecord.stress), latest_sleep: sleep[0] || null });
  const range = { ...resultBase, time_range: timeRange, days };
  if (dataType === "steps") return withCycle({ ...range, today_steps: summaries.find((summary) => summary.date === today)?.steps ?? null, summaries: summaries.map(({ date, steps, calories }) => ({ date, steps, calories })) });
  if (dataType === "heart_rate") {
    const result = withCycle({ ...range, latest_heart_rate: records.map(latestSample).find((value) => value !== null) ?? null, daily_summaries: summaries.map(({ date, hr_max, hr_min, hr_avg, hr_resting }) => ({ date, hr_max, hr_min, hr_avg, hr_resting })) });
    return args.heart_rate_detail === "hourly" ? { ...result, detail: "hourly", hourly_summaries: hourlyHeartRateSummaries(records) } : result;
  }
  if (dataType === "sleep") return withCycle({ ...range, recent_sleep_list: sleep });
  if (dataType === "daily_summary") return withCycle({ ...range, summaries });
  return withCycle({ ...range, latest_heart_rate: records.map(latestSample).find((value) => value !== null) ?? null, today_heart_rate: latestSample(todayRecord), spo2: nullableNumber(todayRecord.spo2 ?? todayRecord.blood_oxygen), stress: nullableNumber(todayRecord.stress), today_steps: summaries.find((summary) => summary.date === today)?.steps ?? null, today_calories: summaries.find((summary) => summary.date === today)?.calories ?? null, recent_sleep_list: sleep, summaries });
}

function buildSummaryText(records) {
  if (!records.length) return "No health data available.";
  return records.map((record) => {
    const parts = [];
    if (record.steps?.total) parts.push(`步数 ${record.steps.total}`);
    if (record.heart_rate?.avg) {
      const resting = record.heart_rate.resting ? `（静息 ${record.heart_rate.resting}）` : "";
      parts.push(`心率均值 ${record.heart_rate.avg} bpm${resting}`);
    }
    if (record.sleep) {
      const minutes = Number(record.sleep.duration_min || 0);
      const duration = minutes ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : "";
      const deep = record.sleep.deep_min ? ` 深睡 ${record.sleep.deep_min}min` : "";
      parts.push(`睡眠 ${duration}${deep}${record.sleep.score ? ` 评分${record.sleep.score}` : ""}`);
    }
    if (record.cycle?.period_day) {
      parts.push(`${record.cycle.confirmed ? "" : "预计"}经期第${record.cycle.period_day}天`);
    } else if (record.cycle?.days_until_period) {
      parts.push(`预计${record.cycle.days_until_period}天后来经期`);
    }
    return `${record.date}: ${parts.join(", ") || "无数据"}`;
  }).join("\n");
}

function createHealthMcpServer(dataDir) {
  const server = new McpServer({ name: "health", version: "1.1.0" });
  server.tool("health_read", "读取健康数据：当前状态、步数、心率、睡眠、每日摘要或完整数据。", {
    data_type: z.enum(DATA_TYPES).optional(),
    time_range: z.enum(TIME_RANGES).optional(),
    heart_rate_detail: z.enum(HEART_RATE_DETAILS).optional(),
    days: z.number().int().min(1).max(MAX_READ_DAYS).optional(),
  }, async (args) => ({
    content: [{ type: "text", text: JSON.stringify(readHealthToolResult(dataDir, args), null, 2) }],
  }));
  return server;
}

function bearerMiddleware(token) {
  if (!token) return [];
  return [(req, res, next) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }];
}

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.HEALTH_DATA_DIR || DEFAULT_DATA_DIR;
  const jsonLimit = options.jsonLimit || process.env.HEALTH_JSON_LIMIT || "16mb";
  const publicUrls = options.publicUrls || String(
    options.publicUrl || process.env.HEALTH_MCP_PUBLIC_URLS || process.env.HEALTH_MCP_PUBLIC_URL || "",
  ).split(",").map((value) => value.trim()).filter(Boolean);
  const ingestToken = options.ingestToken ?? process.env.HEALTH_INGEST_TOKEN ?? "";
  const readToken = options.readToken ?? process.env.HEALTH_MCP_ACCESS_TOKEN ?? "";
  if (!ingestToken || ingestToken.length < 16) throw new Error("HEALTH_INGEST_TOKEN must be at least 16 characters");

  const allowedHosts = [...new Set((publicUrls.length ? publicUrls : [""]).flatMap(buildAllowedHosts))];
  const app = express();
  installRequestObservability(app, { service: "health-mcp" });
  app.use(express.json({ limit: jsonLimit }));
  app.use(hostHeaderValidation(allowedHosts));
  app.get(["/health", "/healthz"], (_req, res) => res.json({ ok: true, service: "health-mcp" }));
  app.get("/", (_req, res) => res.json({ service: "health-mcp" }));
  app.post("/api/health", ...bearerMiddleware(ingestToken), (req, res) => {
    try {
      const result = mergeHealthData(dataDir, req.body);
      res.json({ ok: true, date: result.date });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post("/cycle", ...bearerMiddleware(ingestToken), (req, res) => {
    try {
      const config = storeCycleConfig(dataDir, req.body);
      res.json({ ok: true, enabled: config.enabled });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.get("/api/health", ...bearerMiddleware(readToken), (req, res) => {
    const days = Math.min(62, Math.max(1, Number.parseInt(req.query.days, 10) || 7));
    const type = VALID_TYPES.has(req.query.type) ? req.query.type : "all";
    res.json(readHealthRecords(dataDir, days, type));
  });
  mountMcpEndpoint(app, {
    path: "/mcp",
    middleware: bearerMiddleware(readToken),
    createServer: () => createHealthMcpServer(dataDir),
  });
  return app;
}

function main() {
  const port = Number(process.env.HEALTH_MCP_PORT || 3100);
  const host = process.env.HEALTH_MCP_HOST || "127.0.0.1";
  const app = createApp();
  app.listen(port, host, () => console.log(`Health MCP listening on ${host}:${port}`));
}

if (require.main === module) main();

module.exports = {
  buildSummaryText,
  cycleContextForDate,
  createApp,
  createHealthMcpServer,
  formatLocalDate,
  mergeHealthData,
  normalizeSleepSession,
  readHealthRecords,
  readHealthToolResult,
  storeCycleConfig,
};
