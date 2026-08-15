function normalizeText(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function hasCoapMarker(value) {
  const text = normalizeText(value);
  return text.includes("coap");
}

function hasMqttMarker(value) {
  const text = normalizeText(value);
  return text.includes("mqtt");
}

function pickPayloadSource(payload) {
  const candidates = [
    payload?.source,
    payload?.mode,
    payload?.protocol,
    payload?.origin,
    payload?.ingest,
    payload?.transport,
    payload?.bridge_source,
    payload?.bridgeSource
  ];

  for (const c of candidates) {
    if (hasCoapMarker(c)) return "coap-mqtt";
    if (hasMqttMarker(c)) return "mqtt";
  }
  return "";
}

function pickUserPropertySource(packet) {
  const userProps = packet?.properties?.userProperties;
  if (!userProps || typeof userProps !== "object") return "";

  for (const [k, v] of Object.entries(userProps)) {
    const key = normalizeText(k);
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) {
      const text = normalizeText(item);
      if (!text) continue;
      if (key.includes("source") || key.includes("protocol") || key.includes("origin") || key.includes("ingest")) {
        if (hasCoapMarker(text)) return "coap-mqtt";
      }
    }
  }

  return "";
}

function detectMqttLogicalSource(payload, packet) {
  const fromPayload = pickPayloadSource(payload);
  if (fromPayload) return fromPayload;
  const fromUserProp = pickUserPropertySource(packet);
  if (fromUserProp) return fromUserProp;
  return "mqtt";
}

module.exports = {
  detectMqttLogicalSource
};
