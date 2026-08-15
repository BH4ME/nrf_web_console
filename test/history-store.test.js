const test = require("node:test");
const assert = require("node:assert/strict");

const {
  topicForNodeId,
  topicForNodeIdByTemplate,
  hasTopicPlaceholder,
  normalizeLimit,
  buildNodeRecord,
  compactHistoryRecord,
  createHistoryStore
} = require("../server/historyStore");
const { resetPool, setPoolConstructorForTests } = require("../server/db");

test("topicForNodeId should map node id to sensor topic", () => {
  assert.equal(topicForNodeId("A1B2"), "sensor/a1b2/data");
});

test("topicForNodeIdByTemplate should map + wildcard topic", () => {
  assert.equal(topicForNodeIdByTemplate("A1B2", "nrf/+/telemetry"), "nrf/a1b2/telemetry");
});

test("topicForNodeIdByTemplate should map {nodeId} topic", () => {
  assert.equal(topicForNodeIdByTemplate("A1B2", "sensor/{nodeId}/data"), "sensor/a1b2/data");
});

test("normalizeLimit should clamp and fallback on invalid values", () => {
  assert.equal(normalizeLimit(undefined, 100), 100);
  assert.equal(normalizeLimit("abc", 100), 100);
  assert.equal(normalizeLimit("9999", 100), 500);
  assert.equal(normalizeLimit("-5", 100), 1);
});

test("hasTopicPlaceholder should validate template placeholders", () => {
  assert.equal(hasTopicPlaceholder(""), false);
  assert.equal(hasTopicPlaceholder("sensor/fixed/data"), false);
  assert.equal(hasTopicPlaceholder("sensor/+/data"), true);
  assert.equal(hasTopicPlaceholder("sensor/{nodeId}/data"), true);
});

test("buildNodeRecord should normalize history payload", () => {
	const row = {
		topic: "sensor/a1b2/data",
    payload: JSON.stringify({
      temp_c: 31.2,
      humidity: 51,
      battery_pct: 90
    }),
    timestamp: "2026-05-16T10:00:00.000Z"
  };

  const mapped = buildNodeRecord(row, "a1b2");
  assert.equal(mapped.nodeId, "a1b2");
  assert.equal(mapped.temperature, 31.2);
  assert.equal(mapped.humidity, 51);
  assert.equal(mapped.battery, 90);
	assert.ok(mapped.timestamp > 0);
});

test("buildNodeRecord should normalize 9151 compact v2 history payload", () => {
	const row = {
		topic: "sensor/9512-mqtt-plain/data",
		source: "mqtt",
		payload: JSON.stringify({
			v: 2,
			fw: "2.15",
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
			shock: 1.001,
			status: "MOTION",
			evt: "movement",
			alarm: 0,
			abn: 0,
			epd: "ready",
			epdc: 7,
			epdseq: 42,
			epdi: 300,
			epr: 1,
			ori: "landscape"
		}),
		timestamp: "2026-07-07T10:00:00.000Z"
	};

	const mapped = buildNodeRecord(row, "9512-mqtt-plain");
	assert.equal(mapped.temperature, 24.6);
	assert.equal(mapped.humidity, 58.2);
	assert.equal(mapped.battery, 87);
	assert.equal(mapped.voltage, 4.07);
	assert.equal(mapped.rssi, -91);
	assert.equal(mapped.mode, "mqtt_plain");
	assert.equal(mapped.wakeReason, "motion");
	assert.equal(mapped.motionEvent, 1);
	assert.equal(mapped.sampleSeq, 42);
	assert.equal(mapped.cachedRecords, 3);
	assert.equal(mapped.accelXMg, 12);
	assert.equal(mapped.accelYMg, -28);
	assert.equal(mapped.accelZMg, 1001);
	assert.equal(mapped.vibrationMg, 1001);
	assert.equal(mapped.tiltDeg, 2);
	assert.equal(mapped.shockG, 1.001);
  assert.equal(mapped.status, "MOTION");
  assert.equal(mapped.firmwareVersion, "2.15");
  assert.equal(mapped.assetEvent, "movement");
	assert.equal(mapped.alarmActive, 0);
	assert.equal(mapped.abnormalEvent, 0);
	assert.equal(mapped.epaperStatus, "ready");
	assert.equal(mapped.epaperRefreshCount, 7);
	assert.equal(mapped.epaperDisplaySampleSeq, 42);
	assert.equal(mapped.epaperRefreshPeriodSeconds, 300);
	assert.equal(mapped.epaperRefreshLastResult, 1);
	assert.equal(mapped.epaperOrientation, "landscape");
});

test("compactHistoryRecord should keep UI fields and omit raw payload", () => {
  const compact = compactHistoryRecord({
    nodeId: "3229-coap-plain",
    timestamp: 1786724121341,
    temperature: 24.6,
    humidity: 58.2,
    battery: 0,
    status: "MOTION",
    epaperStatus: "MOTION",
    wakeReason: "motion",
    sampleSeq: 42,
    raw: {
      seq: 42,
      t: 24.6,
      h: 58.2,
      unused_debug_blob: "x".repeat(2000)
    }
  });

  assert.deepEqual(compact, {
    nodeId: "3229-coap-plain",
    timestamp: 1786724121341,
    temperature: 24.6,
    humidity: 58.2,
    battery: 0,
    status: "MOTION",
    epaperStatus: "MOTION",
    wakeReason: "motion",
    sampleSeq: 42
  });
});

test("history store should query telemetry_messages before legacy mqtt_messages", async () => {
	const queries = [];
  class FakePool {
    async query(input) {
      queries.push(input.text);
      if (input.text.includes("telemetry_messages")) {
        return {
          rows: [
            {
              topic: "sensor/a1b2/data",
              source: "mqtt",
              payload: JSON.stringify({ temperature: 28.5, humidity: 50, battery: 88 }),
              timestamp: "2026-05-17T10:00:00.000Z"
            }
          ]
        };
      }
      throw new Error("legacy query should not run");
    }

    async end() {}
  }
  setPoolConstructorForTests(FakePool);

  try {
    const store = createHistoryStore({
      PG_ENABLED: true,
      PG_HOST: "127.0.0.1",
      PG_PORT: 5432,
      PG_DATABASE: "nordic",
      PG_USER: "nordic",
      PG_PASSWORD: "pw",
      PG_SSL: false,
      PG_CONNECT_TIMEOUT_MS: 1000,
      PG_QUERY_TIMEOUT_MS: 1000,
      MQTT_TOPIC: "sensor/+/data"
    });

    const items = await store.getHistory("A1B2", 10);
    assert.equal(items.length, 1);
    assert.equal(String(items[0].nodeId).toLowerCase(), "a1b2");
    assert.equal(items[0].temperature, 28.5);
    assert.equal(items[0].source, "mqtt");
    assert.equal(queries.some((text) => text.includes("telemetry_messages")), true);
  } finally {
    await resetPool();
    setPoolConstructorForTests(null);
  }
});

test("history store should use node_id lookup so coap records are queryable", async () => {
  const calls = [];

  class FakePool {
    async query(input) {
      calls.push(input);
      if (input.text.includes("telemetry_messages")) {
        return {
          rows: [
            {
              topic: "coap:/telemetry/coap01",
              source: "coap",
              payload: JSON.stringify({ temperature: 29.8, humidity: 44, battery: 83 }),
              timestamp: "2026-05-17T10:05:00.000Z"
            }
          ]
        };
      }
      return { rows: [] };
    }

    async end() {}
  }
  setPoolConstructorForTests(FakePool);

  try {
    const store = createHistoryStore({
      PG_ENABLED: true,
      PG_HOST: "127.0.0.1",
      PG_PORT: 5432,
      PG_DATABASE: "nordic",
      PG_USER: "nordic",
      PG_PASSWORD: "pw",
      PG_SSL: false,
      PG_CONNECT_TIMEOUT_MS: 1000,
      PG_QUERY_TIMEOUT_MS: 1000,
      MQTT_TOPIC: "sensor/+/data"
    });

    const items = await store.getHistory("CoAp01", 10);
    assert.equal(items.length, 1);
    assert.equal(items[0].nodeId, "coap01");
    assert.equal(items[0].source, "coap");
    assert.equal(calls[0].values[0], "coap01");
  } finally {
    await resetPool();
    setPoolConstructorForTests(null);
  }
});
