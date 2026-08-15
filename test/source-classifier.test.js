const test = require("node:test");
const assert = require("node:assert/strict");

const { detectMqttLogicalSource } = require("../server/sourceClassifier");

test("default mqtt source when no coap marker", () => {
  const source = detectMqttLogicalSource({ temperature: 20 }, {});
  assert.equal(source, "mqtt");
});

test("payload source=coap should map to coap-mqtt", () => {
  const source = detectMqttLogicalSource({ source: "coap" }, {});
  assert.equal(source, "coap-mqtt");
});

test("payload protocol coap should map to coap-mqtt", () => {
  const source = detectMqttLogicalSource({ protocol: "coap->mqtt" }, {});
  assert.equal(source, "coap-mqtt");
});

test("firmware mqtt mode should map to mqtt", () => {
  const source = detectMqttLogicalSource({ mode: "mqtt_tls", protocol: "mqtts" }, {});
  assert.equal(source, "mqtt");
});

test("firmware coap mode bridged through mqtt should map to coap-mqtt", () => {
  const source = detectMqttLogicalSource({ mode: "coap_dtls", protocol: "coaps" }, {});
  assert.equal(source, "coap-mqtt");
});

test("mqtt5 user property marker should map to coap-mqtt", () => {
  const source = detectMqttLogicalSource(
    { temperature: 22 },
    { properties: { userProperties: { source: "coap_bridge" } } }
  );
  assert.equal(source, "coap-mqtt");
});
