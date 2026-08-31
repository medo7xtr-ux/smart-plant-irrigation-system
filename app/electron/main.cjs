const { app, BrowserWindow, dialog } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const {
  ALLOWED_SOURCES,
  LOW_THRESHOLD,
  HIGH_THRESHOLD,
  STOP_THRESHOLD,
  TOOL_TIMEOUT_MS,
  validateReading,
  readingBand,
  weatherAllowsIrrigation,
  soilStopThreshold,
  telemetryConnectionState
} = require('./protocol.cjs');

// Prevent GPU initialization failures on older or virtualized Windows graphics drivers.
app.disableHardwareAcceleration();

const BASE_PORT = 3177;
const MAX_PORT_ATTEMPTS = 12;
const FILE_NAME = 'قرائت الحساسات.json';
const CONTROL_FILE = 'تحكم_المضخة.json';
const WEATHER_FILE = 'حالة_الطقس.json';
const AUDIT_FILE = 'سجل_الأحداث.json';

let serialPort = null;
let serialReconnectTimer = null;
let toolHeartbeatTimer = null;
let server = null;
let serverPort = BASE_PORT;
let mainWindow = null;
let lastToolReadingTime = 0;
let lastToolHeartbeatTime = 0;
let lastArduinoReadingTime = 0;
let lastAcceptedReading = null;
let toolOnline = false;
let serialConnected = false;
let serialPortPath = null;
let serialDeviceName = null;
let serialError = null;
let lastDecisionKey = '';
let pumpCommandQueue = Promise.resolve();
let physicalPumpState = 'UNKNOWN';
let lastPumpAckTime = 0;
let pumpError = null;
let pumpWatchdogTimer = null;
const invalidAuditThrottle = new Map();
const INVALID_AUDIT_COOLDOWN_MS = 10000;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function projectRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'smart-plant.ico')
    : path.join(projectRoot(), 'assets', 'smart-plant.ico');
}

function userDataPath(name) {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function defaultData(name) {
  if (name === CONTROL_FILE) {
    return {
      mode: 'AUTO',
      state: 'OFF',
      lastCommand: 'SYSTEM',
      commandSource: 'SYSTEM',
      reason: 'STARTUP',
      ts: new Date().toISOString()
    };
  }
  if (name === WEATHER_FILE) {
    return {
      city: '',
      condition: 'unknown',
      isRaining: false,
      reliable: false,
      source: '',
      observedAt: null
    };
  }
  if (name === AUDIT_FILE) return { events: [] };
  return { source: 'ARDUINO_SERIAL', zone: 'zone2', deviceId: 'arduino-uno-soil-01', unit: 'percent', records: [] };
}

function dataPath(name = FILE_NAME) {
  const file = userDataPath(name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultData(name), null, 2));
  return file;
}

async function readStored(name) {
  try {
    return JSON.parse(await fsp.readFile(dataPath(name), 'utf8'));
  } catch {
    return defaultData(name);
  }
}

async function writeStored(name, value) {
  const file = dataPath(name);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}



async function appendAudit(event) {
  const stored = await readStored(AUDIT_FILE);
  const control = await readStored(CONTROL_FILE);
  const item = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    time: new Date().toISOString(),
    source: event.source || 'SYSTEM',
    type: event.type || 'SYSTEM_EVENT',
    title: event.title || event.type || 'System event',
    reason: event.reason || '',
    reading: event.reading || null,
    pumpState: event.pumpState || control.state || 'OFF',
    controlMode: event.controlMode || control.mode || 'AUTO'
  };
  stored.events = [item, ...(Array.isArray(stored.events) ? stored.events : [])].slice(0, 500);
  await writeStored(AUDIT_FILE, stored);
  return item;
}

async function sendPumpCommand(state, reason = 'SYSTEM') {
  const desired = state === 'ON' ? 'ON' : 'OFF';
  const current = serialPort;
  if (!current?.isOpen) {
    physicalPumpState = 'OFFLINE';
    pumpError = 'ARDUINO_NOT_CONNECTED';
    return false;
  }
  const command = pumpCommandQueue.then(() => new Promise((resolve, reject) => {
    if (serialPort !== current || !current.isOpen) {
      reject(new Error('ARDUINO_NOT_CONNECTED'));
      return;
    }
    current.write(`PUMP_${desired}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      current.drain((drainError) => drainError ? reject(drainError) : resolve());
    });
  }));
  pumpCommandQueue = command.catch(() => undefined);
  try {
    await command;
    physicalPumpState = `PENDING_${desired}`;
    pumpError = null;
    return true;
  } catch (error) {
    pumpError = error instanceof Error ? error.message : String(error);
    physicalPumpState = 'ERROR';
    void appendAudit({
      source: 'ARDUINO_SERIAL',
      type: 'PUMP_COMMAND_FAILED',
      title: 'تعذر إرسال أمر المضخة إلى Arduino',
      reason: `${desired} · ${reason} · ${pumpError}`,
      pumpState: desired
    });
    return false;
  }
}

async function syncPumpToArduino(reason = 'SYNC_ON_CONNECT') {
  const control = await readStored(CONTROL_FILE);
  await sendPumpCommand(control.state === 'ON' ? 'ON' : 'OFF', reason);
}

async function updateControl(patch) {
  const current = await readStored(CONTROL_FILE);
  const updated = {
    ...current,
    ...patch,
    ts: new Date().toISOString()
  };
  await writeStored(CONTROL_FILE, updated);
  if (updated.state !== current.state || patch.syncPhysical === true) {
    await sendPumpCommand(updated.state, updated.reason || 'CONTROL_UPDATE');
  }
  return updated;
}

async function readWeather() {
  return readStored(WEATHER_FILE);
}


async function applyAutomaticDecision(record, forceAudit = false) {
  if (!record) return;
  const control = await readStored(CONTROL_FILE);
  if (control.mode !== 'AUTO') {
    const shouldAudit = forceAudit || lastDecisionKey !== `blocked:${control.mode}:${record.source}:${readingBand(record.value)}`;
    if (shouldAudit) {
      lastDecisionKey = `blocked:${control.mode}:${record.source}:${readingBand(record.value)}`;
      await appendAudit({
        source: record.source,
        type: 'AUTO_BLOCKED_BY_MANUAL_MODE',
        title: 'تم منع قرار الأتمتة بواسطة الوضع الإجباري',
        reason: `${control.mode} يحافظ على حالة المضخة رغم القراءة ${record.value}%`,
        reading: record,
        pumpState: control.state,
        controlMode: control.mode
      });
    }
    return;
  }

  const weather = await readWeather();
  const band = readingBand(record.value);
  if (record.value < LOW_THRESHOLD) {
    if (!weatherAllowsIrrigation(weather)) {
      const nextKey = `rain:${record.source}:${band}`;
      if (control.state !== 'OFF') await updateControl({ state: 'OFF', lastCommand: 'RAIN_GUARD', commandSource: 'SYSTEM', reason: 'RAIN_GUARD' });
      if (forceAudit || lastDecisionKey !== nextKey) {
        lastDecisionKey = nextKey;
        await appendAudit({
          source: record.source,
          type: 'RAIN_GUARD_SKIPPED_IRRIGATION',
          title: 'تم تجاهل الري بسبب وجود المطر',
          reason: `الطقس الحالي ممطر في ${weather.city || 'الموقع المحدد'} والقراءة ${record.value}%`,
          reading: record,
          pumpState: 'OFF',
          controlMode: 'AUTO'
        });
      }
      return;
    }
    const nextKey = `start:${record.source}:${band}`;
    if (control.state !== 'ON') {
      await updateControl({ state: 'ON', lastCommand: 'AUTO', commandSource: 'SYSTEM', reason: 'LOW_MOISTURE' });
      await appendAudit({
        source: record.source,
        type: 'IRRIGATION_STARTED',
        title: 'بدأ الري بسبب الجفاف',
        reason: `الرطوبة ${record.value}% أقل من حد التشغيل ${LOW_THRESHOLD}% والطقس غير ممطر موثوقاً`,
        reading: record,
        pumpState: 'ON',
        controlMode: 'AUTO'
      });
    } else if (forceAudit || lastDecisionKey !== nextKey) {
      await appendAudit({
        source: record.source,
        type: 'LOW_MOISTURE_CONTINUED',
        title: 'استمرار الري مع وصول قراءة جديدة',
        reason: `الرطوبة ما زالت منخفضة عند ${record.value}%`,
        reading: record,
        pumpState: 'ON',
        controlMode: 'AUTO'
      });
    }
    lastDecisionKey = nextKey;
    return;
  }

  const stopThreshold = soilStopThreshold(record);
  if (record.value >= stopThreshold) {
    const nextKey = `stop:${record.source}:${band}:${stopThreshold}`;
    if (control.state !== 'OFF') {
      await updateControl({ state: 'OFF', lastCommand: 'AUTO', commandSource: 'SYSTEM', reason: stopThreshold === 65 ? 'MOISTURE_RECOVERED_HUMID_AIR' : stopThreshold === 90 ? 'MOISTURE_RECOVERED_DRY_AIR' : 'MOISTURE_RECOVERED' });
      await appendAudit({
        source: record.source,
        type: 'IRRIGATION_STOPPED',
        title: stopThreshold === 65 ? 'تم إيقاف الري عند 65% بسبب ارتفاع رطوبة الجو' : stopThreshold === 90 ? 'استمر الري حتى 90% بسبب جفاف الجو' : 'تم إيقاف المضخة بعد تحسن الرطوبة',
        reason: stopThreshold === 65 ? `إشعار: أُوقِف الري لأن رطوبة التربة بلغت ${record.value}% مع رطوبة جو مرتفعة ${record.airHumidity}% (الحد 65%).` : `الرطوبة ارتفعت إلى ${record.value}% وتجاوزت حد الإيقاف ${stopThreshold}% (رطوبة الجو: ${Number.isFinite(Number(record.airHumidity)) ? `${record.airHumidity}%` : 'غير متاحة'})`,
        reading: record,
        pumpState: 'OFF',
        controlMode: 'AUTO'
      });
    } else if (forceAudit || lastDecisionKey !== nextKey) {
      await appendAudit({
        source: record.source,
        type: 'MOISTURE_STABLE',
        title: 'الرطوبة ضمن النطاق الآمن',
        reason: `القراءة الحالية ${record.value}% والمضخة متوقفة`,
        reading: record,
        pumpState: 'OFF',
        controlMode: 'AUTO'
      });
    }
    lastDecisionKey = nextKey;
  }
}


async function save(payload, expectedSource) {
  const validation = validateReading(payload, expectedSource);
  if (!validation.ok) {
    const invalidSource = expectedSource || payload.source || 'UNKNOWN';
    const invalidKey = `${invalidSource}:${validation.reason}`;
    const now = Date.now();
    const lastAudit = invalidAuditThrottle.get(invalidKey) || 0;
    if (now - lastAudit >= INVALID_AUDIT_COOLDOWN_MS) {
      invalidAuditThrottle.set(invalidKey, now);
      await appendAudit({
        source: invalidSource,
        type: 'INVALID_READING_REJECTED',
        title: 'تم رفض قراءة غير صالحة',
        reason: validation.reason,
        reading: payload
      });
    }
    const error = new Error(validation.reason);
    error.code = validation.reason;
    throw error;
  }

  const { source, value, ts } = validation;
  const file = dataPath();
  let data = await readStored(FILE_NAME);
  const record = {
    ts,
    value: Number(value.toFixed(2)),
    raw: Number.isFinite(Number(payload.raw)) ? Number(payload.raw) : Math.round(value * 10.23),
    deviceId: payload.deviceId || (source === 'DEVICE_TOOL' ? 'spoof-tool-01' : 'arduino-uno-soil-01'),
    calibration: payload.calibration || (source === 'DEVICE_TOOL' ? 'tool-gui-v2' : 'uno-field-calibrated'),
    airTemperature: Number.isFinite(Number(payload.airTemperature)) ? Number(Number(payload.airTemperature).toFixed(1)) : null,
    airHumidity: Number.isFinite(Number(payload.airHumidity)) ? Number(Number(payload.airHumidity).toFixed(1)) : null,
    airUnit: payload.airUnit || 'C/%',
    source
  };
  data.records = Array.isArray(data.records) ? [...data.records, record].slice(-1000) : [record];
  data.updatedAt = record.ts;
  data.source = source;
  await writeStored(FILE_NAME, data);
  lastAcceptedReading = record;
  if (source === 'DEVICE_TOOL') {
    lastToolReadingTime = Date.now();
    markToolOnline();
  } else if (source === 'ARDUINO_SERIAL') {
    lastArduinoReadingTime = Date.now();
  }
  await applyAutomaticDecision(record);
  return record;
}

function markToolOnline() {
  const wasOffline = !toolOnline;
  toolOnline = true;
  // DEVICE_TOOL owns telemetry while active, but keep Serial open for pump commands and ACKs.
  lastToolHeartbeatTime = Date.now();
  if (wasOffline) {
    void appendAudit({ source: 'DEVICE_TOOL', type: 'TOOL_RECONNECTED', title: 'تمت إعادة اتصال أداة Telemetry', reason: 'وصلت heartbeat أو قراءة جديدة من DEVICE_TOOL' });
  }
}

async function markToolOffline() {
  if (!toolOnline) return;
  toolOnline = false;
  await appendAudit({ source: 'DEVICE_TOOL', type: 'TOOL_DISCONNECTED', title: 'فقد اتصال أداة Telemetry', reason: 'لم تصل heartbeat أو قراءة جديدة خلال المهلة المحددة' });
  // Arduino remains connected; only telemetry ownership returns after tool timeout.
  if (!serialPort?.isOpen && !serialPort?.opening) void connectArduino();
}

function closeSerial() {
  if (!serialPort) return;
  const current = serialPort;
  serialPort = null;
  serialConnected = false;
  try {
    if (current.isOpen) current.close();
  } catch {
    // Ignore close errors while shutting down or reconnecting.
  }
}

async function connectArduino() {
  if (serialPort?.isOpen || serialPort?.opening) return true;
  try {
    const ports = await SerialPort.list();
    const wanted = process.env.SMART_PLANT_COM_PORT;
    const detected = ports.find((port) => /arduino|wch|usb serial|ch340|usb-serial/i.test(
      `${port.manufacturer || ''} ${port.friendlyName || ''} ${port.pnpId || ''}`
    ));
    const candidate = wanted || detected?.path || (ports.length === 1 ? ports[0].path : null);
    if (!candidate) {
      serialError = 'لم يتم العثور على منفذ Arduino';
      serialConnected = false;
      return false;
    }

    const portInfo = ports.find((port) => port.path === candidate);
    const next = new SerialPort({ path: candidate, baudRate: 115200, autoOpen: true });
    const parser = next.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => {
      const normalized = String(line).trim();
      if (normalized.startsWith('PUMP_ACK:')) {
        const acknowledged = normalized.slice('PUMP_ACK:'.length);
        if (acknowledged === 'ON' || acknowledged === 'OFF') {
          physicalPumpState = acknowledged;
          lastPumpAckTime = Date.now();
          pumpError = null;
        }
        return;
      }
      // Suppress sensor telemetry only; pump acknowledgements above remain accepted.
      if (toolOnline) return;
      try {
        const payload = JSON.parse(normalized);
        if (payload?.type === 'pump_ack') {
          const acknowledged = payload.state === 'ON' ? 'ON' : payload.state === 'OFF' ? 'OFF' : null;
          if (acknowledged) {
            physicalPumpState = acknowledged;
            lastPumpAckTime = Date.now();
            pumpError = null;
          }
          return;
        }
        payload.source = 'ARDUINO_SERIAL';
        void save(payload, 'ARDUINO_SERIAL').catch((error) => {
          serialError = error instanceof Error ? error.message : String(error);
        });
      } catch {
        serialError = 'وصلت رسالة Arduino غير صالحة بصيغة JSON';
        void appendAudit({ source: 'ARDUINO_SERIAL', type: 'INVALID_MESSAGE_REJECTED', title: 'تم رفض رسالة Arduino غير صالحة', reason: serialError });
      }
    });
    next.on('open', () => {
      serialConnected = true;
      serialError = null;
      void syncPumpToArduino();
    });
    next.on('error', (error) => {
      serialError = error instanceof Error ? error.message : String(error);
      if (serialPort === next) closeSerial();
    });
    next.on('close', () => {
      if (serialPort === next) {
        serialPort = null;
        serialConnected = false;
      }
    });
    serialPort = next;
    serialPortPath = candidate;
    serialDeviceName = portInfo?.manufacturer || portInfo?.friendlyName || portInfo?.pnpId || 'Arduino / USB Serial';
    return true;
  } catch (error) {
    serialError = error instanceof Error ? error.message : String(error);
    closeSerial();
    return false;
  }
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(JSON.stringify(value));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => body += chunk);
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function currentHealth() {
  const data = await readStored(FILE_NAME);
  const latest = Array.isArray(data.records) ? data.records.at(-1) : null;
  const latestTime = latest?.ts ? Date.parse(latest.ts) : NaN;
  const latestSource = latest?.source || null;
  const recent = Number.isFinite(latestTime) && Date.now() - latestTime <= 10 * 60 * 1000;
  const sourceValid = !latest || ALLOWED_SOURCES.has(latestSource);
  const rangeValid = !latest || (Number.isFinite(Number(latest.value)) && latest.value >= 0 && latest.value <= 100);
  const toolFlow = latestSource === 'DEVICE_TOOL' ? toolOnline && Date.now() - Math.max(lastToolReadingTime, lastToolHeartbeatTime) <= TOOL_TIMEOUT_MS : true;
  return {
    checkedAt: new Date().toISOString(),
    latestSource,
    latestReadingAt: latest?.ts || null,
    checks: {
      messageFormat: Boolean(latest && typeof latest.value === 'number'),
      range: rangeValid,
      source: sourceValid,
      freshness: recent,
      arduinoConnection: serialConnected,
      sequentialFlow: Array.isArray(data.records) && data.records.length >= 2,
      telemetryHeartbeat: latestSource !== 'DEVICE_TOOL' || toolFlow,
      noFallback: true,
      decisionPath: Boolean(latest && (latestSource === 'ARDUINO_SERIAL' || latestSource === 'DEVICE_TOOL'))
    },
    note: latestSource === 'DEVICE_TOOL' ? 'المصدر الحالي DEVICE_TOOL وليس Arduino حقيقياً.' : serialConnected ? 'المصدر ARDUINO_SERIAL.' : 'لا يوجد اتصال Arduino موثوق حالياً.'
  };
}

function createServer(publicRoot) {
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${serverPort}`);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (request.method === 'OPTIONS') return sendJson(response, 204, {});

      if (requestUrl.pathname === '/api/arduino/readings') {
        return sendJson(response, 200, await readStored(FILE_NAME));
      }
      if (requestUrl.pathname === '/api/arduino/status') {
        return sendJson(response, 200, {
          connected: serialConnected,
          port: serialPortPath,
          device: serialDeviceName,
          lastReadingAt: lastArduinoReadingTime ? new Date(lastArduinoReadingTime).toISOString() : null,
          pumpState: physicalPumpState,
          lastPumpAckAt: lastPumpAckTime ? new Date(lastPumpAckTime).toISOString() : null,
          pumpError,
          error: serialError
        });
      }
      if (requestUrl.pathname === '/api/control/status') {
        return sendJson(response, 200, {
          ...(await readStored(CONTROL_FILE)),
          physicalPumpState,
          pumpAckAt: lastPumpAckTime ? new Date(lastPumpAckTime).toISOString() : null,
          pumpError
        });
      }
      if (requestUrl.pathname === '/api/control/set' && request.method === 'POST') {
        const cmd = JSON.parse(await readRequestBody(request));
        const mode = ['AUTO', 'FORCED_ON', 'FORCED_OFF'].includes(cmd.mode) ? cmd.mode : null;
        if (!mode) return sendJson(response, 400, { error: 'INVALID_CONTROL_MODE' });
        const state = mode === 'FORCED_ON' ? 'ON' : mode === 'FORCED_OFF' ? 'OFF' : (cmd.state === 'ON' ? 'ON' : 'OFF');
        const updated = await updateControl({
          mode,
          state,
          lastCommand: mode === 'AUTO' ? 'AUTO_RESET' : 'USER',
          commandSource: 'USER',
          reason: mode === 'AUTO' ? 'AUTO_RESUME_REQUESTED' : 'MANUAL_OVERRIDE'
        });
        await appendAudit({
          source: 'SYSTEM',
          type: mode === 'AUTO' ? 'AUTO_MODE_SELECTED' : 'MANUAL_CONTROL_CHANGED',
          title: mode === 'AUTO' ? 'العودة إلى الأتمتة' : mode === 'FORCED_ON' ? 'تشغيل إجباري للمضخة' : 'إيقاف إجباري للمضخة',
          reason: `اختار المستخدم الوضع ${mode}`,
          pumpState: state,
          controlMode: mode
        });
        if (mode === 'AUTO' && lastAcceptedReading) await applyAutomaticDecision(lastAcceptedReading, true);
        return sendJson(response, 200, { success: true, control: await readStored(CONTROL_FILE) });
      }
      if (requestUrl.pathname === '/api/tool/inject' && request.method === 'POST') {
        const payload = JSON.parse(await readRequestBody(request));
        markToolOnline();
        payload.source = 'DEVICE_TOOL';
        const record = await save(payload, 'DEVICE_TOOL');
        return sendJson(response, 200, { success: true, status: 'continuous_active', record, telemetry: telemetryStatus() });
      }
      if (requestUrl.pathname === '/api/tool/heartbeat' && request.method === 'POST') {
        markToolOnline();
        return sendJson(response, 200, { success: true, status: 'connected', telemetry: telemetryStatus() });
      }
      if (requestUrl.pathname === '/api/tool/status') {
        return sendJson(response, 200, telemetryStatus());
      }
      if (requestUrl.pathname === '/api/weather/state' && request.method === 'GET') {
        return sendJson(response, 200, await readWeather());
      }
      if (requestUrl.pathname === '/api/weather/state' && request.method === 'POST') {
        const weather = JSON.parse(await readRequestBody(request));
        const normalized = {
          city: String(weather.city || ''),
          condition: String(weather.condition || 'unknown'),
          isRaining: weather.isRaining === true,
          reliable: weather.reliable === true,
          source: String(weather.source || 'Open-Meteo'),
          observedAt: weather.observedAt || new Date().toISOString(),
          temperature: Number.isFinite(Number(weather.temperature)) ? Number(weather.temperature) : undefined,
          humidity: Number.isFinite(Number(weather.humidity)) ? Number(weather.humidity) : undefined,
          daily: Array.isArray(weather.daily) ? weather.daily.slice(0, 7) : []
        };
        await writeStored(WEATHER_FILE, normalized);
        await appendAudit({ source: 'WEATHER_API', type: 'WEATHER_UPDATED', title: 'تم تحديث حالة الطقس', reason: `${normalized.city || 'الموقع'} · ${normalized.condition} · ${normalized.isRaining ? 'مطر' : 'لا مطر'}` });
        if (lastAcceptedReading) await applyAutomaticDecision(lastAcceptedReading, true);
        return sendJson(response, 200, normalized);
      }
      if (requestUrl.pathname === '/api/audit/events' && request.method === 'DELETE') {
        const stored = await readStored(AUDIT_FILE);
        const source = requestUrl.searchParams.get('source');
        const events = Array.isArray(stored.events) ? stored.events : [];
        await writeStored(AUDIT_FILE, { events: source ? events.filter((event) => event.source !== source) : [] });
        return sendJson(response, 200, { success: true });
      }
      if (requestUrl.pathname === '/api/audit/events') {
        const stored = await readStored(AUDIT_FILE);
        const source = requestUrl.searchParams.get('source');
        const events = Array.isArray(stored.events) ? stored.events : [];
        return sendJson(response, 200, { events: source ? events.filter((event) => event.source === source) : events });
      }
      if (requestUrl.pathname === '/api/health/summary') {
        return sendJson(response, 200, await currentHealth());
      }

      let relative = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
      if (relative.includes('..')) relative = '/index.html';
      let file = path.join(publicRoot, relative);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(publicRoot, 'index.html');
      response.writeHead(200, { 'Content-Type': contentType(file) });
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: detail });
    }
  });
}

function telemetryStatus() {
  const connection = telemetryConnectionState(lastToolReadingTime, lastToolHeartbeatTime);
  const connected = toolOnline && connection.connected;
  if (!connected && toolOnline) void markToolOffline();
  return {
    connected,
    source: 'DEVICE_TOOL',
    lastReadingAt: lastToolReadingTime ? new Date(lastToolReadingTime).toISOString() : null,
    lastHeartbeatAt: lastToolHeartbeatTime ? new Date(lastToolHeartbeatTime).toISOString() : null,
    timeoutMs: TOOL_TIMEOUT_MS
  };
}

async function startServer() {
  const publicRoot = path.join(projectRoot(), 'dist', 'public');
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const candidatePort = BASE_PORT + attempt;
    const candidateServer = createServer(publicRoot);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          candidateServer.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          candidateServer.removeListener('error', onError);
          resolve();
        };
        candidateServer.once('error', onError);
        candidateServer.once('listening', onListening);
        candidateServer.listen(candidatePort, '127.0.0.1');
      });
      server = candidateServer;
      serverPort = candidatePort;
      return serverPort;
    } catch (error) {
      try { candidateServer.close(); } catch {}
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`لا يوجد منفذ محلي متاح ضمن المجال ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}`);
}

async function shutdown() {
  if (serialReconnectTimer) clearInterval(serialReconnectTimer);
  if (toolHeartbeatTimer) clearInterval(toolHeartbeatTimer);
  if (pumpWatchdogTimer) clearInterval(pumpWatchdogTimer);
  await sendPumpCommand('OFF', 'SHUTDOWN');
  closeSerial();
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      await startServer();
      mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 640,
        show: false,
        icon: iconPath(),
        webPreferences: { contextIsolation: true, sandbox: true }
      });
      mainWindow.on('closed', () => { mainWindow = null; });
      mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        console.error(`Smart Plant load failed: ${errorCode} ${errorDescription}`);
        mainWindow?.show();
      });
      await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
      mainWindow.once('ready-to-show', () => mainWindow.show());
      void connectArduino();
      serialReconnectTimer = setInterval(() => {
        if (!toolOnline && (!serialPort || !serialPort.isOpen)) void connectArduino();
      }, 5000);
      toolHeartbeatTimer = setInterval(() => {
        if (toolOnline && Date.now() - Math.max(lastToolHeartbeatTime, lastToolReadingTime) > TOOL_TIMEOUT_MS) void markToolOffline();
      }, 1000);
      pumpWatchdogTimer = setInterval(async () => {
        if (!serialPort?.isOpen) return;
        const control = await readStored(CONTROL_FILE);
        await sendPumpCommand(control.state === 'ON' ? 'ON' : 'OFF', 'WATCHDOG_HEARTBEAT');
      }, 5000);
    } catch (error) {
      console.error('Smart Plant startup failed', error);
      const detail = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox('Smart Plant لم يبدأ', `تعذر تشغيل التطبيق.\n\n${detail}`);
      await shutdown();
      app.quit();
    }
  });

  app.on('window-all-closed', async () => {
    await shutdown();
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { readingBand, validateReading };
