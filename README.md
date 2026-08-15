# nRF IoT Dashboard

![Dashboard data flow](docs/dashboard-flow.png)

> 中文：面向 nRF/NB-IoT 节点的 Web 面板，统一展示 MQTT、CoAP、HTTP 和 REST 拉取进入的数据，支持节点卡片、历史趋势和板载传感器状态。
>
> English: Web dashboard for nRF/NB-IoT nodes. It normalizes MQTT, CoAP, HTTP ingest, and REST-pulled telemetry into node cards, history charts, and on-board sensor status.

## 中文简介

这个仓库是 Nordic IoT Lab 的前端和轻量后端。它可以直接订阅 MQTT broker，也可以接收 CoAP/HTTP 上报，或者从已有服务器 REST 接口拉取快照。所有数据会被归一化为节点状态，然后展示在网页面板上。

适合用于：

- 看每个节点最后一次上报的数据
- 区分 MQTT plain、MQTT TLS、CoAP plain、CoAP DTLS 等来源
- 展示 HTU21D 温湿度、LIS2DH12TR 加速度、电池、电压、RSSI 等字段
- 根据同一份传感器上传数据派生 GDEY0213Z98 横屏电子纸状态，不需要单独上传屏幕状态包
- 从 PostgreSQL 查询历史趋势
- 作为部署在自有 HTTPS 域名后的 Web 控制台

## English Overview

This repository contains the dashboard service for Nordic IoT Lab. It can subscribe to an MQTT broker, receive CoAP/HTTP telemetry directly, or pull snapshots from an existing REST endpoint. Incoming payloads are normalized into node snapshots and rendered in the web UI.

Useful for:

- Viewing the latest telemetry per node
- Separating MQTT plain, MQTT TLS, CoAP plain, and CoAP DTLS sources
- Displaying HTU21D temperature/humidity, LIS2DH12TR acceleration, battery, voltage, and RSSI fields
- Deriving the GDEY0213Z98 horizontal e-paper screen from the same telemetry packet, without a separate display upload
- Querying historical trends from PostgreSQL
- Running behind your production HTTPS domain

## Data Flow / 数据流

```text
nRF firmware -> MQTT/CoAP/HTTP/REST -> dashboard backend -> normalized node store -> web UI
```

Supported ingestion paths:

- MQTT topic subscription, default `sensor/+/data`
- CoAP JSON receiver, default `coap://0.0.0.0:5683`
- HTTP bridge endpoint, `POST /api/ingest`
- REST snapshot puller via `UPSTREAM_PULL_URL`

## Quick Start / 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:8080
```

Run with Docker:

```bash
docker compose up -d --build
docker compose logs -f
```

## APIs / 接口

- `GET /api/health`
- `GET /api/nodes`
- `GET /api/nodes/:nodeId`
- `GET /api/nodes/:nodeId/history?limit=100`
- `GET /sensor`
- `POST /api/ingest`
- `POST /api/internal/store`
- `POST /api/pull-once`

Write endpoints require `API_WRITE_TOKEN`. Read endpoints are public by default for lab use;
set `READ_AUTH_TOKEN` before exposing the dashboard publicly.

## Payload Example / 数据示例

MQTT topic:

```text
sensor/9512-mqtt-tls/data
```

JSON payload:

```json
{
  "v": 2,
  "id": "9512-mqtt-tls",
  "seq": 42,
  "mode": "mqtt_tls",
  "wake": "motion",
  "mot": 1,
  "t": 24.6,
  "h": 58.2,
  "bat": 87,
  "mv": 4070,
  "rssi": -91,
  "cache": 3,
  "ax": 12,
  "ay": -28,
  "az": 1001,
  "vib": 1001,
  "tilt": 2,
  "shock": 1.001
}
```

Accepted aliases include:

- Node ID: `id`, `nodeId`, `device_id`, `mac_last4`, `mac`
- Mode/source: `mode`, `transport`, `protocol`, `encrypted`
- Temperature: `t`, `temperature`, `temp`, `temp_c`
- Humidity: `h`, `humidity`, `humi`, `hum`
- Battery percent: `bat`, `battery`, `battery_pct`, `batteryPercent`
- Battery voltage: `mv`, `voltage`, `vbat`, `vbat_v`, `battery_mv`
- Low-power state: `seq`, `wake`, `mot`, `cache`, plus `sample_seq`, `wake_reason`, `motion_event`, `cached_records`
- LIS2DH12TR: `ax`, `ay`, `az`, `vib`, `tilt`, `shock`, plus `accel_x_mg`, `accel_y_mg`, `accel_z_mg`, `shock_g`, `vibration_mg`, `tilt_deg`
- E-paper: `epaper_status`, `epaper_orientation`, `epaper_refresh_count`, `epaper_last_refresh` are optional; the current virtual screen is derived from the sensor packet fields above.

## Production Deployment Profile / 生产部署配置

- Web panel: `https://your-dashboard.example`
- MQTT backend ingest: `mqtts://your-mqtt.example:8883`
- MQTT topic: `sensor/+/data`
- Optional REST snapshot: `GET https://your-ingest.example/sensor`

When EMQX is the single ingress, keep direct CoAP disabled in this service:

```env
COAP_ENABLED=false
MQTT_BROKER_URL=mqtts://your-mqtt.example:8883
MQTT_TOPIC=sensor/+/data
MQTT_CA_CERT_PATH=/app/certs/ca.pem
MQTT_ALLOW_INSECURE_TLS=false
READ_AUTH_TOKEN=replace_with_long_random_read_token
API_WRITE_TOKEN=replace_with_long_random_write_token
PG_SSL=true
PG_SSL_REJECT_UNAUTHORIZED=true
```

If direct CoAP ingest is enabled, set `COAP_AUTH_TOKEN` and require devices to include
`token` or `authToken` in the JSON payload.

For the 9151v1.6 four-mode firmware, MQTT plain and MQTT TLS publish directly to
`sensor/<nodeId>/data`. CoAP plain can hit the direct UDP CoAP receiver with
`/ps/sensor/<nodeId>/data` style paths. For CoAP DTLS, terminate DTLS at the
gateway/proxy layer and forward the original JSON to MQTT or `POST /api/ingest`.
The dashboard uses compact v2 fields by default and still accepts the older
v1.3-v1.5 full/debug JSON. `mode`, `transport`, and `protocol` keep
`mqtt_plain`, `mqtt_tls`, `coap_plain`, and `coap_dtls` separate in the UI.

## Release / 版本

Current dashboard baseline:

```text
v0.9.23
```

Previous production test baseline: `v0.9.4`.

| Version | Date | Changes |
| --- | --- | --- |
| `v0.9.23` | 2026-08-15 | Reduce the Board Sensors virtual e-paper footprint by capping the preview shell at 700 px, preserving the 250:120 panel ratio while freeing vertical space for sensor cards; `npm test` passes. |
| `v0.9.22` | 2026-08-14 | Align the virtual 2.13-inch e-paper preview with the physical landscape layout: fixed screen proportions, centered ONLINE header, two-column content, compact bottom status box, and black header/status treatment; `npm test` passes. |
| `v0.9.21` | 2026-08-15 | Reduce the dashboard history request to the latest 15 compact records so device clicks load the recent state list quickly; `npm test` passes. |
| `v0.9.20` | 2026-08-15 | Speed up dashboard history loading by letting the UI request compact history records without the large raw payload, while canceling stale in-flight history requests when switching devices; `npm test` passes. |
| `v0.9.19` | 2026-08-14 | Stack the Board Sensors maintenance controls on mobile so the selector and action button no longer clip, while keeping the desktop selection flow and `REQUIRED`/`DONE` maintenance control; `npm test` still passes. |
| `v0.9.18` | 2026-08-14 | Add a maintenance-state selector in the Board Sensors panel so the server can mark a node as `REQUIRED` or `DONE` explicitly; `npm test` still passes. |
| `v0.9.17` | 2026-08-14 | Stretch the desktop Board Sensors preview to the hardware panel width while keeping the mobile stacked layout unchanged; `npm test` still passes. |
| `v0.9.16` | 2026-08-14 | Keep the maintenance flow in lockstep with firmware `2.17`: the dashboard still marks a node as serviced from the hardware panel, persists it in PostgreSQL, and shows the same FIX/OK indicator in the virtual screen and recent-state history; `npm test` passes `65/65`. |
| `v0.9.15` | 2026-08-14 | Add a maintenance state flow for the virtual e-paper screen: the dashboard can mark a node as serviced from the hardware panel, keep the state in PostgreSQL, and show the same FIX/OK indicator in the virtual screen and recent-state history. |
| `v0.9.14` | 2026-08-14 | Preserve firmware version while rebuilding historical e-paper frames, so the v0.9.9 virtual screen keeps its `FW2.15` value after server restart. |
| `v0.9.13` | 2026-08-14 | Restore PostgreSQL history samples into the in-memory e-paper alignment index during startup, so the virtual screen continues to follow `epdseq` after a server restart. |
| `v0.9.12` | 2026-08-14 | Keep the v0.9.9 virtual e-paper layout while strengthening screen-value fallbacks and power labels, move `RECENT STATES` above the virtual screen with a larger readable history view, and show the dashboard version beside the online service indicator. |
| `v0.9.11` | 2026-08-14 | Align the dashboard virtual e-paper screen with the physical panel acknowledgement sequence: compact `status` and `epd/epdc/epdseq/epdi/epr/ori` payload fields are normalized, the virtual screen follows the history sample referenced by `epdseq`, and the left node rail remains scrollable while rendering the updated hardware view. |
| `v0.9.10` | 2026-08-14 | Fix startup recovery behavior after restoring historical device state: a recovered snapshot no longer blocks the first live MQTT/CoAP packet as a firmware regression, while true stale firmware replay after a live packet is still preserved only in history. |
| `v0.9.9` | 2026-07-08 | Firmware/server sync fix for the virtual e-paper screen: strips `coap-dtls` suffixes back to the base asset ID, mirrors `9151v1.8` thresholds (`ALARM` at `>=40C`, `LOWBAT` below `15%`), and avoids rendering missing temperature, battery, shock, or tilt values as zero. Verified with compact v2 simulated packets for `NORMAL/MOTION/ALARM/LOWBAT` and `npm test` `60/60`. |
| `v0.9.8` | 2026-07-07 | Added a server-derived `epaperScreen` model and a matching virtual horizontal GDEY0213Z98 panel in the web UI. It reuses compact v2 sensor fields (`t/h/bat/rssi/mot/cache/mode/seq/shock/tilt`) and mirrors the firmware status priority without adding a separate e-paper upload packet. |
| `v0.9.7` | 2026-07-07 | Refined the web GUI into a unified premium dark hardware console: top status, KPI strip, sensor cards, history charts, controls, and the main board area now match the left device rail's dense glass-panel style. |
| `v0.9.6` | 2026-07-07 | Review fix for compact v2 production packets: dashboard encryption badges now infer `TLS`/`DTLS`/`PLAIN` from compact `mode`, upstream snapshot pulls preserve `mqtt`/`coap-mqtt` logical source from compact mode, and partial REST snapshots no longer clear live telemetry fields. |
| `v0.9.5` | 2026-07-07 | Added 9151 compact v2 payload support: `id/t/h/bat/mv/seq/wake/mot/cache/ax/ay/az/vib/tilt/shock`; normalized `mv`/`battery_mv` as voltage instead of battery percent; kept v1.3-v1.5 full/debug JSON compatibility; added node-store and history-store tests. |
| `v0.9.4` | 2026-07-06 | Added four-mode firmware source handling, `sensor/+/data` default topic, e-paper status fields, LIS2DH12 fields, and MQTT/CoAP source classification. |
