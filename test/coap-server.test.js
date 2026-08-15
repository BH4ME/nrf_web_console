const test = require("node:test");
const assert = require("node:assert/strict");

const { stripAuthFields, getNodeIdFromPath } = require("../server/coapServer");

test("stripAuthFields should remove CoAP auth tokens before persistence", () => {
  const cleaned = stripAuthFields({
    nodeId: "a1b2",
    temperature: 26.5,
    token: "secret-token",
    authToken: "other-secret"
  });

  assert.deepEqual(cleaned, {
    nodeId: "a1b2",
    temperature: 26.5
  });
});

test("getNodeIdFromPath should parse firmware CoAP ps/sensor paths", () => {
  assert.equal(getNodeIdFromPath("/ps/sensor/9512-coap-dtls/data"), "9512-coap-dtls");
  assert.equal(getNodeIdFromPath("/sensor/9512-coap-plain/data"), "9512-coap-plain");
  assert.equal(getNodeIdFromPath("/telemetry/9512"), "9512");
});
