const path = require("path");
const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");
const packageInfo = require("../package.json");
const { startMqttIngest } = require("./mqttClient");
const { startCoapIngest } = require("./coapServer");
const {
  upsertNodeTelemetry,
  getAllNodes,
  getNode,
  getNodeHistory,
  buildSensorSnapshotMap,
  setNodeServiceState,
  getNodeServiceCommand,
  restoreNodeHistory
} = require("./nodeStore");
const {
  commandId: createMaintenanceCommandId,
  saveMaintenanceState,
  loadMaintenanceStates,
  persistNodeMaintenance
} = require("./maintenanceStore");
const { startUpstreamPuller, pullOnce } = require("./upstreamPuller");
const { createHistoryStore, normalizeLimit, compactHistoryRecord } = require("./historyStore");
const { ensureSchema, storeTelemetryMessage, loadLatestTelemetry } = require("./telemetryStore");

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  );
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "web")));

const config = {
  PORT: Number(process.env.PORT || 8080),
  MQTT_BROKER_URL: process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
  MQTT_TOPIC: process.env.MQTT_TOPIC || "sensor/+/data",
  MQTT_USERNAME: process.env.MQTT_USERNAME || "",
  MQTT_PASSWORD: process.env.MQTT_PASSWORD || "",
  MQTT_CLIENT_ID: process.env.MQTT_CLIENT_ID || `nordic-web-dashboard-${Date.now()}`,
  MQTT_ALLOW_INSECURE_TLS: process.env.MQTT_ALLOW_INSECURE_TLS === "true",
  MQTT_CA_CERT_PATH: process.env.MQTT_CA_CERT_PATH || "",
  READ_AUTH_TOKEN: process.env.READ_AUTH_TOKEN || "",
  COAP_ENABLED: process.env.COAP_ENABLED !== "false",
  COAP_HOST: process.env.COAP_HOST || "0.0.0.0",
  COAP_PORT: Number(process.env.COAP_PORT || 5683),
  COAP_AUTH_TOKEN: process.env.COAP_AUTH_TOKEN || "",
  UPSTREAM_PULL_URL: process.env.UPSTREAM_PULL_URL || "",
  UPSTREAM_PULL_INTERVAL_MS: Number(process.env.UPSTREAM_PULL_INTERVAL_MS || 8000),
  UPSTREAM_PULL_TIMEOUT_MS: Number(process.env.UPSTREAM_PULL_TIMEOUT_MS || 5000),
  UPSTREAM_AUTH_TOKEN: process.env.UPSTREAM_AUTH_TOKEN || "",
  API_WRITE_TOKEN: process.env.API_WRITE_TOKEN || "",
  HISTORY_TOPIC_TEMPLATE: process.env.HISTORY_TOPIC_TEMPLATE || "",
  PG_ENABLED: process.env.PG_ENABLED === "true",
  PG_HOST: process.env.PG_HOST || "",
  PG_PORT: Number(process.env.PG_PORT || 5432),
  PG_DATABASE: process.env.PG_DATABASE || "",
  PG_USER: process.env.PG_USER || "",
  PG_PASSWORD: process.env.PG_PASSWORD || "",
  PG_SSL: process.env.PG_SSL === "true",
  PG_SSL_REJECT_UNAUTHORIZED: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false",
  PG_CONNECT_TIMEOUT_MS: Number(process.env.PG_CONNECT_TIMEOUT_MS || 3000),
  PG_QUERY_TIMEOUT_MS: Number(process.env.PG_QUERY_TIMEOUT_MS || 4000)
};

function safeTokenEquals(actual, expected) {
  const actualText = String(actual || "");
  const expectedText = String(expected || "");
  const actualBuffer = Buffer.from(actualText);
  const expectedBuffer = Buffer.from(expectedText);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireWriteToken(req, res, next) {
  const expected = String(config.API_WRITE_TOKEN || "").trim();
  if (!expected) {
    res.status(403).json({ error: "write_endpoints_disabled" });
    return;
  }
  const auth = String(req.headers.authorization || "");
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeTokenEquals(got, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function isSameOriginRequest(req) {
  const origin = String(req.headers.origin || "").trim();
  const host = String(req.headers.host || "").trim();
  if (!origin || !host) {
    return String(req.headers["sec-fetch-site"] || "").trim().toLowerCase() === "same-origin";
  }
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}

function requireDashboardWrite(req, res, next) {
  const expected = String(config.API_WRITE_TOKEN || "").trim();
  const auth = String(req.headers.authorization || "");
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (expected && safeTokenEquals(got, expected)) {
    next();
    return;
  }

  if (isSameOriginRequest(req)) {
    next();
    return;
  }

  res.status(401).json({ error: "unauthorized" });
}

function requireReadToken(req, res, next) {
  const expected = String(config.READ_AUTH_TOKEN || "").trim();
  if (!expected) {
    next();
    return;
  }
  const auth = String(req.headers.authorization || "");
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeTokenEquals(got, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function isTruthyQuery(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

if (!String(config.API_WRITE_TOKEN || "").trim()) {
  console.warn("[auth] API_WRITE_TOKEN is not set - write endpoints are disabled");
}
if (!String(config.READ_AUTH_TOKEN || "").trim()) {
  console.warn("[auth] READ_AUTH_TOKEN is not set - read endpoints are public");
}

const historyStore = createHistoryStore(config);

async function restoreLatestNodes() {
  try {
    await ensureSchema(config);
    const items = await loadLatestTelemetry(config);
    for (const item of items) {
      upsertNodeTelemetry(item.payload || {}, item.nodeId, {
        source: item.source,
        observedAt: Date.parse(item.receivedAt) || Date.now(),
        restoredFromStorage: true
      });
    }
    if (historyStore.isEnabled() && items.length) {
      let restoredPoints = 0;
      for (const item of items) {
        const history = await historyStore.getHistory(item.nodeId, 300);
        restoredPoints += restoreNodeHistory(item.nodeId, history);
      }
      console.log(`[pg] restored ${restoredPoints} history point(s) for ${items.length} node(s)`);
    }
    if (items.length) {
      console.log(`[pg] restored ${items.length} node(s) from telemetry store`);
    }
    const maintenanceItems = await loadMaintenanceStates(config);
    for (const item of maintenanceItems) {
      setNodeServiceState(item.nodeId, item.state, {
        commandId: item.commandId,
        updatedAt: item.updatedAt
      });
    }
    if (maintenanceItems.length) {
      console.log(`[pg] restored ${maintenanceItems.length} maintenance state(s)`);
    }
  } catch (err) {
    console.warn(`[pg] telemetry store init failed: ${err.message}`);
  }
}

restoreLatestNodes();

startMqttIngest(config);
startCoapIngest(config);
startUpstreamPuller(config);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "nordic-web-dashboard", version: packageInfo.version, ts: Date.now() });
});

app.get("/api/nodes", requireReadToken, (_req, res) => {
  res.json({ items: getAllNodes() });
});

app.get("/api/nodes/:nodeId", requireReadToken, (req, res) => {
  const found = getNode(req.params.nodeId);
  if (!found) {
    res.status(404).json({ error: "node_not_found" });
    return;
  }
  res.json(found);
});

app.get("/sensor", requireReadToken, (_req, res) => {
  res.json(buildSensorSnapshotMap());
});

app.get("/api/nodes/:nodeId/history", requireReadToken, async (req, res) => {
  try {
    const nodeId = String(req.params.nodeId || "").toLowerCase();
    const limit = normalizeLimit(req.query.limit, 100);
    const compact = isTruthyQuery(req.query.compact);
    let items = [];
    let source = "postgres";
    try {
      items = await historyStore.getHistory(nodeId, limit);
      if (!items.length) {
        source = "memory";
        items = getNodeHistory(nodeId, limit);
      }
    } catch (_err) {
      source = "memory";
      items = getNodeHistory(nodeId, limit);
    }
    res.json({
      nodeId,
      source,
      items: compact ? items.map(compactHistoryRecord) : items
    });
  } catch (err) {
    res.status(500).json({ error: "history_query_failed", reason: err.message });
  }
});

// Optional ingestion endpoint for your server-side bridge:
// POST /api/ingest with json: { nodeId, temperature, humidity, battery, ... }
app.post("/api/ingest", requireWriteToken, (req, res) => {
  const saved = upsertNodeTelemetry(req.body || {}, req.body?.nodeId, { source: "api" });
  persistNodeMaintenance(config, saved).catch((err) => {
    console.warn(`[pg] maintenance store update failed: ${err.message}`);
  });
  res.json({ ok: true, item: saved });
});

app.get("/api/nodes/:nodeId/maintenance", requireReadToken, (req, res) => {
  const found = getNode(req.params.nodeId);
  if (!found) {
    res.status(404).json({ error: "node_not_found" });
    return;
  }
  res.json({
    nodeId: found.nodeId,
    serviceState: found.serviceState || "NONE",
    serviceCommandId: found.serviceCommandId || null,
    serviceLabel: found.epaperScreen?.serviceLabel || ""
  });
});

app.post("/api/nodes/:nodeId/maintenance", requireDashboardWrite, async (req, res) => {
  try {
    const nodeId = String(req.params.nodeId || "").trim();
    const desiredState = String(req.body?.state || "DONE").trim().toUpperCase();
    const state = desiredState === "REQUIRED" ? "REQUIRED" : "DONE";
    const command = state === "DONE" ? createMaintenanceCommandId() : "";
    const saved = setNodeServiceState(nodeId, state, {
      commandId: command,
      updatedAt: Date.now()
    });
    await saveMaintenanceState(config, {
      nodeId: saved.nodeId,
      state: saved.state,
      commandId: saved.commandId
    });
    res.json({
      ok: true,
      nodeId: saved.nodeId,
      serviceState: saved.state,
      commandId: saved.commandId,
      command: getNodeServiceCommand(nodeId)
    });
  } catch (err) {
    res.status(500).json({ error: "maintenance_update_failed", reason: err.message });
  }
});

app.post("/api/internal/store", requireWriteToken, async (req, res) => {
  try {
    await storeTelemetryMessage(config, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "store_failed", reason: err.message });
  }
});

app.post("/api/pull-once", requireWriteToken, async (_req, res) => {
  try {
    const result = await pullOnce(config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

app.listen(config.PORT, () => {
  console.log(`[http] dashboard running: http://localhost:${config.PORT}`);
});
