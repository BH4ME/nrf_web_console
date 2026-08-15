const mqtt = require("mqtt");
const fs = require("fs");
const { upsertNodeTelemetry } = require("./nodeStore");
const { persistNodeMaintenance } = require("./maintenanceStore");
const { parseNodeIdFromTopic } = require("./topicParser");
const { detectMqttLogicalSource } = require("./sourceClassifier");
const { storeTelemetryMessage } = require("./telemetryStore");

function buildTlsOptions(config) {
  const options = {};
  const caPath = String(config.MQTT_CA_CERT_PATH || "").trim();
  if (!caPath) {
    return options;
  }

  try {
    options.ca = fs.readFileSync(caPath, "utf8");
    console.log(`[mqtt] loaded CA cert: ${caPath}`);
  } catch (err) {
    console.warn(`[mqtt] failed to load CA cert ${caPath}: ${err.message}`);
  }
  return options;
}

function startMqttIngest(config) {
  if (config.MQTT_ALLOW_INSECURE_TLS) {
    console.warn("[mqtt] MQTT_ALLOW_INSECURE_TLS=true disables broker certificate verification");
  }
  const client = mqtt.connect(config.MQTT_BROKER_URL, {
    username: config.MQTT_USERNAME || undefined,
    password: config.MQTT_PASSWORD || undefined,
    clientId: config.MQTT_CLIENT_ID,
    rejectUnauthorized: !config.MQTT_ALLOW_INSECURE_TLS,
    reconnectPeriod: 5000,
    connectTimeout: 4000,
    ...buildTlsOptions(config)
  });

  client.on("connect", () => {
    console.log(`[mqtt] connected -> ${config.MQTT_BROKER_URL}`);
    client.subscribe(config.MQTT_TOPIC, (err) => {
      if (err) {
        console.error("[mqtt] subscribe failed:", err.message);
        return;
      }
      console.log(`[mqtt] subscribed topic: ${config.MQTT_TOPIC}`);
    });
  });

  client.on("message", (topic, message, packet) => {
    const text = message.toString("utf-8");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      console.warn(`[mqtt] invalid json on topic ${topic}: ${text}`);
      return;
    }

    const topicNodeId = parseNodeIdFromTopic(topic);
    const logicalSource = detectMqttLogicalSource(payload, packet);
    const saved = upsertNodeTelemetry(payload, topicNodeId, { source: logicalSource });
    persistNodeMaintenance(config, saved).catch((err) => {
      console.warn(`[pg] maintenance store update failed: ${err.message}`);
    });
    storeTelemetryMessage(config, {
      nodeId: saved.nodeId,
      topic,
      source: logicalSource,
      payload
    }).catch((err) => {
      console.warn(`[pg] mqtt store failed: ${err.message}`);
    });
    console.log(`[mqtt] node=${saved.nodeId} temp=${saved.temperature} hum=${saved.humidity} battery=${saved.battery}`);
  });

  client.on("error", (err) => {
    console.warn("[mqtt] client error:", err.message || "unknown");
  });

  client.on("offline", () => {
    console.warn("[mqtt] offline, waiting reconnect...");
  });

  client.on("reconnect", () => {
    console.log("[mqtt] reconnecting...");
  });

  return client;
}

module.exports = { startMqttIngest };
