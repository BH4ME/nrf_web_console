import test from "node:test";
import assert from "node:assert/strict";

import {
  protocolBadge,
  encryptionBadge,
  freshnessBadge,
  recoveryBadge
} from "../web/dashboard-badges.mjs";

test("protocol badge should keep mqtt-only nodes as MQTT", () => {
  assert.equal(protocolBadge({ sourceLastSeenAt: { mqtt: Date.now() } }), "MQTT");
});

test("protocol badge should show direct coap nodes as COAP", () => {
  assert.equal(protocolBadge({ sourceLastSeenAt: { coap: Date.now() } }), "COAP");
});

test("protocol badge should show dual uplink nodes as MQTT+COAP", () => {
  assert.equal(protocolBadge({ sourceLastSeenAt: { mqtt: Date.now(), coap: Date.now() } }), "MQTT+COAP");
});

test("protocol badge should treat rest bridge snapshots as COAP->MQTT", () => {
  assert.equal(protocolBadge({ sourceLastSeenAt: { rest: Date.now() } }), "COAP->MQTT");
});

test("encryption badge should map encrypted mqtt payloads to TLS", () => {
  const item = {
    sourceLastSeenAt: { mqtt: Date.now() },
    raw: { encrypted: true }
  };

  assert.equal(encryptionBadge(item), "TLS");
});

test("encryption badge should map encrypted coap payloads to DTLS", () => {
  const item = {
    sourceLastSeenAt: { coap: Date.now() },
    raw: { encrypted: "true" }
  };

  assert.equal(encryptionBadge(item), "DTLS");
});

test("encryption badge should map explicit false to PLAIN", () => {
  const item = {
    sourceLastSeenAt: { mqtt: Date.now() },
    raw: { encrypted: false }
  };

  assert.equal(encryptionBadge(item), "PLAIN");
});

test("encryption badge should fall back to sourceRaw payloads when latest snapshot omits encrypted", () => {
  const item = {
    sourceLastSeenAt: { mqtt: Date.now(), rest: Date.now() },
    raw: { temperature: 26 },
    sourceRaw: {
      mqtt: { encrypted: true }
    }
  };

  assert.equal(encryptionBadge(item), "TLS");
});

test("encryption badge should show UNKNOWN when encrypted flag is missing", () => {
  const item = {
    sourceLastSeenAt: { mqtt: Date.now() },
    raw: { temperature: 26 }
  };

  assert.equal(encryptionBadge(item), "UNKNOWN");
});

test("encryption badge should infer compact firmware modes", () => {
  assert.equal(encryptionBadge({ raw: { mode: "mqtt_tls" } }), "TLS");
  assert.equal(encryptionBadge({ raw: { mode: "coap_dtls" } }), "DTLS");
  assert.equal(encryptionBadge({ raw: { mode: "mqtt_plain" } }), "PLAIN");
  assert.equal(encryptionBadge({ raw: { mode: "coap_plain" } }), "PLAIN");
});

test("encryption badge should not infer DTLS from rest-only snapshots", () => {
  const item = {
    sourceLastSeenAt: { rest: Date.now() },
    raw: { encrypted: true }
  };

  assert.equal(encryptionBadge(item), "SECURE");
});

test("encryption badge should use the freshest encrypted source record", () => {
  const item = {
    sourceLastSeenAt: {
      mqtt: 1000,
      "coap-mqtt": 2000
    },
    sourceUpdatedAt: {
      mqtt: 1000,
      "coap-mqtt": 2000
    },
    raw: { temperature: 26 },
    sourceRaw: {
      mqtt: { encrypted: false },
      "coap-mqtt": { encrypted: true }
    }
  };

  assert.equal(encryptionBadge(item), "DTLS");
});

test("freshness badge should mark recent nodes as LIVE", () => {
  const now = Date.parse("2026-05-17T12:10:00.000Z");
  assert.equal(freshnessBadge({ lastDeviceSeenAt: now - 60_000 }, now), "LIVE");
});

test("freshness badge should mark older nodes as STALE", () => {
  const now = Date.parse("2026-05-17T12:10:00.000Z");
  assert.equal(freshnessBadge({ lastDeviceSeenAt: now - 2 * 60 * 60 * 1000 }, now), "STALE");
});

test("recovery badge should highlight restored nodes", () => {
  assert.equal(recoveryBadge({ restoredFromStorage: true }), "RESTORED");
  assert.equal(recoveryBadge({ restoredFromStorage: false }), null);
});
