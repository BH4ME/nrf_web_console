const test = require("node:test");
const assert = require("node:assert/strict");

const {
  upsertNodeTelemetry,
  getAllNodes,
  getNode,
  getNodeHistory,
  buildSensorSnapshotMap,
  pruneSnapshotNodes,
  restoreNodeHistory,
  resetStore
} = require("../server/nodeStore");
const { pullOnce } = require("../server/upstreamPuller");

test("upstream object map format should map key as fallback node id", () => {
  resetStore();
  upsertNodeTelemetry({ temperature: 30.1, humidity: 55 }, "a1b2");
  upsertNodeTelemetry({ mac: "cc:dd:ee:ff:c3:d4", temperature: 22.7, humidity: 60 }, "3:d4");

  const items = getAllNodes();
  const ids = items.map((x) => x.nodeId).sort();

  assert.deepEqual(ids, ["a1b2", "c3d4"]);
});

test("zero legacy coordinates should be treated as missing", () => {
  resetStore();
  const row = upsertNodeTelemetry({ mac_last4: "9512", lat: 0, lng: 0 }, "9512", { source: "mqtt" });
  assert.equal(row.lat, null);
  assert.equal(row.lng, null);
});

test("explicit zero legacy coordinates should clear stale coordinates", () => {
  resetStore();
  upsertNodeTelemetry(
    { mac_last4: "9512", lat: 31.2304, lng: 121.4737 },
    "9512",
    { source: "mqtt" }
  );

  const row = upsertNodeTelemetry({ mac_last4: "9512", lat: 0, lng: 0 }, "9512", {
    source: "mqtt"
  });

  assert.equal(row.lat, null);
  assert.equal(row.lng, null);
});

test("istag-like payload fields should normalize correctly", () => {
  resetStore();
  const row = upsertNodeTelemetry(
    {
      device: "ISTAG-0001",
      ts_ms: 3244228,
      state: "running",
      events: 0,
      urgent: false,
      temp_c: 32,
      vibration_mg: 320,
      tilt_deg: 2,
      battery_pct: 87
    },
    "0001"
  );

  assert.equal(row.nodeId, "0001");
  assert.equal(row.temperature, 32);
  assert.equal(row.battery, 87);
  assert.equal(row.status, "running");
  assert.equal(row.events, 0);
  assert.equal(row.urgent, false);
  assert.equal(row.vibrationMg, 320);
  assert.equal(row.tiltDeg, 2);
});

test("unchanged payload should not bump updatedAt but should bump lastSeenAt", async () => {
  resetStore();
  const first = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 30.1 }, "a1b2");
  await new Promise((r) => setTimeout(r, 4));
  const second = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 30.1 }, "a1b2");

  assert.equal(second.updatedAt, first.updatedAt);
  assert.ok(second.lastSeenAt >= first.lastSeenAt);
});

test("source fields should be tracked per protocol", async () => {
  resetStore();
  const first = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 10 }, "a1b2", { source: "mqtt" });
  await new Promise((r) => setTimeout(r, 3));
  const second = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 10 }, "a1b2", { source: "rest", isSnapshot: true });

  assert.equal(second.lastSource, "mqtt");
  assert.equal(second.lastSnapshotSource, "rest");
  assert.ok(second.sourceLastSeenAt.mqtt > 0);
  assert.ok(second.sourceLastSeenAt.rest > 0);
  assert.ok(second.sourceUpdatedAt.mqtt > 0);
  assert.ok(second.sourceUpdatedAt.rest > 0);
  assert.equal(second.updatedAt, first.updatedAt);
});

test("rest snapshot should not bump device seen time", async () => {
  resetStore();
  const first = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 10 }, "a1b2", { source: "mqtt" });
  const firstDeviceSeenAt = first.lastDeviceSeenAt;
  await new Promise((r) => setTimeout(r, 3));
  const second = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 10 }, "a1b2", { source: "rest", isSnapshot: true });

  assert.equal(second.lastDeviceSeenAt, firstDeviceSeenAt);
  assert.ok(second.lastSeenAt >= first.lastSeenAt);
});

test("partial rest snapshot should not clear live telemetry fields", () => {
  resetStore();
  upsertNodeTelemetry(
    {
      id: "9512-mqtt-tls",
      v: 2,
      seq: 7,
      mode: "mqtt_tls",
      wake: "motion",
      mot: 1,
      t: 24.6,
      h: 58.2,
      bat: 87,
      mv: 4070,
      rssi: -91,
      cache: 3,
      ax: 12,
      ay: -28,
      az: 1001
    },
    "9512-mqtt-tls",
    { source: "mqtt" }
  );

  const row = upsertNodeTelemetry({ id: "9512-mqtt-tls", status: "snapshot-ok" }, "9512-mqtt-tls", {
    source: "rest",
    isSnapshot: true
  });

  assert.equal(row.temperature, 24.6);
  assert.equal(row.humidity, 58.2);
  assert.equal(row.battery, 87);
  assert.equal(row.voltage, 4.07);
  assert.equal(row.rssi, -91);
  assert.equal(row.mode, "mqtt_tls");
  assert.equal(row.wakeReason, "motion");
  assert.equal(row.motionEvent, 1);
  assert.equal(row.sampleSeq, 7);
  assert.equal(row.cachedRecords, 3);
  assert.equal(row.accelXMg, 12);
  assert.equal(row.accelYMg, -28);
  assert.equal(row.accelZMg, 1001);
  assert.equal(row.status, "snapshot-ok");
});

test("mqtt and coap sources should bump device seen time", async () => {
  resetStore();
  const first = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 10 }, "a1b2", { source: "mqtt" });
  await new Promise((r) => setTimeout(r, 3));
  const second = upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 10 }, "a1b2", { source: "coap-mqtt" });

  assert.ok(second.lastDeviceSeenAt >= first.lastDeviceSeenAt);
});

test("firmware mode-specific node ids should render as separate cards", () => {
  resetStore();
  upsertNodeTelemetry({ nodeId: "9512-mqtt-tls", temperature: 29, encrypted: true }, "9512-mqtt-tls", {
    source: "mqtt"
  });
  upsertNodeTelemetry({ nodeId: "9512-mqtt-plain", temperature: 29, encrypted: false }, "9512-mqtt-plain", {
    source: "mqtt"
  });
  upsertNodeTelemetry({ nodeId: "9512-coap-dtls", temperature: 29, encrypted: true }, "9512-coap-dtls", {
    source: "coap"
  });
  upsertNodeTelemetry({ nodeId: "9512-coap-plain", temperature: 29, encrypted: false }, "9512-coap-plain", {
    source: "coap"
  });

  const ids = getAllNodes()
    .map((item) => item.nodeId)
    .sort();

  assert.deepEqual(ids, ["9512-coap-dtls", "9512-coap-plain", "9512-mqtt-plain", "9512-mqtt-tls"]);
});

test("9151 compact v2 payload should normalize telemetry and motion fields", () => {
  resetStore();
  const row = upsertNodeTelemetry(
    {
      v: 2,
      id: "9512-mqtt-plain",
      seq: 42,
      mode: "mqtt_plain",
      wake: "motion",
      mot: 1,
      t: 24.6,
      h: 58.2,
      bat: 87,
      mv: 4070,
      rssi: -91,
      cache: 3,
      ax: 12,
      ay: -28,
      az: 1001,
      vib: 1001,
      tilt: 2,
      shock: 1.001
    },
    "topic-fallback",
    { source: "mqtt" }
  );

  assert.equal(row.nodeId, "9512-mqtt-plain");
  assert.equal(row.temperature, 24.6);
  assert.equal(row.humidity, 58.2);
  assert.equal(row.battery, 87);
  assert.equal(row.voltage, 4.07);
  assert.equal(row.rssi, -91);
  assert.equal(row.mode, "mqtt_plain");
  assert.equal(row.wakeReason, "motion");
  assert.equal(row.motionEvent, 1);
  assert.equal(row.sampleSeq, 42);
  assert.equal(row.cachedRecords, 3);
  assert.equal(row.accelXMg, 12);
  assert.equal(row.accelYMg, -28);
  assert.equal(row.accelZMg, 1001);
  assert.equal(row.vibrationMg, 1001);
  assert.equal(row.tiltDeg, 2);
  assert.equal(row.shockG, 1.001);
  assert.equal(row.epaperScreen.assetId, "ISTAG-9512");
  assert.equal(row.epaperScreen.status, "MOTION");
  assert.equal(row.epaperScreen.statusShort, "MOVE");
  assert.equal(row.epaperScreen.env.temperatureC, 24.6);
  assert.equal(row.epaperScreen.env.humidityRh, 58.2);
  assert.equal(row.epaperScreen.power.batteryPercent, 87);
  assert.equal(row.epaperScreen.network.rssiDbm, -91);
  assert.equal(row.epaperScreen.motion.shockMg, 1001);
  assert.equal(row.epaperScreen.uplink.mode, "mqtt_plain");
  assert.equal(row.epaperScreen.uplink.cachedRecords, 3);

  const history = getNodeHistory("9512-mqtt-plain", 1);
  assert.equal(history[0].sampleSeq, 42);
  assert.equal(history[0].cachedRecords, 3);
  assert.equal(history[0].shockG, 1.001);
  assert.equal(history[0].epaperScreen.status, "MOTION");
});

test("9151 compact payload should mirror firmware status and EPD aliases", () => {
  resetStore();
  const row = upsertNodeTelemetry(
    {
      v: 2,
      fw: "2.14",
      id: "9512-coap-plain",
      seq: 88,
      mode: "coap_plain",
      wake: "timer",
      status: "LOWBAT",
      evt: "heartbeat",
      alarm: 0,
      mot: 0,
      abn: 0,
      t: 24.6,
      h: 58.2,
      bat: 80,
      mv: 4070,
      rssi: -91,
      cache: 3,
      epd: "ready",
      epdc: 7,
      epdseq: 84,
      epdi: 300,
      epr: 1,
      ori: "landscape",
      ps: "pwr_only",
      psv: 1,
      bp: 0,
      bpv: 1,
      bon: 0,
      chg: 0,
      full: 0,
      po: 1,
      ext: 1,
      pwr: 1
    },
    "topic-fallback",
    { source: "coap" }
  );

  assert.equal(row.status, "LOWBAT");
  assert.equal(row.assetEvent, "heartbeat");
  assert.equal(row.alarmActive, 0);
  assert.equal(row.abnormalEvent, 0);
  assert.equal(row.firmwareVersion, "2.14");
  assert.equal(row.epaperStatus, "ready");
  assert.equal(row.epaperRefreshCount, 7);
  assert.equal(row.epaperDisplaySampleSeq, 84);
  assert.equal(row.epaperRefreshPeriodSeconds, 300);
  assert.equal(row.epaperRefreshLastResult, 1);
  assert.equal(row.epaperOrientation, "landscape");
  assert.equal(row.powerSource, "pwr_only");
  assert.equal(row.batteryPresent, 0);
  assert.equal(row.epaperScreen.status, "LOWBAT");
  assert.equal(row.epaperScreen.statusShort, "LOW");
  assert.equal(row.epaperScreen.power.source, "pwr_only");
  assert.equal(row.epaperScreen.power.batteryPresent, false);
  assert.equal(row.epaperScreen.uplink.firmwareVersion, "2.14");
});

test("virtual EPD should follow the display-acknowledged sample when epdseq lags", () => {
  resetStore();
  upsertNodeTelemetry(
    {
      v: 2,
      fw: "2.14",
      id: "9512-coap-plain",
      seq: 40,
      mode: "coap_plain",
      wake: "motion",
      status: "MOTION",
      evt: "movement",
      mot: 1,
      t: 24.6,
      h: 58.2,
      bat: 80,
      mv: 4070,
      rssi: -91,
      cache: 3,
      epd: "ready",
      epdc: 2,
      epdseq: 0,
      ori: "landscape"
    },
    "topic-fallback",
    { source: "coap" }
  );

  const row = upsertNodeTelemetry(
    {
      v: 2,
      fw: "2.14",
      id: "9512-coap-plain",
      seq: 41,
      mode: "coap_plain",
      wake: "timer",
      status: "NORMAL",
      evt: "heartbeat",
      mot: 0,
      t: 24.7,
      h: 58.0,
      bat: 81,
      mv: 4080,
      rssi: -90,
      cache: 2,
      epd: "ready",
      epdc: 3,
      epdseq: 40,
      ori: "landscape"
    },
    "topic-fallback",
    { source: "coap" }
  );

  assert.equal(row.status, "NORMAL");
  assert.equal(row.sampleSeq, 41);
  assert.equal(row.epaperDisplaySampleSeq, 40);
  assert.equal(row.epaperScreen.status, "MOTION");
  assert.equal(row.epaperScreen.uplink.sampleSeq, 40);
  assert.equal(row.epaperScreen.displayedSampleSeq, 40);
});

test("restored history should rehydrate the display-acknowledged sample", () => {
  resetStore();
  upsertNodeTelemetry(
    {
      v: 2,
      fw: "2.15",
      id: "3229-coap-plain",
      seq: 41,
      mode: "coap_plain",
      wake: "timer",
      status: "NORMAL",
      t: 27.7,
      h: 73.2,
      bat: 79,
      mv: 4018,
      rssi: -115,
      cache: 0,
      epd: "ready",
      epdc: 4,
      epdseq: 40,
      epr: 1,
      ori: "landscape"
    },
    "3229-coap-plain",
    { source: "coap-mqtt", observedAt: Date.parse("2026-08-14T12:00:10.000Z") }
  );

  restoreNodeHistory("3229-coap-plain", [
    {
      nodeId: "3229-coap-plain",
      timestamp: Date.parse("2026-08-14T12:00:00.000Z"),
      temperature: 27.9,
      humidity: 72.7,
      battery: 79,
      voltage: 4.018,
      rssi: -119,
      mode: "coap_plain",
      wakeReason: "motion",
      motionEvent: 1,
      status: "ALARM",
      alarmActive: 1,
      sampleSeq: 40,
      cachedRecords: 0,
      powerSource: "battery",
      batteryPresent: 1,
      powerValid: 1,
      epaperStatus: "ready",
      epaperOrientation: "landscape",
      epaperRefreshCount: 3,
      epaperDisplaySampleSeq: 39,
      epaperRefreshLastResult: 1
    }
  ]);

  const row = getNode("3229-coap-plain");
  assert.equal(row.epaperScreen.displaySource, "history");
  assert.equal(row.epaperScreen.displayedSampleSeq, 40);
  assert.equal(row.epaperScreen.uplink.sampleSeq, 40);
  assert.equal(row.epaperScreen.env.temperatureC, 27.9);
  assert.equal(row.epaperScreen.status, "ALARM");
});

test("epaper screen should strip coap dtls suffix and mirror firmware thresholds", () => {
  resetStore();
  const alarm = upsertNodeTelemetry(
    {
      v: 2,
      id: "9512-coap-dtls",
      seq: 13,
      mode: "coap_dtls",
      wake: "timer",
      mot: 0,
      t: 40.0,
      h: 61.0,
      bat: 80,
      mv: 4010,
      rssi: -83,
      cache: 3
    },
    "topic-fallback",
    { source: "coap-mqtt" }
  );

  assert.equal(alarm.epaperScreen.assetId, "ISTAG-9512");
  assert.equal(alarm.epaperScreen.status, "ALARM");
  assert.equal(alarm.epaperScreen.statusShort, "ALRM");
  assert.equal(alarm.epaperScreen.motion.valid, false);
  assert.equal(alarm.epaperScreen.motion.shockMg, null);

  const lowBattery = upsertNodeTelemetry(
    {
      v: 2,
      id: "9512-coap-plain",
      seq: 14,
      mode: "coap_plain",
      wake: "timer",
      mot: 0,
      t: 24.0,
      h: 55.0,
      bat: 14,
      mv: 3520,
      rssi: -96,
      cache: 2
    },
    "topic-fallback",
    { source: "coap-mqtt" }
  );

  assert.equal(lowBattery.epaperScreen.assetId, "ISTAG-9512");
  assert.equal(lowBattery.epaperScreen.status, "LOWBAT");
  assert.equal(lowBattery.epaperScreen.statusShort, "LOW");
});

test("sensor topic parser should preserve mode-specific node ids", () => {
  const { parseNodeIdFromTopic } = require("../server/topicParser");
  assert.equal(parseNodeIdFromTopic("sensor/9512-mqtt-tls/data"), "9512-mqtt-tls");
  assert.equal(parseNodeIdFromTopic("sensor/9512-coap-dtls/data"), "9512-coap-dtls");
});

test("in-memory node history should keep recent samples", async () => {
  resetStore();
  upsertNodeTelemetry({ mac_last4: "9512", temperature: 29 }, "9512", { source: "mqtt" });
  await new Promise((r) => setTimeout(r, 3));
  upsertNodeTelemetry({ mac_last4: "9512", temperature: 30 }, "9512", { source: "mqtt" });
  await new Promise((r) => setTimeout(r, 3));
  upsertNodeTelemetry({ mac_last4: "9512", temperature: 31 }, "9512", { source: "rest", isSnapshot: true });

  const history = getNodeHistory("9512", 2);
  assert.equal(history.length, 2);
  assert.equal(history[0].temperature, 31);
  assert.equal(history[1].temperature, 30);
});

test("upstream payload source should override rest default", async () => {
  resetStore();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      "0001": {
        source: "coap",
        temp_c: 32
      }
    })
  });

  try {
    const result = await pullOnce({ UPSTREAM_PULL_URL: "http://fake.local/sensor" });
    assert.equal(result.ok, true);
    const row = getAllNodes().find((x) => x.nodeId === "0001");
    assert.equal(row.lastSnapshotSource, "coap");
    assert.equal(row.lastSource, "unknown");
  } finally {
    global.fetch = originalFetch;
  }
});

test("upstream topic-like coap marker should map to coap-mqtt", async () => {
  resetStore();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      "9512": {
        topic: "coap/9512",
        temperature: 30
      }
    })
  });

  try {
    const result = await pullOnce({ UPSTREAM_PULL_URL: "http://fake.local/sensor" });
    assert.equal(result.ok, true);
    const row = getAllNodes().find((x) => x.nodeId === "9512");
    assert.equal(row.lastSnapshotSource, "coap-mqtt");
    assert.equal(row.lastSource, "unknown");
  } finally {
    global.fetch = originalFetch;
  }
});

test("upstream compact mode should preserve mqtt/coap logical source", async () => {
  resetStore();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      items: [
        { id: "9512-coap-dtls", mode: "coap_dtls", t: 24.6 },
        { id: "9512-mqtt-tls", mode: "mqtt_tls", t: 24.7 },
        { id: "9512-coap-plain", topic: "sensor/9512-coap-plain/data", mode: "coap_plain", t: 24.8 }
      ]
    })
  });

  try {
    const result = await pullOnce({ UPSTREAM_PULL_URL: "http://fake.local/sensor" });
    assert.equal(result.ok, true);
    assert.equal(getNode("9512-coap-dtls").lastSnapshotSource, "coap-mqtt");
    assert.equal(getNode("9512-mqtt-tls").lastSnapshotSource, "mqtt");
    assert.equal(getNode("9512-coap-plain").lastSnapshotSource, "coap-mqtt");
  } finally {
    global.fetch = originalFetch;
  }
});

test("upstream pull should prune stale rest snapshots only, even with mixed payload sources", async () => {
  resetStore();
  upsertNodeTelemetry({ temperature: 10 }, "stale-rest", { source: "rest", isSnapshot: true });
  upsertNodeTelemetry({ temperature: 11 }, "stale-mqtt-snapshot", { source: "mqtt", isSnapshot: true });

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      nodes: [
        { nodeId: "fresh-rest", source: "rest", temperature: 20 },
        { nodeId: "fresh-mqtt", source: "mqtt", temperature: 21 }
      ]
    })
  });

  try {
    const result = await pullOnce({ UPSTREAM_PULL_URL: "http://fake.local/sensor" });
    assert.equal(result.ok, true);

    const ids = getAllNodes()
      .map((item) => item.nodeId)
      .sort();
    assert.deepEqual(ids, ["fresh-mqtt", "fresh-rest", "stale-mqtt-snapshot"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getNode should normalize nodeId lookup", () => {
  resetStore();
  upsertNodeTelemetry({ mac_last4: "a1b2", temperature: 30 }, "a1b2", { source: "mqtt" });

  const upper = getNode("A1B2");
  const mixed = getNode(" a1B2 ");
  assert.equal(upper.nodeId, "a1b2");
  assert.equal(mixed.nodeId, "a1b2");
});

test("pruneSnapshotNodes should remove stale rest-only nodes", () => {
  resetStore();
  upsertNodeTelemetry({ temperature: 1 }, "test", { source: "rest", isSnapshot: true });
  upsertNodeTelemetry({ temperature: 2 }, "dev01", { source: "rest", isSnapshot: true });
  upsertNodeTelemetry({ temperature: 3 }, "9512", { source: "rest", isSnapshot: true });

  pruneSnapshotNodes(new Set(["9512"]), "rest");

  const ids = getAllNodes().map((x) => x.nodeId).sort();
  assert.deepEqual(ids, ["9512"]);
});

test("pruneSnapshotNodes should keep nodes that also have mqtt source", () => {
  resetStore();
  upsertNodeTelemetry({ temperature: 1 }, "9512", { source: "mqtt" });
  upsertNodeTelemetry({ temperature: 1 }, "9512", { source: "rest", isSnapshot: true });
  upsertNodeTelemetry({ temperature: 1 }, "test", { source: "rest", isSnapshot: true });

  pruneSnapshotNodes(new Set(), "rest");

  const ids = getAllNodes().map((x) => x.nodeId).sort();
  assert.deepEqual(ids, ["9512"]);
});

test("sensor snapshot map should expose latest node data keyed by node id", () => {
  resetStore();
  upsertNodeTelemetry(
    {
      mac_last4: "9512",
      temp_c: 32,
      humidity: 55,
      battery_pct: 87,
      shock_g: 0.18,
      epaper_status: "synced",
      epaper_orientation: "landscape",
      epaper_refresh_count: 12,
      epaper_last_refresh: "2026-07-06T06:03:42.000Z"
    },
    "9512",
    { source: "mqtt" }
  );

  const snapshot = buildSensorSnapshotMap();
  assert.equal(snapshot["9512"].epaper_screen.assetId, "ISTAG-9512");
  assert.equal(snapshot["9512"].epaper_screen.status, "NORMAL");
  assert.equal(snapshot["9512"].epaper_screen.env.temperatureC, 32);
  assert.equal(snapshot["9512"].epaper_screen.motion.shockMg, 180);
  assert.deepEqual(snapshot["9512"], {
    nodeId: "9512",
    temperature: 32,
    humidity: 55,
    battery: 87,
    rssi: null,
    voltage: null,
    co2: null,
    pm25: null,
    status: null,
    service_state: "NONE",
    service_command_id: "",
    events: null,
    urgent: null,
    mode: null,
    wake_reason: null,
    motion_event: null,
    asset_event: null,
    alarm_active: null,
    abnormal_event: null,
    sustained_motion: null,
    motion_window_irq_count: null,
    motion_delta_mg: null,
    motion_window_seconds: null,
    sample_seq: null,
    firmware_version: null,
    cached_records: null,
    power_source: null,
    power_source_valid: null,
    battery_present: null,
    battery_presence_valid: null,
    battery_powered: null,
    charging: null,
    charge_complete: null,
    pwr_only: null,
    external_power_present: null,
    power_valid: null,
    accel_x_mg: null,
    accel_y_mg: null,
    accel_z_mg: null,
    vibration_mg: null,
    tilt_deg: null,
    shock_g: 0.18,
    epaper_status: "synced",
    epaper_orientation: "landscape",
    epaper_refresh_count: 12,
    epaper_display_sample_seq: null,
    epaper_refresh_period_seconds: null,
    epaper_refresh_last_result: null,
    epaper_last_refresh: "2026-07-06T06:03:42.000Z",
    epaper_screen: snapshot["9512"].epaper_screen,
    source: "mqtt",
    updatedAt: snapshot["9512"].updatedAt,
    lastSeenAt: snapshot["9512"].lastSeenAt,
    lastDeviceSeenAt: snapshot["9512"].lastDeviceSeenAt
  });
});
