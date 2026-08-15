const nodeMap = new Map();
const nodeHistoryMap = new Map();
const serviceStateMap = new Map();
const MAX_NODE_HISTORY = 300;
const MAX_SOURCE_RAW_BYTES = 120000;
const MAX_HISTORY_RAW_BYTES = 32000;
const EPD_LOW_BATTERY_PERCENT = 15;
const EPD_ALARM_TEMP_C = 40;
const EPD_OFFLINE_AFTER_MS = 30 * 60 * 1000;
const EPD_SIGNAL_RSRP_MIN_DBM = -120;
const EPD_SIGNAL_RSRP_MAX_DBM = -75;

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const key of keys) {
      out[key] = stableNormalize(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

function safeStableStringify(value, maxBytes) {
  const str = stableStringify(value);
  if (str.length <= maxBytes) {
    return str;
  }
  return str.slice(0, maxBytes);
}

function normalizeStringId(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function extractMacLast4(value) {
  if (!value) return "";
  const compact = String(value)
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "");
  if (compact.length < 4) return "";
  return compact.slice(-4);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeVoltage(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return Math.abs(n) > 20 ? n / 1000 : n;
}

function normalizeBool(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return ["1", "true", "yes", "y", "on", "motion", "movement", "active", "alarm", "abnormal"].includes(text);
}

function normalizeFirmwareStatus(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  if (!text) return null;
  if (text === "BOOT") return "BOOT";
  if (text === "NORMAL" || text === "OK") return "NORMAL";
  if (text === "MOTION" || text === "MOVE" || text === "MOVEMENT") return "MOTION";
  if (text === "OFFLINE" || text === "OFF") return "OFFLINE";
  if (text === "LOWBAT" || text === "LOWBATTERY" || text === "LOW") return "LOWBAT";
  if (text === "ALARM" || text === "ALERT" || text === "ERROR" || text === "ERR") return "ALARM";
  return null;
}

function boolOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeBool(value);
}

function parseVersionParts(value) {
  if (value === null || value === undefined) return null;
  const parts = String(value).match(/\d+/g);
  if (!parts || !parts.length) return null;
  return parts.map((part) => Number(part));
}

function compareVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return null;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const leftPart = left[i] ?? 0;
    const rightPart = right[i] ?? 0;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function isBootLikeWake(value) {
  const wake = String(value ?? "").trim().toLowerCase();
  return wake === "boot" || wake === "startup" || wake === "power";
}

function detectHistoricalReplay(prev, incoming, now, isDeviceSource) {
  if (!prev || !Object.keys(prev).length) {
    return { replay: false, reason: null };
  }

  if (prev.restoredFromStorage && isDeviceSource) {
    return { replay: false, reason: null };
  }

  const firmwareCompare = compareVersions(incoming.firmwareVersion, prev.firmwareVersion);
  if (firmwareCompare === null || firmwareCompare >= 0) {
    return { replay: false, reason: null };
  }

  if (isBootLikeWake(incoming.wakeReason)) {
    return { replay: false, reason: null };
  }

  const prevLastSeenAt = Number(prev.lastSeenAt);
  const prevSnapshotAgeMs = Number.isFinite(prevLastSeenAt) ? now - prevLastSeenAt : null;
  const freshPreviousSnapshot =
    prevSnapshotAgeMs === null ||
    (prevSnapshotAgeMs >= 0 && prevSnapshotAgeMs <= 10 * 60 * 1000);

  if (freshPreviousSnapshot || isBootLikeWake(prev.wakeReason)) {
    return { replay: true, reason: "firmware_regression" };
  }

  return { replay: false, reason: null };
}

function signalPercentFromRssi(value) {
  const rssi = toNumber(value);
  if (rssi === null) return 0;
  if (rssi <= EPD_SIGNAL_RSRP_MIN_DBM) return 0;
  if (rssi >= EPD_SIGNAL_RSRP_MAX_DBM) return 100;
  return Math.round(
    ((rssi - EPD_SIGNAL_RSRP_MIN_DBM) * 100) /
      (EPD_SIGNAL_RSRP_MAX_DBM - EPD_SIGNAL_RSRP_MIN_DBM)
  );
}

function baseNodeIdForAsset(nodeId) {
  const text = String(nodeId || "")
    .trim()
    .toUpperCase();
  if (!text) return "UNKNOWN";
  return text.replace(/-(MQTT|COAP)-(DTLS|TLS|PLAIN)$/i, "");
}

function maintenanceKeyForNode(nodeId) {
  return baseNodeIdForAsset(nodeId).toLowerCase();
}

function normalizeServiceState(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  if (!text) return null;
  if (text === "NONE" || text === "CLEAR") return "NONE";
  if (text === "REQUIRED" || text === "REQ" || text === "FIX" || text === "SERVICE") return "REQUIRED";
  if (text === "DONE" || text === "OK" || text === "SERVICED" || text === "ACK") return "DONE";
  return null;
}

function serviceLabelForState(state) {
  switch (normalizeServiceState(state)) {
    case "REQUIRED":
      return "FIX";
    case "DONE":
      return "OK";
    case "NONE":
    default:
      return "";
  }
}

function serviceStateForNode(nodeId, fallbackState = null, fallbackCommandId = null) {
  const key = maintenanceKeyForNode(nodeId);
  const stored = serviceStateMap.get(key);
  if (stored) return stored;
  const normalized = normalizeServiceState(fallbackState);
  return {
    nodeId: key,
    state: normalized || "NONE",
    commandId: String(fallbackCommandId || ""),
    updatedAt: null
  };
}

function setNodeServiceState(nodeId, state, options = {}) {
  const key = maintenanceKeyForNode(nodeId);
  const normalized = normalizeServiceState(state) || "NONE";
  const commandId = String(options.commandId ?? "");
  const updatedAt = Number(options.updatedAt) || Date.now();
  const record = { nodeId: key, state: normalized, commandId, updatedAt };
  serviceStateMap.set(key, record);

  for (const node of nodeMap.values()) {
    if (maintenanceKeyForNode(node.nodeId) !== key) continue;
    node.serviceState = normalized;
    node.serviceCommandId = commandId;
    node.serviceUpdatedAt = updatedAt;
    node.epaperScreen = buildEpaperScreenModel(node, Date.now());
  }

  return record;
}

function getNodeServiceCommand(nodeId) {
  const record = serviceStateForNode(nodeId);
  if (record.state !== "DONE" || !record.commandId) {
    return null;
  }
  return {
    v: 1,
    cmd: "service_ack",
    state: "DONE",
    commandId: record.commandId
  };
}

function resolveAssetId(node) {
  const rawDevice = node?.raw?.device || node?.raw?.asset_id || node?.raw?.assetId;
  const label = String(rawDevice || "").trim();
  if (label) return label.toUpperCase();
  return `ISTAG-${baseNodeIdForAsset(node?.nodeId)}`;
}

function epaperFreshness(seenAt, now) {
  if (!seenAt) return { online: false, label: "IDLE", ageMs: null };
  const ageMs = Math.max(0, now - seenAt);
  if (ageMs <= 5 * 60 * 1000) return { online: true, label: "LIVE", ageMs };
  if (ageMs <= EPD_OFFLINE_AFTER_MS) return { online: true, label: "QUIET", ageMs };
  return { online: false, label: "STALE", ageMs };
}

function epaperStatusFromTelemetry(node, freshness) {
  const firmwareStatus = normalizeFirmwareStatus(node?.status);
  const statusText = String(node?.status || "")
    .trim()
    .toLowerCase();
  const temperature = toNumber(node?.temperature);
  const battery = toNumber(node?.battery);
  const batteryPresent = boolOrNull(node?.batteryPresent);
  const batteryPresenceValid = boolOrNull(node?.batteryPresenceValid);
  const confirmedBattery =
    batteryPresenceValid === true ? batteryPresent === true : batteryPresent !== false && battery !== null;
  const motionEvent =
    firmwareStatus === "MOTION" ||
    normalizeBool(node?.motionEvent) ||
    normalizeBool(node?.assetEvent) ||
    String(node?.wakeReason || "")
      .trim()
      .toLowerCase() === "motion";
  const alarmActive =
    firmwareStatus === "ALARM" ||
    normalizeBool(node?.alarmActive) ||
    normalizeBool(node?.abnormalEvent) ||
    normalizeBool(node?.urgent) ||
    ["alert", "alarm", "error", "err"].includes(statusText) ||
    (temperature !== null && temperature >= EPD_ALARM_TEMP_C);

  if (alarmActive) return "ALARM";
  if (firmwareStatus) return firmwareStatus;
  if (!freshness.online) return "OFFLINE";
  if (battery !== null && confirmedBattery && battery < EPD_LOW_BATTERY_PERCENT) return "LOWBAT";
  if (motionEvent) return "MOTION";
  return "NORMAL";
}

function epaperShortStatus(status) {
  switch (status) {
    case "BOOT":
      return "BOOT";
    case "MOTION":
      return "MOVE";
    case "OFFLINE":
      return "OFF";
    case "LOWBAT":
      return "LOW";
    case "ALARM":
      return "ALRM";
    case "NORMAL":
    default:
      return "NORM";
  }
}

function buildEpaperScreenModel(node, now = Date.now()) {
  const seenAt = Number(node?.lastDeviceSeenAt ?? node?.lastSeenAt ?? 0) || 0;
  const freshness = epaperFreshness(seenAt, now);
  const status = epaperStatusFromTelemetry(node, freshness);
  const temperature = toNumber(node?.temperature);
  const humidity = toNumber(node?.humidity);
  const battery = toNumber(node?.battery);
  const voltage = toNumber(node?.voltage);
  const rssi = toNumber(node?.rssi);
  const vibrationMg = toNumber(node?.vibrationMg);
  const shockG = toNumber(node?.shockG);
  const tiltDeg = toNumber(node?.tiltDeg);
  const accelXMg = toNumber(node?.accelXMg);
  const accelYMg = toNumber(node?.accelYMg);
  const accelZMg = toNumber(node?.accelZMg);
  const batteryPresent = boolOrNull(node?.batteryPresent);
  const batteryPowered = boolOrNull(node?.batteryPowered);
  const charging = boolOrNull(node?.charging);
  const chargeComplete = boolOrNull(node?.chargeComplete);
  const externalPowerPresent = boolOrNull(node?.externalPowerPresent);
  const pwrOnly = boolOrNull(node?.pwrOnly);
  const powerValid = boolOrNull(node?.powerValid);
  const powerSourceValid = boolOrNull(node?.powerSourceValid);
  const epaperRefreshLastResult = toNumber(node?.epaperRefreshLastResult);
  const epaperDisplaySampleSeq = toNumber(node?.epaperDisplaySampleSeq);
  const serviceRecord = serviceStateForNode(
    node?.nodeId,
    node?.serviceState,
    node?.serviceCommandId
  );
  const serviceState = normalizeServiceState(serviceRecord.state) || "NONE";
  const motionEvent =
    status === "MOTION" ||
    normalizeBool(node?.motionEvent) ||
    normalizeBool(node?.assetEvent) ||
    String(node?.wakeReason || "")
      .trim()
      .toLowerCase() === "motion";
  const shockMg =
    vibrationMg !== null ? Math.round(vibrationMg) : shockG !== null ? Math.round(shockG * 1000) : null;
  const uploadOk = freshness.online && epaperRefreshLastResult !== null ? epaperRefreshLastResult >= 0 : freshness.online;

  return {
    assetId: resolveAssetId(node),
    status,
    statusShort: epaperShortStatus(status),
    online: freshness.online,
    freshness: freshness.label,
    uploadOk,
    displayedSampleSeq: epaperDisplaySampleSeq,
    firmwareVersion: node?.firmwareVersion ?? null,
    epaperStatus: node?.epaperStatus ?? null,
    serviceState,
    serviceLabel: serviceLabelForState(serviceState),
    serviceRequired: serviceState === "REQUIRED",
    serviceDone: serviceState === "DONE",
    serviceCommandId: serviceRecord.commandId || null,
    env: {
      valid: temperature !== null || humidity !== null,
      temperatureC: temperature,
      humidityRh: humidity
    },
    motion: {
      event: motionEvent,
      valid:
        shockMg !== null ||
        tiltDeg !== null ||
        accelXMg !== null ||
        accelYMg !== null ||
        accelZMg !== null,
      accelXMg,
      accelYMg,
      accelZMg,
      shockMg,
      tiltDeg
    },
    power: {
      valid: powerValid === null ? battery !== null || voltage !== null : powerValid,
      source: node?.powerSource ?? null,
      sourceValid: powerSourceValid,
      batteryPercent: battery,
      batteryMv: voltage !== null ? Math.round(voltage * 1000) : null,
      batteryPresent,
      batteryPowered,
      charging,
      chargeComplete,
      externalPowerPresent,
      pwrOnly
    },
    network: {
      valid: rssi !== null,
      rssiDbm: rssi,
      signalPercent: signalPercentFromRssi(rssi)
    },
    uplink: {
      mode: node?.mode ?? null,
      wakeReason: node?.wakeReason ?? null,
      cachedRecords: node?.cachedRecords ?? null,
      sampleSeq: node?.sampleSeq ?? null,
      firmwareVersion: node?.firmwareVersion ?? null,
      lastSeenAt: seenAt || null,
      ageMs: freshness.ageMs
    }
  };
}

function withDerivedEpaperScreen(node, now = Date.now()) {
  if (!node) return node;
  return {
    ...node,
    epaperScreen: node.epaperScreen || buildEpaperScreenModel(node, now)
  };
}

function sanitizeLat(value) {
  const n = toNumber(value);
  if (n === null) return null;
  if (n === 0) return null;
  if (n < -90 || n > 90) return null;
  return n;
}

function sanitizeLng(value) {
  const n = toNumber(value);
  if (n === null) return null;
  if (n === 0) return null;
  if (n < -180 || n > 180) return null;
  return n;
}

function readPath(payload, path) {
  let current = payload;

  for (const segment of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }

  return { found: true, value: current };
}

function pickCoordinate(payload, candidates, sanitizer) {
  for (const path of candidates) {
    const { found, value } = readPath(payload, path);
    if (found) {
      return {
        provided: true,
        value: sanitizer(value)
      };
    }
  }

  return { provided: false, value: null };
}

function extractCoordinates(payload) {
  const latCandidates = [
    ["lat"],
    ["latitude"],
    ["gps_lat"],
    ["gpsLat"],
    ["gps", "lat"],
    ["gps", "latitude"],
    ["location", "lat"],
    ["location", "latitude"],
    ["position", "lat"],
    ["position", "latitude"]
  ];
  const lngCandidates = [
    ["lng"],
    ["lon"],
    ["longitude"],
    ["gps_lng"],
    ["gps_lon"],
    ["gpsLon"],
    ["gpsLng"],
    ["gps", "lng"],
    ["gps", "lon"],
    ["gps", "longitude"],
    ["location", "lng"],
    ["location", "lon"],
    ["location", "longitude"],
    ["position", "lng"],
    ["position", "lon"],
    ["position", "longitude"]
  ];

  let lat = pickCoordinate(payload, latCandidates, sanitizeLat);
  let lng = pickCoordinate(payload, lngCandidates, sanitizeLng);

  // Support a compact "gps": "lat,lng" string format.
  if ((!lat.provided || !lng.provided) && typeof payload.gps === "string") {
    const parts = payload.gps.split(",").map((x) => x.trim());
    if (parts.length >= 2) {
      if (!lat.provided) {
        lat = { provided: true, value: sanitizeLat(parts[0]) };
      }
      if (!lng.provided) {
        lng = { provided: true, value: sanitizeLng(parts[1]) };
      }
    }
  }

  return {
    lat: lat.value,
    lng: lng.value,
    latProvided: lat.provided,
    lngProvided: lng.provided
  };
}

function pickFirst(payload, paths) {
  for (const path of paths) {
    const { found, value } = readPath(payload, path);
    if (found) {
      return value;
    }
  }
  return null;
}

function resolveNodeId(payload, fallbackNodeId) {
  const direct =
    payload.id ??
    payload.nodeId ??
    payload.node_id ??
    payload.deviceId ??
    payload.device_id ??
    payload.mac_last4 ??
    payload.macLast4 ??
    extractMacLast4(payload.mac);

  const normalizedDirect = normalizeStringId(direct);
  if (normalizedDirect) return normalizedDirect;

  const normalizedFallback = normalizeStringId(fallbackNodeId);
  if (normalizedFallback) return normalizedFallback;

  return "unknown";
}

function normalizePayload(payload, fallbackNodeId) {
  const sourcePayload = payload && typeof payload === "object" ? payload : {};
  const nodeId = resolveNodeId(sourcePayload, fallbackNodeId);
  const { lat, lng, latProvided, lngProvided } = extractCoordinates(sourcePayload);
  return {
    nodeId,
    payloadVersion: sourcePayload.v ?? sourcePayload.schema ?? null,
    temperature: sourcePayload.temperature ?? sourcePayload.t ?? sourcePayload.temp ?? sourcePayload.temp_c ?? sourcePayload.tempC ?? null,
    humidity: sourcePayload.humidity ?? sourcePayload.h ?? sourcePayload.humi ?? sourcePayload.hum ?? null,
    battery:
      sourcePayload.battery ??
      sourcePayload.bat ??
      sourcePayload.battery_pct ??
      sourcePayload.batteryPercent ??
      null,
    rssi: sourcePayload.rssi ?? sourcePayload.signal_dbm ?? null,
    voltage: normalizeVoltage(sourcePayload.voltage ?? sourcePayload.vbat ?? sourcePayload.vbat_v ?? sourcePayload.mv ?? sourcePayload.battery_mv),
    co2: sourcePayload.co2 ?? null,
    pm25: sourcePayload.pm25 ?? null,
    status: sourcePayload.status ?? sourcePayload.state ?? null,
    serviceState: pickFirst(sourcePayload, [
      ["svc"],
      ["service"],
      ["service_state"],
      ["serviceState"],
      ["maintenance"],
      ["maintenance_state"],
      ["maintenanceState"]
    ]),
    serviceCommandId: pickFirst(sourcePayload, [
      ["svcid"],
      ["service_command_id"],
      ["serviceCommandId"],
      ["commandId"],
      ["command_id"]
    ]),
    events: sourcePayload.events ?? null,
    urgent: sourcePayload.urgent ?? null,
    mode: sourcePayload.mode ?? null,
    wakeReason: sourcePayload.wake ?? sourcePayload.wake_reason ?? sourcePayload.wakeReason ?? null,
    motionEvent: sourcePayload.mot ?? sourcePayload.motion_event ?? sourcePayload.motionEvent ?? null,
    assetEvent: sourcePayload.evt ?? sourcePayload.asset_event ?? sourcePayload.assetEvent ?? null,
    alarmActive: sourcePayload.alarm ?? sourcePayload.alarm_active ?? sourcePayload.alarmActive ?? null,
    abnormalEvent: sourcePayload.abn ?? sourcePayload.abnormal_event ?? sourcePayload.abnormalEvent ?? null,
    sustainedMotion: sourcePayload.msus ?? sourcePayload.sustained_motion ?? sourcePayload.sustainedMotion ?? null,
    motionWindowIrqCount:
      sourcePayload.mw ?? sourcePayload.motion_window_irq_count ?? sourcePayload.motionWindowIrqCount ?? null,
    motionDeltaMg: sourcePayload.md ?? sourcePayload.motion_delta_mg ?? sourcePayload.motionDeltaMg ?? null,
    motionWindowSeconds: sourcePayload.ms ?? sourcePayload.motion_window_seconds ?? sourcePayload.motionWindowSeconds ?? null,
    sampleSeq: sourcePayload.seq ?? sourcePayload.sample_seq ?? sourcePayload.sampleSeq ?? null,
    firmwareVersion: pickFirst(sourcePayload, [
      ["firmware_version"],
      ["firmwareVersion"],
      ["fw"],
      ["version"],
      ["firmware", "version"]
    ]),
    cachedRecords: sourcePayload.cache ?? sourcePayload.cached_records ?? sourcePayload.cachedRecords ?? null,
    powerSource: sourcePayload.ps ?? sourcePayload.power_source ?? sourcePayload.powerSource ?? null,
    powerSourceValid: sourcePayload.psv ?? sourcePayload.power_source_valid ?? sourcePayload.powerSourceValid ?? null,
    batteryPresent: sourcePayload.bp ?? sourcePayload.battery_present ?? sourcePayload.batteryPresent ?? null,
    batteryPresenceValid:
      sourcePayload.bpv ?? sourcePayload.battery_presence_valid ?? sourcePayload.batteryPresenceValid ?? null,
    batteryPowered: sourcePayload.bon ?? sourcePayload.battery_powered ?? sourcePayload.batteryPowered ?? null,
    charging: sourcePayload.chg ?? sourcePayload.charging ?? null,
    chargeComplete: sourcePayload.full ?? sourcePayload.charge_complete ?? sourcePayload.chargeComplete ?? null,
    pwrOnly: sourcePayload.po ?? sourcePayload.pwr_only ?? sourcePayload.pwrOnly ?? null,
    externalPowerPresent:
      sourcePayload.ext ?? sourcePayload.external_power_present ?? sourcePayload.externalPowerPresent ?? null,
    powerValid: sourcePayload.pwr ?? sourcePayload.power_valid ?? sourcePayload.powerValid ?? null,
    accelXMg: sourcePayload.ax ?? sourcePayload.accel_x_mg ?? sourcePayload.accelXMg ?? null,
    accelYMg: sourcePayload.ay ?? sourcePayload.accel_y_mg ?? sourcePayload.accelYMg ?? null,
    accelZMg: sourcePayload.az ?? sourcePayload.accel_z_mg ?? sourcePayload.accelZMg ?? null,
    vibrationMg: sourcePayload.vib ?? sourcePayload.vibration_mg ?? sourcePayload.vibrationMg ?? null,
    tiltDeg: sourcePayload.tilt ?? sourcePayload.tilt_deg ?? sourcePayload.tiltDeg ?? null,
    shockG: pickFirst(sourcePayload, [
      ["shock"],
      ["shock_g"],
      ["shockG"],
      ["accel_g"],
      ["accelG"],
      ["lis2dh12", "shock_g"],
      ["lis2dh12", "shockG"],
      ["lis2dh12", "accel_g"],
      ["imu", "shock_g"],
      ["imu", "accel_g"]
    ]),
    epaperStatus: pickFirst(sourcePayload, [
      ["epd"],
      ["epaper_status"],
      ["epaperStatus"],
      ["display_status"],
      ["displayStatus"],
      ["epaper", "status"],
      ["display", "status"]
    ]),
    epaperOrientation: pickFirst(sourcePayload, [
      ["ori"],
      ["epaper_orientation"],
      ["epaperOrientation"],
      ["display_orientation"],
      ["displayOrientation"],
      ["epaper", "orientation"],
      ["display", "orientation"]
    ]),
    epaperRefreshCount: pickFirst(sourcePayload, [
      ["epdc"],
      ["epaper_refresh_count"],
      ["epaperRefreshCount"],
      ["display_refresh_count"],
      ["displayRefreshCount"],
      ["epaper", "refresh_count"],
      ["epaper", "refreshCount"],
      ["display", "refresh_count"]
    ]),
    epaperDisplaySampleSeq: pickFirst(sourcePayload, [
      ["epdseq"],
      ["epaper_display_sample_seq"],
      ["epaperDisplaySampleSeq"],
      ["display_sample_seq"],
      ["displaySampleSeq"],
      ["epaper", "display_sample_seq"],
      ["epaper", "displaySampleSeq"],
      ["display", "sample_seq"],
      ["display", "sampleSeq"]
    ]),
    epaperRefreshPeriodSeconds: pickFirst(sourcePayload, [
      ["epdi"],
      ["epaper_refresh_period_seconds"],
      ["epaperRefreshPeriodSeconds"],
      ["display_refresh_period_seconds"],
      ["displayRefreshPeriodSeconds"],
      ["epaper", "refresh_period_seconds"],
      ["epaper", "refreshPeriodSeconds"]
    ]),
    epaperRefreshLastResult: pickFirst(sourcePayload, [
      ["epr"],
      ["epaper_refresh_last_result"],
      ["epaperRefreshLastResult"],
      ["display_refresh_last_result"],
      ["displayRefreshLastResult"],
      ["epaper", "refresh_last_result"],
      ["epaper", "refreshLastResult"]
    ]),
    epaperLastRefresh: pickFirst(sourcePayload, [
      ["epaper_last_refresh"],
      ["epaperLastRefresh"],
      ["display_last_refresh"],
      ["displayLastRefresh"],
      ["epaper", "last_refresh"],
      ["epaper", "lastRefresh"],
      ["display", "last_refresh"]
    ]),
    lat,
    lng,
    raw: sourcePayload,
    latProvided,
    lngProvided
  };
}

function shouldBumpDeviceSeen(source, isSnapshot) {
  if (isSnapshot) return false;
  const normalized = String(source || "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "unknown" || normalized === "rest") {
    return false;
  }
  return true;
}

function normalizeSourceName(source) {
  return String(source || "")
    .trim()
    .toLowerCase();
}

function appendNodeHistory(nodeId, point) {
  const key = normalizeStringId(nodeId) || "unknown";
  const prev = nodeHistoryMap.get(key) || [];
  const next = prev.length >= MAX_NODE_HISTORY ? prev.slice(prev.length - MAX_NODE_HISTORY + 1) : prev.slice();
  next.push(point);
  nodeHistoryMap.set(key, next);
}

function restoreNodeHistory(nodeId, items = []) {
  const key = normalizeStringId(nodeId) || "unknown";
  const restored = (Array.isArray(items) ? items : [])
    .map((item) => {
      const timestamp = toNumber(item?.timestamp) ?? Date.now();
      const point = {
        ...item,
        nodeId: key,
        timestamp,
        lastSeenAt: timestamp,
        lastDeviceSeenAt: timestamp,
        serviceState:
          item?.serviceState ??
          item?.service_state ??
          item?.raw?.svc ??
          item?.raw?.service_state ??
          null,
        serviceCommandId:
          item?.serviceCommandId ??
          item?.service_command_id ??
          item?.raw?.svcid ??
          item?.raw?.service_command_id ??
          null,
        firmwareVersion:
          item?.firmwareVersion ??
          item?.raw?.firmware_version ??
          item?.raw?.firmwareVersion ??
          item?.raw?.fw ??
          item?.raw?.version ??
          item?.raw?.firmware?.version ??
          null
      };
      return {
        ...point,
        epaperScreen: buildEpaperScreenModel(point, timestamp)
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_NODE_HISTORY);

  nodeHistoryMap.set(key, restored);

  const current = nodeMap.get(key);
  if (current) {
    current.epaperScreen = epaperScreenForDisplayedSample(
      key,
      current,
      buildEpaperScreenModel(current, Date.now())
    );
  }

  return restored.length;
}

function epaperScreenForDisplayedSample(nodeId, node, telemetryScreen) {
  const displayedSeq = toNumber(node?.epaperDisplaySampleSeq);
  const sampleSeq = toNumber(node?.sampleSeq);
  if (displayedSeq === null || (sampleSeq !== null && displayedSeq === sampleSeq)) {
    return {
      ...telemetryScreen,
      displayedSampleSeq: displayedSeq ?? sampleSeq,
      displaySource: "current"
    };
  }

  const key = normalizeStringId(nodeId) || "unknown";
  const history = nodeHistoryMap.get(key) || [];
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    if (toNumber(point?.sampleSeq) === displayedSeq && point?.epaperScreen) {
      return {
        ...point.epaperScreen,
        displayedSampleSeq: displayedSeq,
        displaySource: "history"
      };
    }
  }

  return {
    ...telemetryScreen,
    displayedSampleSeq: displayedSeq,
    displaySource: "unmatched"
  };
}

function trimRawPayload(raw, maxBytes) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "string") {
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  }
  if (typeof raw !== "object") return raw;
  const text = safeStableStringify(raw, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    return { _truncated: true, _text: text };
  }
}

function mergeTelemetry(prev, normalizedTelemetry, isSnapshot) {
  if (!isSnapshot) {
    return {
      ...prev,
      ...normalizedTelemetry
    };
  }

  const merged = { ...prev };
  for (const [key, value] of Object.entries(normalizedTelemetry)) {
    if (key === "raw" || key === "nodeId" || value !== null) {
      merged[key] = value;
    } else if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value;
    }
  }
  return merged;
}

function upsertNodeTelemetry(payload, fallbackNodeId, options = {}) {
  const source = options.source || "unknown";
  const isSnapshot = options.isSnapshot === true;
  const restoredFromStorage = options.restoredFromStorage === true;
  const normalizedSource = normalizeSourceName(source) || "unknown";
  const normalized = normalizePayload(payload, fallbackNodeId);
  const prev = nodeMap.get(normalized.nodeId) || {};
  const observedAt = Number(options.observedAt);
  const now = Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now();
  const { latProvided, lngProvided, ...normalizedTelemetry } = normalized;
  const isDeviceSource = shouldBumpDeviceSeen(normalizedSource, isSnapshot);
  const replay = detectHistoricalReplay(prev, normalizedTelemetry, now, isDeviceSource);

  if (replay.replay) {
    const sourceLastSeenAt = { ...(prev.sourceLastSeenAt || {}) };
    sourceLastSeenAt[normalizedSource] = now;
    const historyNode = {
      ...prev,
      ...normalizedTelemetry,
      lastSeenAt: now,
      lastDeviceSeenAt: isDeviceSource ? now : prev.lastDeviceSeenAt || null
    };
    const epaperScreen = buildEpaperScreenModel(historyNode, now);
    const preserved = {
      ...prev,
      lastSeenAt: now,
      lastDeviceSeenAt: isDeviceSource ? now : prev.lastDeviceSeenAt || null,
      lastSource: isDeviceSource ? normalizedSource : prev.lastSource || "unknown",
      lastSnapshotSource: isSnapshot ? normalizedSource : prev.lastSnapshotSource || null,
      restoredFromStorage:
        isDeviceSource && !restoredFromStorage ? false : prev.restoredFromStorage || restoredFromStorage,
      sourceLastSeenAt,
      staleReplayCount: (prev.staleReplayCount || 0) + 1,
      lastStaleReplayAt: now,
      lastStaleReplaySource: normalizedSource,
      lastStaleReplayReason: replay.reason
    };

    nodeMap.set(normalized.nodeId, preserved);
    appendNodeHistory(normalized.nodeId, {
      nodeId: normalized.nodeId,
      timestamp: now,
      temperature: historyNode.temperature ?? null,
      humidity: historyNode.humidity ?? null,
      battery: historyNode.battery ?? null,
      voltage: historyNode.voltage ?? null,
      rssi: historyNode.rssi ?? null,
      status: historyNode.status ?? null,
      serviceState: historyNode.serviceState ?? null,
      serviceCommandId: historyNode.serviceCommandId ?? null,
      mode: historyNode.mode ?? null,
      wakeReason: historyNode.wakeReason ?? null,
      motionEvent: historyNode.motionEvent ?? null,
      assetEvent: historyNode.assetEvent ?? null,
      alarmActive: historyNode.alarmActive ?? null,
      abnormalEvent: historyNode.abnormalEvent ?? null,
      sustainedMotion: historyNode.sustainedMotion ?? null,
      motionWindowIrqCount: historyNode.motionWindowIrqCount ?? null,
      motionDeltaMg: historyNode.motionDeltaMg ?? null,
      motionWindowSeconds: historyNode.motionWindowSeconds ?? null,
      sampleSeq: historyNode.sampleSeq ?? null,
      firmwareVersion: historyNode.firmwareVersion ?? null,
      cachedRecords: historyNode.cachedRecords ?? null,
      powerSource: historyNode.powerSource ?? null,
      powerSourceValid: historyNode.powerSourceValid ?? null,
      batteryPresent: historyNode.batteryPresent ?? null,
      batteryPresenceValid: historyNode.batteryPresenceValid ?? null,
      batteryPowered: historyNode.batteryPowered ?? null,
      charging: historyNode.charging ?? null,
      chargeComplete: historyNode.chargeComplete ?? null,
      pwrOnly: historyNode.pwrOnly ?? null,
      externalPowerPresent: historyNode.externalPowerPresent ?? null,
      powerValid: historyNode.powerValid ?? null,
      accelXMg: historyNode.accelXMg ?? null,
      accelYMg: historyNode.accelYMg ?? null,
      accelZMg: historyNode.accelZMg ?? null,
      vibrationMg: historyNode.vibrationMg ?? null,
      tiltDeg: historyNode.tiltDeg ?? null,
      shockG: historyNode.shockG ?? null,
      epaperStatus: historyNode.epaperStatus ?? null,
      epaperOrientation: historyNode.epaperOrientation ?? null,
      epaperRefreshCount: historyNode.epaperRefreshCount ?? null,
      epaperDisplaySampleSeq: historyNode.epaperDisplaySampleSeq ?? null,
      epaperRefreshPeriodSeconds: historyNode.epaperRefreshPeriodSeconds ?? null,
      epaperRefreshLastResult: historyNode.epaperRefreshLastResult ?? null,
      epaperLastRefresh: historyNode.epaperLastRefresh ?? null,
      epaperScreen,
      source: normalizedSource,
      raw: trimRawPayload(normalized.raw || {}, MAX_HISTORY_RAW_BYTES)
    });
    return withDerivedEpaperScreen(nodeMap.get(normalized.nodeId), now);
  }

  const merged = mergeTelemetry(prev, normalizedTelemetry, isSnapshot);
  let serviceRecord = serviceStateForNode(
    normalized.nodeId,
    prev.serviceState,
    prev.serviceCommandId
  );
  const incomingServiceState = normalizeServiceState(normalizedTelemetry.serviceState);
  const incomingServiceCommandId = String(normalizedTelemetry.serviceCommandId || serviceRecord.commandId || "");

  if (incomingServiceState && incomingServiceState !== "NONE") {
    if (serviceRecord.state !== "DONE" || incomingServiceState === "DONE") {
      serviceRecord = setNodeServiceState(normalized.nodeId, incomingServiceState, {
        commandId: incomingServiceCommandId,
        updatedAt: now
      });
    }
  }

  merged.serviceState = serviceRecord.state;
  merged.serviceCommandId = serviceRecord.commandId;
  merged.serviceUpdatedAt = serviceRecord.updatedAt;

  // Keep legacy coordinates internally for older payloads, but the current UI
  // does not expose them because this hardware revision has no positioning module.
  if (latProvided) {
    merged.lat = normalized.lat;
  } else if (prev.lat !== undefined) {
    merged.lat = prev.lat;
  }
  if (lngProvided) {
    merged.lng = normalized.lng;
  } else if (prev.lng !== undefined) {
    merged.lng = prev.lng;
  }

  const prevRaw = prev.raw || null;
  const changed = stableStringify(prevRaw) !== stableStringify(normalized.raw || null);
  merged.lastSeenAt = now;
  merged.lastDeviceSeenAt = isDeviceSource ? now : prev.lastDeviceSeenAt || null;
  merged.updatedAt = changed ? now : prev.updatedAt || now;
  merged.lastSource = isDeviceSource ? normalizedSource : prev.lastSource || "unknown";
  merged.lastSnapshotSource = isSnapshot ? normalizedSource : prev.lastSnapshotSource || null;
  merged.restoredFromStorage = isDeviceSource && !restoredFromStorage ? false : prev.restoredFromStorage || restoredFromStorage;

  if (
    epaperStatusFromTelemetry(merged, epaperFreshness(merged.lastDeviceSeenAt ?? merged.lastSeenAt, now)) === "ALARM" &&
    serviceRecord.state !== "DONE"
  ) {
    serviceRecord = setNodeServiceState(normalized.nodeId, "REQUIRED", {
      commandId: serviceRecord.commandId,
      updatedAt: now
    });
    merged.serviceState = serviceRecord.state;
    merged.serviceCommandId = serviceRecord.commandId;
    merged.serviceUpdatedAt = serviceRecord.updatedAt;
  }

  const sourceUpdatedAt = { ...(prev.sourceUpdatedAt || {}) };
  const prevSourceRaw = prev.sourceRaw && prev.sourceRaw[normalizedSource] ? prev.sourceRaw[normalizedSource] : null;
  const currentSourceRaw = trimRawPayload(normalized.raw || null, MAX_SOURCE_RAW_BYTES);
  const sourceChanged = safeStableStringify(prevSourceRaw, MAX_SOURCE_RAW_BYTES) !== safeStableStringify(currentSourceRaw, MAX_SOURCE_RAW_BYTES);
  sourceUpdatedAt[normalizedSource] = sourceChanged ? now : sourceUpdatedAt[normalizedSource] || now;
  merged.sourceUpdatedAt = sourceUpdatedAt;

  const sourceLastSeenAt = { ...(prev.sourceLastSeenAt || {}) };
  sourceLastSeenAt[normalizedSource] = now;
  merged.sourceLastSeenAt = sourceLastSeenAt;

  const sourceRaw = { ...(prev.sourceRaw || {}) };
  sourceRaw[normalizedSource] = currentSourceRaw;
  merged.sourceRaw = sourceRaw;

  const telemetryEpaperScreen = buildEpaperScreenModel(merged, now);
  const epaperScreen = epaperScreenForDisplayedSample(normalized.nodeId, merged, telemetryEpaperScreen);
  merged.epaperScreen = epaperScreen;
  nodeMap.set(normalized.nodeId, merged);
  appendNodeHistory(normalized.nodeId, {
    nodeId: normalized.nodeId,
    timestamp: now,
    temperature: merged.temperature ?? null,
    humidity: merged.humidity ?? null,
    battery: merged.battery ?? null,
    voltage: merged.voltage ?? null,
    rssi: merged.rssi ?? null,
    status: merged.status ?? null,
    serviceState: merged.serviceState ?? null,
    serviceCommandId: merged.serviceCommandId ?? null,
    mode: merged.mode ?? null,
    wakeReason: merged.wakeReason ?? null,
    motionEvent: merged.motionEvent ?? null,
    assetEvent: merged.assetEvent ?? null,
    alarmActive: merged.alarmActive ?? null,
    abnormalEvent: merged.abnormalEvent ?? null,
    sustainedMotion: merged.sustainedMotion ?? null,
    motionWindowIrqCount: merged.motionWindowIrqCount ?? null,
    motionDeltaMg: merged.motionDeltaMg ?? null,
    motionWindowSeconds: merged.motionWindowSeconds ?? null,
    sampleSeq: merged.sampleSeq ?? null,
    firmwareVersion: merged.firmwareVersion ?? null,
    cachedRecords: merged.cachedRecords ?? null,
    powerSource: merged.powerSource ?? null,
    powerSourceValid: merged.powerSourceValid ?? null,
    batteryPresent: merged.batteryPresent ?? null,
    batteryPresenceValid: merged.batteryPresenceValid ?? null,
    batteryPowered: merged.batteryPowered ?? null,
    charging: merged.charging ?? null,
    chargeComplete: merged.chargeComplete ?? null,
    pwrOnly: merged.pwrOnly ?? null,
    externalPowerPresent: merged.externalPowerPresent ?? null,
    powerValid: merged.powerValid ?? null,
    accelXMg: merged.accelXMg ?? null,
    accelYMg: merged.accelYMg ?? null,
    accelZMg: merged.accelZMg ?? null,
    vibrationMg: merged.vibrationMg ?? null,
    tiltDeg: merged.tiltDeg ?? null,
    shockG: merged.shockG ?? null,
    epaperStatus: merged.epaperStatus ?? null,
    epaperOrientation: merged.epaperOrientation ?? null,
    epaperRefreshCount: merged.epaperRefreshCount ?? null,
    epaperDisplaySampleSeq: merged.epaperDisplaySampleSeq ?? null,
    epaperRefreshPeriodSeconds: merged.epaperRefreshPeriodSeconds ?? null,
    epaperRefreshLastResult: merged.epaperRefreshLastResult ?? null,
    epaperLastRefresh: merged.epaperLastRefresh ?? null,
    epaperScreen: telemetryEpaperScreen,
    source: normalizedSource,
    raw: trimRawPayload(normalized.raw || {}, MAX_HISTORY_RAW_BYTES)
  });
  return withDerivedEpaperScreen(nodeMap.get(normalized.nodeId), now);
}

function getAllNodes() {
  const now = Date.now();
  return Array.from(nodeMap.values())
    .map((item) => withDerivedEpaperScreen(item, now))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function buildSensorSnapshotMap() {
  const out = {};
  const items = getAllNodes();
  for (const item of items) {
    const source =
      String(item.lastSource || "").trim().toLowerCase() ||
      String(item.lastSnapshotSource || "").trim().toLowerCase() ||
      "unknown";

    out[item.nodeId] = {
      nodeId: item.nodeId,
      temperature: item.temperature ?? null,
      humidity: item.humidity ?? null,
      battery: item.battery ?? null,
      rssi: item.rssi ?? null,
      voltage: item.voltage ?? null,
      co2: item.co2 ?? null,
      pm25: item.pm25 ?? null,
      status: item.status ?? null,
      service_state: item.serviceState ?? null,
      service_command_id: item.serviceCommandId ?? null,
      events: item.events ?? null,
      urgent: item.urgent ?? null,
      mode: item.mode ?? null,
      wake_reason: item.wakeReason ?? null,
      motion_event: item.motionEvent ?? null,
      asset_event: item.assetEvent ?? null,
      alarm_active: item.alarmActive ?? null,
      abnormal_event: item.abnormalEvent ?? null,
      sustained_motion: item.sustainedMotion ?? null,
      motion_window_irq_count: item.motionWindowIrqCount ?? null,
      motion_delta_mg: item.motionDeltaMg ?? null,
      motion_window_seconds: item.motionWindowSeconds ?? null,
      sample_seq: item.sampleSeq ?? null,
      firmware_version: item.firmwareVersion ?? null,
      cached_records: item.cachedRecords ?? null,
      power_source: item.powerSource ?? null,
      power_source_valid: item.powerSourceValid ?? null,
      battery_present: item.batteryPresent ?? null,
      battery_presence_valid: item.batteryPresenceValid ?? null,
      battery_powered: item.batteryPowered ?? null,
      charging: item.charging ?? null,
      charge_complete: item.chargeComplete ?? null,
      pwr_only: item.pwrOnly ?? null,
      external_power_present: item.externalPowerPresent ?? null,
      power_valid: item.powerValid ?? null,
      accel_x_mg: item.accelXMg ?? null,
      accel_y_mg: item.accelYMg ?? null,
      accel_z_mg: item.accelZMg ?? null,
      vibration_mg: item.vibrationMg ?? null,
      tilt_deg: item.tiltDeg ?? null,
      shock_g: item.shockG ?? null,
      epaper_status: item.epaperStatus ?? null,
      epaper_orientation: item.epaperOrientation ?? null,
      epaper_refresh_count: item.epaperRefreshCount ?? null,
      epaper_display_sample_seq: item.epaperDisplaySampleSeq ?? null,
      epaper_refresh_period_seconds: item.epaperRefreshPeriodSeconds ?? null,
      epaper_refresh_last_result: item.epaperRefreshLastResult ?? null,
      epaper_last_refresh: item.epaperLastRefresh ?? null,
      epaper_screen: item.epaperScreen ?? null,
      source,
      updatedAt: item.updatedAt ?? null,
      lastSeenAt: item.lastSeenAt ?? null,
      lastDeviceSeenAt: item.lastDeviceSeenAt ?? null
    };
  }
  return out;
}

function pruneSnapshotNodes(snapshotNodeIds, snapshotSource = "rest") {
  const keep = new Set(
    Array.from(snapshotNodeIds || [])
      .map((x) => normalizeStringId(x))
      .filter(Boolean)
  );
  const src = normalizeSourceName(snapshotSource) || "rest";

  for (const [nodeId, node] of nodeMap.entries()) {
    if (keep.has(nodeId)) continue;

    const sourceKeys = Object.keys(node.sourceLastSeenAt || {});
    const onlySnapshotSource = sourceKeys.length === 1 && sourceKeys[0] === src;
    if (!onlySnapshotSource) continue;

    nodeMap.delete(nodeId);
    nodeHistoryMap.delete(nodeId);
  }
}

function getNode(nodeId) {
  const key = normalizeStringId(nodeId);
  return withDerivedEpaperScreen(nodeMap.get(key));
}

function getNodeHistory(nodeId, limit = 100) {
  const key = normalizeStringId(nodeId) || "unknown";
  const all = nodeHistoryMap.get(key) || [];
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
  return all.slice(-safeLimit).reverse();
}

function resetStore() {
  nodeMap.clear();
  nodeHistoryMap.clear();
  serviceStateMap.clear();
}

module.exports = {
  upsertNodeTelemetry,
  getAllNodes,
  buildSensorSnapshotMap,
  pruneSnapshotNodes,
  getNode,
  getNodeHistory,
  restoreNodeHistory,
  setNodeServiceState,
  getNodeServiceCommand,
  normalizeServiceState,
  maintenanceKeyForNode,
  resetStore
};
