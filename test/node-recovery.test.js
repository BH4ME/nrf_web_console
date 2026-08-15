const test = require("node:test");
const assert = require("node:assert/strict");

const { upsertNodeTelemetry, getNode, resetStore } = require("../server/nodeStore");

test("restored nodes should keep recovered marker until a live device packet arrives", () => {
  resetStore();

  const restored = upsertNodeTelemetry(
    { mac_last4: "a1b2", temperature: 26.4, encrypted: true },
    "a1b2",
    {
      source: "mqtt",
      observedAt: Date.parse("2026-05-17T12:00:00.000Z"),
      restoredFromStorage: true
    }
  );

  assert.equal(restored.restoredFromStorage, true);
  assert.equal(restored.lastSeenAt, Date.parse("2026-05-17T12:00:00.000Z"));

  const afterSnapshot = upsertNodeTelemetry(
    { mac_last4: "a1b2", temperature: 26.4 },
    "a1b2",
    {
      source: "rest",
      isSnapshot: true,
      observedAt: Date.parse("2026-05-17T12:05:00.000Z")
    }
  );

  assert.equal(afterSnapshot.restoredFromStorage, true);

  const afterLivePacket = upsertNodeTelemetry(
    { mac_last4: "a1b2", temperature: 27.1, encrypted: false },
    "a1b2",
    {
      source: "coap",
      observedAt: Date.parse("2026-05-17T12:06:00.000Z")
    }
  );

  assert.equal(afterLivePacket.restoredFromStorage, false);
  assert.equal(getNode("A1B2").restoredFromStorage, false);
});

test("restored firmware snapshot should not block the first live device packet", () => {
  resetStore();

  upsertNodeTelemetry(
    { id: "3203-coap-plain", fw: "2.13", seq: 13, wake: "motion", t: 31.6 },
    "3203-coap-plain",
    {
      source: "mqtt",
      observedAt: Date.parse("2026-07-27T05:42:12.000Z"),
      restoredFromStorage: true
    }
  );

  const live = upsertNodeTelemetry(
    { id: "3203-coap-plain", fw: "2.9", seq: 370, wake: "motion", t: 29.1 },
    "3203-coap-plain",
    {
      source: "coap",
      observedAt: Date.parse("2026-07-27T05:42:15.000Z")
    }
  );

  assert.equal(live.restoredFromStorage, false);
  assert.equal(live.firmwareVersion, "2.9");
  assert.equal(live.sampleSeq, 370);
  assert.equal(live.temperature, 29.1);
  assert.equal(live.lastStaleReplayReason, undefined);
});

test("live firmware regression should preserve current snapshot and record stale replay", () => {
  resetStore();

  upsertNodeTelemetry(
    { id: "3203-coap-plain", fw: "2.13", seq: 13, wake: "motion", t: 31.6 },
    "3203-coap-plain",
    {
      source: "mqtt",
      observedAt: Date.parse("2026-07-27T05:42:12.000Z")
    }
  );

  const stale = upsertNodeTelemetry(
    { id: "3203-coap-plain", fw: "2.9", seq: 370, wake: "motion", t: 29.1 },
    "3203-coap-plain",
    {
      source: "coap",
      observedAt: Date.parse("2026-07-27T05:42:15.000Z")
    }
  );

  assert.equal(stale.firmwareVersion, "2.13");
  assert.equal(stale.sampleSeq, 13);
  assert.equal(stale.temperature, 31.6);
  assert.equal(stale.staleReplayCount, 1);
  assert.equal(stale.lastStaleReplayReason, "firmware_regression");
});
