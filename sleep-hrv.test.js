const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeHealthData, readHealthToolResult, formatLocalDate } = require('./health-server');
const { normalizeSleepHrv, mergeSleepHrv } = require('./shared/sleep-hrv');

// Synthetic, with no device identifiers or user data.
const summary = (overrides = {}) => ({
  source: 'huawei_sleep_statistics', sleep_start: '2001-02-02T23:00:00+08:00',
  sleep_end: '2001-02-03T07:00:00+08:00', captured_at: '2001-02-03T09:00:00+08:00',
  average_ms: 60, baseline_lower_ms: 45, baseline_upper_ms: 84, ...overrides,
});
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-hrv-test-'));
const day = (dir, date) => JSON.parse(fs.readFileSync(path.join(dir, date + '.json'), 'utf8'));

test('sleep HRV uses wake date and survives a simultaneous sleep merge and ordinary resend', () => {
  const dir = directory();
  mergeHealthData(dir, { date: '2001-02-03', steps: { total: 100 }, sleep_hrv: [summary()], sleep: [{
    session_start_time: summary().sleep_start, session_end_time: summary().sleep_end,
    duration_seconds: 28800, stages: [],
  }] });
  assert.equal(day(dir, '2001-02-03').sleep_hrv.average_ms, 60);
  assert.equal(day(dir, '2001-02-03').sleep.duration_min, 480);
  mergeHealthData(dir, { date: '2001-02-02', sleep_hrv: [summary({ average_ms: 61,
    captured_at: '2001-02-03T10:00:00+08:00' })] });
  mergeHealthData(dir, { date: '2001-02-03', steps: { total: 90 } });
  assert.equal(day(dir, '2001-02-03').steps.total, 100);
  assert.equal(day(dir, '2001-02-03').sleep_hrv.average_ms, 61);
  assert.equal(day(dir, '2001-02-02').sleep_hrv, undefined);
});

test('invalid HRV cannot erase valid data; unknown baseline stays null; private fields are dropped', () => {
  const stored = normalizeSleepHrv(summary({ route: [1, 2], device_address: 'private' }));
  assert.equal(Object.keys(stored).length, 7);
  for (const invalid of [0, -1, 201, '60', null]) {
    assert.deepEqual(mergeSleepHrv(stored, summary({ average_ms: invalid })), stored);
  }
  for (const invalid of [{ sleep_end: summary().sleep_start }, { source: 'rmssd' },
    { captured_at: summary().sleep_start }, { sleep_start: '2001-01-01T00:00:00Z' }]) {
    assert.equal(normalizeSleepHrv(summary(invalid)), null);
  }
  const missing = normalizeSleepHrv(summary({ baseline_lower_ms: -1, baseline_upper_ms: -1 }));
  assert.equal(missing.baseline_lower_ms, null);
  assert.equal(missing.baseline_upper_ms, null);
  assert.deepEqual(mergeSleepHrv(stored, summary({ captured_at: '2001-02-03T08:00:00+08:00', average_ms: 80 })), stored);
});

test('MCP exposes nightly HRV in dedicated, sleep, all, daily and current reads', () => {
  const dir = directory();
  const wake = new Date(Date.now() - 10000), start = new Date(wake.getTime() - 8 * 3600000);
  const date = formatLocalDate(wake);
  mergeHealthData(dir, { date, sleep_hrv: [summary({ sleep_start: start.toISOString(),
    sleep_end: wake.toISOString(), captured_at: new Date().toISOString() })] });
  for (const data_type of ['sleep_hrv', 'sleep', 'all']) {
    const result = readHealthToolResult(dir, { data_type });
    assert.equal(result.sleep_hrv.length, 1);
    assert.equal(result.sleep_hrv[0].average_ms, 60);
    assert.equal(result.sleep_hrv[0].date, date);
  }
  assert.equal(readHealthToolResult(dir, { data_type: 'current_status' }).latest_sleep_hrv.average_ms, 60);
  assert.equal(readHealthToolResult(dir, { data_type: 'daily_summary' }).summaries[0].sleep_hrv.average_ms, 60);
  assert.deepEqual(readHealthToolResult(directory(), { data_type: 'sleep_hrv' }).sleep_hrv, []);
});
