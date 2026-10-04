const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const { buildSummaryText, createApp, createHealthMcpServer, cycleContextForDate, formatLocalDate, mergeHealthData, normalizeSleepSession, readHealthRecords, storeCycleConfig } = require("./health-server");

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "health-mcp-test-"));
}

function readDay(dir, date) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), "utf8"));
}

// A night starting 23:00 the previous evening and ending at `endHour` on 2026-09-02 (Shanghai),
// with `durationHours` of sleep captured.
function night(endHour, durationHours) {
  return {
    session_start_time: "2026-09-01T23:00:00+08:00",
    session_end_time: `2026-09-02T${String(endHour).padStart(2, "0")}:00:00+08:00`,
    duration_seconds: durationHours * 3600,
    stages: [],
  };
}

function workout(overrides = {}) {
  const startTime = overrides.start_time || "2026-09-02T09:00:00+08:00";
  const rawType = overrides.raw_type ?? 3;
  const activityKind = overrides.activity_kind ?? 128;
  const localId = overrides.local_id ?? 42;
  const startSeconds = Date.parse(startTime) / 1000;
  return {
    id: `gbw1:${localId}:${startSeconds}:${rawType}:${activityKind}`,
    raw_type: rawType,
    activity_kind: activityKind,
    start_time: startTime,
    end_time: "2026-09-02T09:45:00+08:00",
    timezone: "Asia/Shanghai",
    captured_at: "2026-09-02T10:00:00+08:00",
    active_seconds: 1800,
    total_seconds: 2400,
    distance_meters: 6789,
    active_calories: 123,
    average_heart_rate: 111,
    min_heart_rate: 77,
    max_heart_rate: 155,
    ...overrides,
  };
}

test("a grown re-send overwrites the short night instead of doubling it", () => {
  const dir = tmpDataDir();
  // First upload: the fetch stopped mid-morning, so the night looks 5h long.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(4, 5)] });
  // Second upload: a later fetch extended the same night to 8h.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 1, "the night must not be stored twice");
  assert.equal(record.sleep_sessions[0].duration_min, 480);
  assert.equal(record.sleep.duration_min, 480, "the summary must not double-count");
});

test("two separate sessions on one day are both kept", () => {
  const dir = tmpDataDir();
  const nap = {
    session_start_time: "2026-09-02T13:00:00+08:00",
    session_end_time: "2026-09-02T14:00:00+08:00",
    duration_seconds: 3600,
    stages: [],
  };
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });
  mergeHealthData(dir, { date: "2026-09-02", sleep: [nap] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 2, "a nap and the night are distinct sessions");
  assert.equal(record.sleep.duration_min, 480 + 60);
});

test("a file left duplicated by the old merge heals on the next upload", () => {
  const dir = tmpDataDir();
  // Simulate a record written by the old end|duration merge: the same night stored twice.
  fs.writeFileSync(
    path.join(dir, "2026-09-02.json"),
    JSON.stringify({
      date: "2026-09-02",
      sleep_sessions: [normalizeSleepSession(night(4, 5)), normalizeSleepSession(night(7, 8))],
    }),
  );

  // Any further upload for that date triggers the self-heal.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 1, "pre-existing duplicates collapse to one");
  assert.equal(record.sleep.duration_min, 480);
});

test("workout summaries are saved with an explicit privacy allowlist", () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-02",
    steps: { total: 4321 },
    workouts: [workout({ route: [[31.2, 121.5]], device_address: "private", name: "private title" })],
  });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.steps.total, 4321);
  assert.equal(record.workouts.length, 1);
  assert.deepEqual(Object.keys(record.workouts[0]), [
    "id", "raw_type", "activity_kind", "start_time", "end_time", "timezone", "captured_at",
    "active_seconds", "total_seconds", "distance_meters", "active_calories",
    "average_heart_rate", "min_heart_rate", "max_heart_rate",
  ]);
  assert.equal(record.workouts[0].route, undefined);
  assert.equal(record.workouts[0].device_address, undefined);
  assert.equal(record.workouts[0].name, undefined);
});

test("workout re-sends update by stable id while malformed rows stay isolated", () => {
  const dir = tmpDataDir();
  const original = workout();
  mergeHealthData(dir, { date: "2026-09-02", workouts: [original] });
  mergeHealthData(dir, {
    date: "2026-09-02",
    heart_rate: [{ timestamp: "2026-09-02T10:05:00+08:00", bpm: 88 }],
    workouts: [
      { ...original, captured_at: "2026-09-02T10:10:00+08:00", active_calories: 124 },
      workout({
        local_id: 43,
        start_time: "2026-09-02T11:00:00+08:00",
        end_time: "2026-09-02T11:30:00+08:00",
        captured_at: "2026-09-02T12:00:00+08:00",
        active_seconds: 1700,
        total_seconds: 1750,
      }),
      { ...workout({ local_id: 44 }), active_seconds: 999999 },
      { ...workout({ local_id: 45 }), active_seconds: null },
      { id: "not-a-workout" },
    ],
  });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.heart_rate.samples.length, 1, "legacy health data must survive malformed workouts");
  assert.equal(record.workouts.length, 2);
  assert.equal(record.workouts[0].active_calories, 124, "the latest valid copy replaces the stored id");
  assert.equal(record.workouts[0].captured_at, "2026-09-02T10:10:00+08:00");
  assert.equal(record.workouts[1].id.startsWith("gbw1:43:"), true);
});

test("null and zero workout values remain distinct and an all-invalid batch adds nothing", () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-02",
    steps: { total: 99 },
    workouts: [workout({ total_seconds: null, distance_meters: null, active_calories: 0, average_heart_rate: null, min_heart_rate: null, max_heart_rate: null })],
  });
  let record = readDay(dir, "2026-09-02");
  assert.equal(record.workouts[0].total_seconds, null);
  assert.equal(record.workouts[0].distance_meters, null);
  assert.equal(record.workouts[0].active_calories, 0);

  mergeHealthData(dir, { date: "2026-09-03", steps: { total: 100 }, workouts: [{}, { id: "bad" }] });
  record = readDay(dir, "2026-09-03");
  assert.equal(record.steps.total, 100);
  assert.equal(record.workouts, undefined);
});

test("MCP exposes the public health read contract and custom day ranges", async () => {
  const dir = tmpDataDir();
  const today = new Date();
  const dates = [4, 3, 2, 1, 0].map((daysAgo) => {
    const date = new Date(today);
    date.setDate(date.getDate() - daysAgo);
    return formatLocalDate(date);
  });
  for (const [date, total] of dates.map((date, index) => [date, (index + 2) * 1000])) {
    mergeHealthData(dir, { date, type: "steps", data: { total } });
  }
  mergeHealthData(dir, { date: dates.at(-1), heart_rate: [
    { timestamp: `${dates.at(-1)}T00:10:00+08:00`, bpm: 60, resting_bpm: 58 },
    { timestamp: `${dates.at(-1)}T00:50:00+08:00`, bpm: 80 },
  ], sleep: [{
    session_start_time: `${dates.at(-1)}T00:30:00+08:00`, session_end_time: `${dates.at(-1)}T08:30:00+08:00`,
    duration_seconds: 28800, stages: [],
  }] });
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "public-health-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["health_read"]);
  assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties), ["data_type", "time_range", "heart_rate_detail", "days"]);
  const steps = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "steps", days: 5 } })).content[0].text);
  assert.equal(steps.summaries.length, 5);
  const hourly = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "heart_rate", heart_rate_detail: "hourly", time_range: "today" } })).content[0].text);
  assert.equal(hourly.hourly_summaries.length, 1);
  const summary = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "daily_summary", time_range: "today" } })).content[0].text);
  assert.equal(summary.summaries[0].sleep.duration_min, 480);
  await client.close();
  await server.close();
});

test("MCP reads saved workouts with day ranges, latest-first order and allowlisted fields", async (t) => {
  const dir = tmpDataDir();
  const today = formatLocalDate(new Date());
  const yesterday = formatLocalDate(new Date(Date.now() - 86400000));
  const make = (date, localId) => workout({ local_id: localId, start_time: `${date}T09:00:00+08:00`,
    end_time: `${date}T09:45:00+08:00`, captured_at: `${date}T10:00:00+08:00` });
  mergeHealthData(dir, { date: yesterday, workouts: [make(yesterday, 1)] });
  mergeHealthData(dir, { date: today, steps: { total: 456 }, workouts: [make(today, 2)] });
  const file = path.join(dir, `${today}.json`);
  const stored = readDay(dir, today);
  stored.workouts[0].route = [[1, 2]];
  stored.workouts[0].name = "private title";
  stored.workouts.push({ id: "bad" });
  fs.writeFileSync(file, JSON.stringify(stored));
  const before = fs.readFileSync(file, "utf8");
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "workout-read-test", version: "1" }, { capabilities: {} });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.ok(tools.tools[0].inputSchema.properties.data_type.enum.includes("workouts"));
  const call = async (args) => JSON.parse((await client.callTool({ name: "health_read", arguments: args })).content[0].text);
  const one = await call({ data_type: "workouts", time_range: "today" });
  assert.equal(one.data_type, "workouts");
  assert.equal(one.days, 1);
  assert.equal(one.workouts.length, 1);
  assert.equal(one.workouts[0].route, undefined);
  assert.equal(one.workouts[0].name, undefined);
  assert.equal(one.workouts[0].active_seconds, 1800);
  const two = await call({ data_type: "workouts", days: 2, time_range: "today" });
  assert.deepEqual(two.workouts.map((row) => row.date), [today, yesterday]);
  assert.equal(two.time_range, "custom");
  const all = await call({ data_type: "all", days: 2 });
  assert.deepEqual(all.workouts, two.workouts);
  assert.equal(all.today_steps, 456);
  assert.equal(fs.readFileSync(file, "utf8"), before, "reads must not rewrite stored history");
});

test("MCP returns an empty workout list for missing or malformed legacy collections", async (t) => {
  const dir = tmpDataDir();
  const today = formatLocalDate(new Date());
  fs.writeFileSync(path.join(dir, `${today}.json`), JSON.stringify({ date: today, workouts: { bad: true } }));
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "empty-workout-test", version: "1" }, { capabilities: {} });
  t.after(async () => { await client.close(); await server.close(); });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  for (const data_type of ["workouts", "all"]) {
    const result = await client.callTool({ name: "health_read", arguments: { data_type, days: 62 } });
    assert.deepEqual(JSON.parse(result.content[0].text).workouts, []);
  }
  fs.writeFileSync(path.join(dir, `${today}.json`), JSON.stringify({ date: today, steps: { total: 0 } }));
  const result = await client.callTool({ name: "health_read", arguments: { data_type: "workouts" } });
  assert.deepEqual(JSON.parse(result.content[0].text).workouts, []);
});

test("cycle endpoint stores and clears independent cycle context", async () => {
  const dir = tmpDataDir();
  const app = createApp({ dataDir: dir, ingestToken: "1234567890abcdef" });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const config = { enabled: true, last_start: "2026-09-01", cycle_length_days: 28, cycle_period_days: 5, last_confirmed: "2026-09-05" };
  let response = await fetch(`${base}/cycle`, { method: "POST", headers: { authorization: "Bearer 1234567890abcdef", "content-type": "application/json" }, body: JSON.stringify(config) });
  assert.equal(response.status, 200);
  mergeHealthData(dir, { date: "2026-09-05", type: "steps", data: { total: 100 } });
  const result = readHealthRecords(dir, 2, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(result.find((record) => record.date === "2026-09-05").cycle, { period_day: 5, confirmed: true });
  response = await fetch(`${base}/cycle`, { method: "POST", headers: { authorization: "Bearer 1234567890abcdef", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
  await new Promise((resolve) => listener.close(resolve));
});

const confirmedCycle = {
  enabled: true,
  last_start: "2026-09-01",
  cycle_length_days: 28,
  cycle_period_days: 5,
  last_confirmed: "2026-09-05",
};

test("cycle context includes only period days and the three-day warning", () => {
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-01"), { period_day: 1, confirmed: true });
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-05"), { period_day: 5, confirmed: true });
  assert.equal(cycleContextForDate(confirmedCycle, "2026-09-06"), null);
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-26"), { days_until_period: 3, confirmed: true });
});

test("cycle annotations are dynamic and never written into day files", () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, "2026-09-05.json"), JSON.stringify({ date: "2026-09-05", steps: { total: 8234 } }));
  storeCycleConfig(dir, confirmedCycle);
  const records = readHealthRecords(dir, 1, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(records[0].cycle, { period_day: 5, confirmed: true });
  assert.match(buildSummaryText(records), /经期第5天/);
  assert.equal(readDay(dir, "2026-09-05").cycle, undefined);
});

test("invalid calendar dates are rejected and repeated clear stays successful", () => {
  const dir = tmpDataDir();
  assert.throws(() => storeCycleConfig(dir, { ...confirmedCycle, last_start: "2026-02-30" }), /last_start/);
  storeCycleConfig(dir, confirmedCycle);
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
});
