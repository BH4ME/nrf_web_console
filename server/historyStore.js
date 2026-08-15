const { getPool, isPostgresEnabled } = require("./db");

function maybeParsePayload(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeVoltage(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 20 ? n / 1000 : n;
}

function buildNodeRecord(row, nodeId) {
  const payload = maybeParsePayload(row.payload);
  const timestamp = row.timestamp ? new Date(row.timestamp).getTime() : Date.now();

  const temp =
    payload.temperature ??
    payload.t ??
    payload.temp ??
    payload.temp_c ??
    payload.tempC ??
    null;

  const hum = payload.humidity ?? payload.h ?? payload.humi ?? payload.hum ?? null;
  const battery = payload.battery ?? payload.bat ?? payload.battery_pct ?? payload.batteryPercent ?? null;

  return {
    nodeId,
    timestamp,
    temperature: temp,
    humidity: hum,
    battery,
    voltage: normalizeVoltage(payload.voltage ?? payload.vbat ?? payload.vbat_v ?? payload.mv ?? payload.battery_mv),
    rssi: payload.rssi ?? payload.signal_dbm ?? null,
    mode: payload.mode ?? null,
    wakeReason: payload.wake ?? payload.wake_reason ?? payload.wakeReason ?? null,
    motionEvent: payload.mot ?? payload.motion_event ?? payload.motionEvent ?? null,
    status: payload.status ?? payload.state ?? null,
    assetEvent: payload.evt ?? payload.asset_event ?? payload.assetEvent ?? null,
    alarmActive: payload.alarm ?? payload.alarm_active ?? payload.alarmActive ?? null,
    abnormalEvent: payload.abn ?? payload.abnormal_event ?? payload.abnormalEvent ?? null,
    sustainedMotion: payload.msus ?? payload.sustained_motion ?? payload.sustainedMotion ?? null,
    motionWindowIrqCount: payload.mw ?? payload.motion_window_irq_count ?? payload.motionWindowIrqCount ?? null,
    motionDeltaMg: payload.md ?? payload.motion_delta_mg ?? payload.motionDeltaMg ?? null,
    motionWindowSeconds: payload.ms ?? payload.motion_window_seconds ?? payload.motionWindowSeconds ?? null,
    sampleSeq: payload.seq ?? payload.sample_seq ?? payload.sampleSeq ?? null,
    firmwareVersion:
      payload.firmware_version ??
      payload.firmwareVersion ??
      payload.fw ??
      payload.version ??
      payload.firmware?.version ??
      null,
    cachedRecords: payload.cache ?? payload.cached_records ?? payload.cachedRecords ?? null,
    powerSource: payload.ps ?? payload.power_source ?? payload.powerSource ?? null,
    powerSourceValid: payload.psv ?? payload.power_source_valid ?? payload.powerSourceValid ?? null,
    batteryPresent: payload.bp ?? payload.battery_present ?? payload.batteryPresent ?? null,
    batteryPresenceValid: payload.bpv ?? payload.battery_presence_valid ?? payload.batteryPresenceValid ?? null,
    batteryPowered: payload.bon ?? payload.battery_powered ?? payload.batteryPowered ?? null,
    charging: payload.chg ?? payload.charging ?? null,
    chargeComplete: payload.full ?? payload.charge_complete ?? payload.chargeComplete ?? null,
    pwrOnly: payload.po ?? payload.pwr_only ?? payload.pwrOnly ?? null,
    externalPowerPresent: payload.ext ?? payload.external_power_present ?? payload.externalPowerPresent ?? null,
    powerValid: payload.pwr ?? payload.power_valid ?? payload.powerValid ?? null,
    accelXMg: payload.ax ?? payload.accel_x_mg ?? payload.accelXMg ?? null,
    accelYMg: payload.ay ?? payload.accel_y_mg ?? payload.accelYMg ?? null,
    accelZMg: payload.az ?? payload.accel_z_mg ?? payload.accelZMg ?? null,
    vibrationMg: payload.vib ?? payload.vibration_mg ?? payload.vibrationMg ?? null,
    tiltDeg: payload.tilt ?? payload.tilt_deg ?? payload.tiltDeg ?? null,
    shockG: payload.shock ?? payload.shock_g ?? payload.shockG ?? payload.accel_g ?? payload.accelG ?? null,
    epaperStatus: payload.epd ?? payload.epaper_status ?? payload.epaperStatus ?? payload.display_status ?? null,
    epaperOrientation: payload.ori ?? payload.epaper_orientation ?? payload.epaperOrientation ?? payload.display_orientation ?? null,
    epaperRefreshCount:
      payload.epdc ?? payload.epaper_refresh_count ?? payload.epaperRefreshCount ?? payload.display_refresh_count ?? null,
    epaperDisplaySampleSeq:
      payload.epdseq ?? payload.epaper_display_sample_seq ?? payload.epaperDisplaySampleSeq ?? payload.display_sample_seq ?? null,
    epaperRefreshPeriodSeconds:
      payload.epdi ??
      payload.epaper_refresh_period_seconds ??
      payload.epaperRefreshPeriodSeconds ??
      payload.display_refresh_period_seconds ??
      null,
    epaperRefreshLastResult:
      payload.epr ??
      payload.epaper_refresh_last_result ??
      payload.epaperRefreshLastResult ??
      payload.display_refresh_last_result ??
      null,
    epaperLastRefresh: payload.epaper_last_refresh ?? payload.epaperLastRefresh ?? payload.display_last_refresh ?? null,
    source: row.source || null,
    raw: payload
  };
}

const COMPACT_HISTORY_FIELDS = [
  "nodeId",
  "timestamp",
  "temperature",
  "humidity",
  "battery",
  "voltage",
  "rssi",
  "mode",
  "wakeReason",
  "motionEvent",
  "status",
  "epaperStatus",
  "sampleSeq",
  "firmwareVersion",
  "cachedRecords",
  "serviceState",
  "source"
];

function copyPresentField(target, source, field) {
  const value = source?.[field];
  if (value !== null && value !== undefined && value !== "") {
    target[field] = value;
  }
}

function compactHistoryRecord(record) {
  const compact = {};
  for (const field of COMPACT_HISTORY_FIELDS) {
    copyPresentField(compact, record, field);
  }

  if (record?.epaperScreen && typeof record.epaperScreen === "object") {
    const epaperScreen = {};
    copyPresentField(epaperScreen, record.epaperScreen, "status");
    copyPresentField(epaperScreen, record.epaperScreen, "serviceState");
    if (Object.keys(epaperScreen).length) {
      compact.epaperScreen = epaperScreen;
    }
  }

  return compact;
}

function topicForNodeId(nodeId) {
  return `sensor/${String(nodeId).toLowerCase()}/data`;
}

function topicForNodeIdByTemplate(nodeId, topicTemplate) {
  const id = String(nodeId || "")
    .trim()
    .toLowerCase();
  const template = String(topicTemplate || "").trim();
  if (!template) return topicForNodeId(id);
  if (template.includes("{nodeId}")) {
    return template.split("{nodeId}").join(id);
  }
  if (template.includes("+")) {
    return template.replace("+", id);
  }
  return template;
}

function hasTopicPlaceholder(topicTemplate) {
  const template = String(topicTemplate || "").trim();
  if (!template) return false;
  return template.includes("+") || template.includes("{nodeId}");
}

function normalizeLimit(limit, fallback = 100) {
  const n = Number.parseInt(String(limit || ""), 10);
  const valid = Number.isFinite(n) ? n : fallback;
  return Math.max(1, Math.min(500, valid));
}

function createHistoryStore(config) {
  if (!isPostgresEnabled(config)) {
    console.log("[pg] history store disabled");
    return {
      isEnabled: () => false,
      getHistory: async () => []
    };
  }

  const pool = getPool(config);

  const topicTemplate = config.HISTORY_TOPIC_TEMPLATE || config.MQTT_TOPIC || "sensor/+/data";
  console.log(`[pg] history store enabled -> ${config.PG_HOST}:${config.PG_PORT}/${config.PG_DATABASE}`);
  console.log(`[pg] history topic template -> ${topicTemplate}`);
  if (!hasTopicPlaceholder(topicTemplate)) {
    console.warn(
      `[pg] history topic template "${topicTemplate}" has no placeholder (+/{nodeId}); all nodes will query the same topic`
    );
  }

  return {
    isEnabled: () => true,
    getHistory: async (nodeId, limit) => {
      const safeLimit = normalizeLimit(limit, 100);
      const normalizedNodeId = String(nodeId || "")
        .trim()
        .toLowerCase();
      const topic = topicForNodeIdByTemplate(normalizedNodeId, topicTemplate);
      const statements = [
        {
          text: `
            SELECT topic, payload, source, received_at AS timestamp
            FROM telemetry_messages
            WHERE node_id = $1
            ORDER BY received_at DESC
            LIMIT $2
          `,
          values: [normalizedNodeId, safeLimit]
        },
        {
          text: `
            SELECT topic, payload, NULL::text AS source, "timestamp"
            FROM mqtt_messages
            WHERE topic = $1
            ORDER BY "timestamp" DESC
            LIMIT $2
          `,
          values: [topic, safeLimit]
        }
      ];

      for (const statement of statements) {
        try {
          const result = await pool.query({
            text: statement.text,
            values: statement.values,
            statement_timeout: Number(config.PG_QUERY_TIMEOUT_MS || 4000)
          });
          return result.rows.map((row) => buildNodeRecord(row, normalizedNodeId));
        } catch (err) {
          if (!String(err.message || "").includes("does not exist")) {
            throw err;
          }
        }
      }

      return [];
    }
  };
}

module.exports = {
  createHistoryStore,
  topicForNodeId,
  topicForNodeIdByTemplate,
  hasTopicPlaceholder,
  normalizeLimit,
  buildNodeRecord,
  compactHistoryRecord
};
