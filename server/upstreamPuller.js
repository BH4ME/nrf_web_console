const { upsertNodeTelemetry, pruneSnapshotNodes } = require("./nodeStore");

function normalizeSource(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (text === "coap" || text === "coap-mqtt" || text === "mqtt" || text === "rest" || text === "api") {
    return text;
  }
  return "";
}

function normalizeItems(data) {
  if (Array.isArray(data)) {
    return data.map((item) => ({ payload: item, fallbackNodeId: item?.nodeId || item?.node_id }));
  }
  if (data && Array.isArray(data.items)) {
    return data.items.map((item) => ({ payload: item, fallbackNodeId: item?.nodeId || item?.node_id }));
  }
  if (data && Array.isArray(data.nodes)) {
    return data.nodes.map((item) => ({ payload: item, fallbackNodeId: item?.nodeId || item?.node_id }));
  }

  // Object map style: { "a1b2": { ... }, "c3d4": { ... } }
  if (data && typeof data === "object") {
    return Object.entries(data).map(([key, value]) => ({
      payload: value || {},
      fallbackNodeId: key
    }));
  }
  return [];
}

function guessSourceFromTopicLikeFields(payload) {
  const candidates = [payload?.mode, payload?.topic, payload?.source_topic, payload?.ingest_topic];

  for (const candidate of candidates) {
    const text = String(candidate || "")
      .trim()
      .toLowerCase();
    if (!text) continue;
    if (text.startsWith("coap/") || text.includes("/coap/") || text.includes("coap://") || text.includes("coap_")) {
      return "coap-mqtt";
    }
    if (text.includes("mqtt_")) return "mqtt";
  }
  return "";
}

async function pullOnce(config) {
  if (!config.UPSTREAM_PULL_URL) {
    return { ok: false, reason: "missing_url", count: 0 };
  }

  const headers = {};
  if (config.UPSTREAM_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${config.UPSTREAM_AUTH_TOKEN}`;
  }

  const timeoutMs = Math.max(1000, Number(config.UPSTREAM_PULL_TIMEOUT_MS || 5000));
  const resp = await fetch(config.UPSTREAM_PULL_URL, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) {
    return { ok: false, reason: `http_${resp.status}`, count: 0 };
  }

  const data = await resp.json();
  const items = normalizeItems(data);

  let count = 0;
  const snapshotIds = new Set();
  for (const item of items) {
    const payloadSource = normalizeSource(item.payload?.source);
    const guessed = guessSourceFromTopicLikeFields(item.payload);
    const source = guessed || payloadSource || "rest";
    const saved = upsertNodeTelemetry(item.payload, item.fallbackNodeId, { source, isSnapshot: true });
    snapshotIds.add(saved.nodeId);
    count += 1;
  }
  pruneSnapshotNodes(snapshotIds, "rest");

  return { ok: true, count };
}

function startUpstreamPuller(config) {
  if (!config.UPSTREAM_PULL_URL) {
    console.log("[pull] disabled (UPSTREAM_PULL_URL is empty)");
    return;
  }

  const every = Math.max(2000, Number(config.UPSTREAM_PULL_INTERVAL_MS || 8000));
  console.log(`[pull] enabled -> ${config.UPSTREAM_PULL_URL} every ${every}ms`);

  const run = async () => {
    try {
      const result = await pullOnce(config);
      if (!result.ok) {
        console.warn(`[pull] failed: ${result.reason}`);
        return;
      }
      console.log(`[pull] success: ${result.count} records`);
    } catch (err) {
      console.warn(`[pull] error: ${err.message}`);
    }
  };

  run();
  const timer = setInterval(run, every);
  return () => clearInterval(timer);
}

module.exports = {
  pullOnce,
  startUpstreamPuller
};
