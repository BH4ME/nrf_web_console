const test = require("node:test");
const assert = require("node:assert/strict");

const { loadLatestTelemetry } = require("../server/telemetryStore");
const { resetPool, setPoolConstructorForTests } = require("../server/db");

test("telemetry store should load latest message per node for startup recovery", async () => {
  const queries = [];

  function queryText(query) {
    if (typeof query === "string") return query;
    return String(query?.text || "");
  }

  class FakePool {
    async query(input) {
      queries.push(input);
      return {
        rows: [
          {
            node_id: "a1b2",
            topic: "sensor/a1b2/data",
            source: "mqtt",
            payload: { temperature: 25.5, encrypted: true },
            received_at: "2026-05-17T12:00:00.000Z"
          },
          {
            node_id: "c3d4",
            topic: "coap:/telemetry/c3d4",
            source: "coap",
            payload: JSON.stringify({ temperature: 24.1, encrypted: "dtls" }),
            received_at: "2026-05-17T12:01:00.000Z"
          }
        ]
      };
    }

    async end() {}
  }
  setPoolConstructorForTests(FakePool);

  try {
    const items = await loadLatestTelemetry({
      PG_ENABLED: true,
      PG_HOST: "127.0.0.1",
      PG_PORT: 5432,
      PG_DATABASE: "nordic",
      PG_USER: "nordic",
      PG_PASSWORD: "pw",
      PG_SSL: false,
      PG_CONNECT_TIMEOUT_MS: 1000,
      PG_QUERY_TIMEOUT_MS: 1000
    });

    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      nodeId: "a1b2",
      topic: "sensor/a1b2/data",
      source: "mqtt",
      payload: { temperature: 25.5, encrypted: true },
      receivedAt: "2026-05-17T12:00:00.000Z"
    });
    assert.deepEqual(items[1], {
      nodeId: "c3d4",
      topic: "coap:/telemetry/c3d4",
      source: "coap",
      payload: { temperature: 24.1, encrypted: "dtls" },
      receivedAt: "2026-05-17T12:01:00.000Z"
    });
    assert.equal(queries.some((query) => /DISTINCT ON \(node_id\)/.test(queryText(query))), true);
  } finally {
    await resetPool();
    setPoolConstructorForTests(null);
  }
});

test("telemetry store recovery should stay disabled without postgres config", async () => {
  const items = await loadLatestTelemetry({
    PG_ENABLED: false
  });

  assert.deepEqual(items, []);
});
