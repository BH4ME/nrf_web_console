function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function sourceKeys(item) {
  return Object.keys(item?.sourceLastSeenAt || {})
    .map((key) => normalizeText(key))
    .filter(Boolean);
}

function sourceTimestamp(item, sourceKey) {
  const key = normalizeText(sourceKey);
  if (!key) return 0;
  return Number(item?.sourceUpdatedAt?.[key] ?? item?.sourceLastSeenAt?.[key] ?? 0) || 0;
}

function collectPayloadEntries(item) {
  const entries = [];

  if (item?.raw && typeof item.raw === "object") {
    entries.push({
      sourceKey: normalizeText(item?.lastSource),
      payload: item.raw,
      ts: Number(item?.updatedAt ?? 0) || 0
    });
  }

  for (const [sourceKey, payload] of Object.entries(item?.sourceRaw || {})) {
    if (payload && typeof payload === "object") {
      entries.push({
        sourceKey: normalizeText(sourceKey),
        payload,
        ts: sourceTimestamp(item, sourceKey)
      });
    }
  }

  return entries;
}

function modeEncryptionRecord(item) {
  const entries = collectPayloadEntries(item).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  for (const entry of entries) {
    const mode = normalizeText(entry.payload?.mode);
    if (mode.includes("dtls")) {
      return { ...entry, parsed: { encrypted: true, label: "DTLS" } };
    }
    if (mode.includes("tls")) {
      return { ...entry, parsed: { encrypted: true, label: "TLS" } };
    }
    if (mode.includes("plain")) {
      return { ...entry, parsed: { encrypted: false, label: "PLAIN" } };
    }
  }
  return null;
}

function sourceFamilyFromPayloads(item) {
  const keys = sourceKeys(item);
  if (keys.includes("coap") || keys.includes("coap-mqtt")) return "coap";
  if (keys.includes("mqtt")) return "mqtt";

  for (const { sourceKey, payload } of collectPayloadEntries(item)) {
    if (sourceKey === "coap" || sourceKey === "coap-mqtt") return "coap";
    if (sourceKey === "mqtt") return "mqtt";
    const source = normalizeText(payload.source);
    const transport = normalizeText(payload.transport);
    if (source.includes("coap") || transport.includes("coap")) return "coap";
    if (source.includes("mqtt") || transport.includes("mqtt")) return "mqtt";
  }
  return null;
}

function firstEncryptedRecord(item) {
  const entries = collectPayloadEntries(item).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  for (const entry of entries) {
    const { payload } = entry;
    if (Object.prototype.hasOwnProperty.call(payload, "encrypted")) {
      return { ...entry, value: payload.encrypted };
    }
    if (Object.prototype.hasOwnProperty.call(payload, "encry")) {
      return { ...entry, value: payload.encry };
    }
  }
  return null;
}

function parseEncryptedValue(value) {
  if (value === true || value === false) {
    return { encrypted: value, label: value ? null : "PLAIN" };
  }

  const text = normalizeText(value);
  if (!text) return null;

  if (text.includes("dtls")) return { encrypted: true, label: "DTLS" };
  if (text.includes("tls")) return { encrypted: true, label: "TLS" };
  if (text.includes("plain")) return { encrypted: false, label: "PLAIN" };

  if (["1", "true", "yes", "y", "on", "secure", "encrypted"].includes(text)) {
    return { encrypted: true, label: null };
  }
  if (["0", "false", "no", "n", "off", "none", "unencrypted"].includes(text)) {
    return { encrypted: false, label: "PLAIN" };
  }

  return null;
}

export function protocolBadge(item) {
  const keys = sourceKeys(item);
  const hasMqtt = keys.includes("mqtt");
  const hasCoapStream = keys.includes("coap") || keys.includes("coap-mqtt");
  const hasRestBridgeSnapshot = keys.includes("rest");
  const hasDirectCoap = keys.includes("coap");
  const hasCoapBridge = keys.includes("coap-mqtt");

  if (hasMqtt && hasCoapStream) return "MQTT+COAP";
  if (hasMqtt && (hasCoapBridge || hasRestBridgeSnapshot)) return "COAP->MQTT";
  if (hasDirectCoap) return "COAP";
  if (hasCoapBridge || hasRestBridgeSnapshot) return "COAP->MQTT";
  if (hasMqtt) return "MQTT";

  const family = sourceFamilyFromPayloads(item);
  if (family === "coap") return "COAP";
  if (family === "mqtt") return "MQTT";

  return String(item?.lastSource || "unknown").toUpperCase();
}

export function encryptionBadge(item) {
  const record = firstEncryptedRecord(item);
  if (!record) {
    const modeRecord = modeEncryptionRecord(item);
    return modeRecord ? modeRecord.parsed.label : "UNKNOWN";
  }

  const parsed = parseEncryptedValue(record.value);
  if (!parsed) return "UNKNOWN";
  if (parsed.label) return parsed.label;
  if (!parsed.encrypted) return "PLAIN";

  const exactFamily = sourceFamilyFromPayloads({
    raw: record.payload,
    sourceRaw: {},
    lastSource: record.sourceKey,
    sourceLastSeenAt: record.sourceKey ? { [record.sourceKey]: 1 } : {}
  });
  if (exactFamily === "coap") return "DTLS";
  if (exactFamily === "mqtt") return "TLS";

  const family = sourceFamilyFromPayloads(item);
  if (family === "coap") return "DTLS";
  if (family === "mqtt") return "TLS";

  return "SECURE";
}

export function encryptionBadgeClass(item) {
  const label = encryptionBadge(item);
  if (label === "TLS" || label === "DTLS" || label === "SECURE") {
    return "badge ok";
  }
  if (label === "UNKNOWN") {
    return "badge warn";
  }
  return "badge";
}

export function freshnessBadge(item, now = Date.now()) {
  const lastDeviceSeenAt = Number(item?.lastDeviceSeenAt ?? 0) || 0;
  if (!lastDeviceSeenAt) return "IDLE";
  const ageMs = Math.max(0, now - lastDeviceSeenAt);
  if (ageMs <= 5 * 60 * 1000) return "LIVE";
  if (ageMs <= 30 * 60 * 1000) return "QUIET";
  return "STALE";
}

export function freshnessBadgeClass(item, now = Date.now()) {
  const label = freshnessBadge(item, now);
  if (label === "LIVE") return "badge ok";
  if (label === "STALE") return "badge alert";
  if (label === "QUIET") return "badge warn";
  return "badge";
}

export function recoveryBadge(item) {
  return item?.restoredFromStorage ? "RESTORED" : null;
}
