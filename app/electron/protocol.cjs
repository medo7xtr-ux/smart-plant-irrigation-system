const ALLOWED_SOURCES = new Set(['ARDUINO_SERIAL', 'DEVICE_TOOL']);
const LOW_THRESHOLD = 30;
const HIGH_THRESHOLD = 80;
const STOP_THRESHOLD = 60;
// DHT11 air humidity policy: humid air stops at 65% soil moisture;
// dry air continues until 90% soil moisture.
const AIR_HUMIDITY_HIGH_THRESHOLD = 70;
const AIR_HUMIDITY_DRY_THRESHOLD = 40;
const HUMID_AIR_STOP_THRESHOLD = 65;
const DRY_AIR_STOP_THRESHOLD = 90;
const TOOL_TIMEOUT_MS = 6500;

function parseTimestamp(payload) {
  if (payload.ts) {
    const time = Date.parse(String(payload.ts));
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  if (Number.isFinite(Number(payload.ts_ms))) {
    const time = Number(payload.ts_ms);
    // Arduino millis() is device uptime, so the server stamps arrival time.
    if (time > 1_000_000_000_000 && time < Date.now() + 5 * 60 * 1000) return new Date(time).toISOString();
    if (time >= 0 && time <= 1_000_000_000_000) return new Date().toISOString();
  }
  return new Date().toISOString();
}

function validateReading(payload, expectedSource) {
  const source = expectedSource || String(payload.source || '');
  const value = Number(payload.value ?? payload.moisture);
  if (!ALLOWED_SOURCES.has(source)) return { ok: false, reason: 'SOURCE_NOT_ALLOWED' };
  if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: 'VALUE_OUT_OF_RANGE' };
  if (payload.ts === undefined && payload.ts_ms === undefined) return { ok: false, reason: 'TIMESTAMP_MISSING' };
  const ts = parseTimestamp(payload);
  const timestamp = Date.parse(ts);
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 60 * 1000 || Date.now() - timestamp > 10 * 60 * 1000) return { ok: false, reason: 'STALE_OR_INVALID_TIMESTAMP' };
  return { ok: true, source, value, ts };
}

function readingBand(value) {
  if (value < LOW_THRESHOLD) return 'DRY';
  if (value > HIGH_THRESHOLD) return 'HIGH';
  return 'MEDIUM';
}

function weatherAllowsIrrigation(weather) {
  return !(weather?.reliable === true && weather.isRaining === true);
}

function soilStopThreshold(record) {
  const airHumidity = Number(record?.airHumidity);
  if (!Number.isFinite(airHumidity)) return STOP_THRESHOLD;
  if (airHumidity >= AIR_HUMIDITY_HIGH_THRESHOLD) return HUMID_AIR_STOP_THRESHOLD;
  if (airHumidity <= AIR_HUMIDITY_DRY_THRESHOLD) return DRY_AIR_STOP_THRESHOLD;
  return STOP_THRESHOLD;
}

function telemetryConnectionState(lastReadingAt, lastHeartbeatAt, now = Date.now()) {
  const lastActivity = Math.max(Number(lastReadingAt) || 0, Number(lastHeartbeatAt) || 0);
  return { connected: lastActivity > 0 && now - lastActivity <= TOOL_TIMEOUT_MS, lastActivity, timeoutMs: TOOL_TIMEOUT_MS };
}

function decideAutomaticAction(value, weather, mode = 'AUTO') {
  if (mode === 'FORCED_ON') return { action: 'ON', reason: 'MANUAL_OVERRIDE', blocked: true };
  if (mode === 'FORCED_OFF') return { action: 'OFF', reason: 'MANUAL_OVERRIDE', blocked: true };
  if (value < LOW_THRESHOLD) {
    if (!weatherAllowsIrrigation(weather)) return { action: 'OFF', reason: 'RAIN_GUARD', blocked: false };
    return { action: 'ON', reason: 'LOW_MOISTURE', blocked: false };
  }
  const stopThreshold = soilStopThreshold({ airHumidity: weather?.airHumidity });
  if (value >= stopThreshold) {
    const reason = stopThreshold === HUMID_AIR_STOP_THRESHOLD ? 'MOISTURE_RECOVERED_HUMID_AIR' : stopThreshold === DRY_AIR_STOP_THRESHOLD ? 'MOISTURE_RECOVERED_DRY_AIR' : 'MOISTURE_RECOVERED';
    return { action: 'OFF', reason, blocked: false };
  }
  return { action: 'NO_CHANGE', reason: 'WITHIN_HYSTERESIS', blocked: false };
}

module.exports = { ALLOWED_SOURCES, LOW_THRESHOLD, HIGH_THRESHOLD, STOP_THRESHOLD, AIR_HUMIDITY_HIGH_THRESHOLD, AIR_HUMIDITY_DRY_THRESHOLD, HUMID_AIR_STOP_THRESHOLD, DRY_AIR_STOP_THRESHOLD, TOOL_TIMEOUT_MS, parseTimestamp, validateReading, readingBand, weatherAllowsIrrigation, soilStopThreshold, telemetryConnectionState, decideAutomaticAction };
