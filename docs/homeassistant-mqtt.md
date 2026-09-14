# Home Assistant MQTT publishers

[The automation factory](../integrations/homeassistant/mqtt-feeds.js) creates
three independent publishers: two garage contacts from `meross_cloud` cover
entities and an optional garage air-temperature feed from an external Shelly
sensor in HA. Source entity identifiers are supplied privately, never embedded
in the repository. These automations publish observations and answer cache
queries; they do not operate doors or force device refreshes.

## Topics and payloads

| Feed | Prefix | State topic suffix | Value |
| --- | --- | --- | --- |
| Door 1 | `stmq/garage/door1` | `/status/contact` | `open` / `closed`, or `null` when unknown/unavailable |
| Door 2 | `stmq/garage/door2` | `/status/contact` | `open` / `closed`, or `null` when unknown/unavailable |
| Optional garage air | `stmq/garage/air` | `/status/temperature` | Numeric Celsius; unavailable values remain unknown |

Each prefix also provides:

- `/command`: accepts `status_update`, QoS 1, without retention.
- `/availability`: retained `online` / `offline`, QoS 1.

HA's existing `homeassistant/status` topic supplies separate bridge availability
through its MQTT birth and last-will messages. The custom publishers have no timer
or heartbeat.

State reports use QoS 1 without retention. An illustrative door snapshot is:

```json
{
  "value": "closed",
  "unit": "state",
  "timestamp": "2026-09-14T10:00:00Z",
  "published_at": "2026-09-14T10:30:00Z",
  "available": true
}
```

Temperature snapshots use a numeric `value` and `unit: "C"`. `timestamp` comes
from the source entity's original `last_reported`; `published_at` is the bridge's
publication time. The timestamp describes HA's latest source report, not an
independently verified physical measurement. Repeated snapshots keep the same
timestamp until the source entity reports again. The `available` field describes
the snapshot; ST-MQ uses the separate availability topic for its availability gate.

## Publication and recovery

Each automation publishes on source state or attribute changes, HA startup,
MQTT birth (`homeassistant/status` becoming `online`) and its status query. A
normal publication sends source availability followed by the contact or
temperature snapshot. HA shutdown publishes offline. HA's MQTT last will exposes
loss of the bridge connection. A publisher that stops while HA remains connected
has no periodic deadline; Recheck can detect an unanswered query.

Status queries read HA's existing state. They prove that the publisher answered;
they do not poll the physical contact or establish a periodic temperature
measurement interval. An unavailable source cannot be converted to a closed door.
HA connectivity and source entity availability also remain distinct from the
physical device's last communication.

ST-MQ requests status after its response subscriptions succeed on startup or
reconnect, and during Recheck. With child availability configured, a live child
online report is required; retained child online cannot establish availability.
Availability and state may arrive in either order. A retained state alone cannot
complete Recheck.

Configure `mqtt.bridge_availability_topic: "homeassistant/status"` to invalidate
the source on HA `offline`, including retained offline. Live bridge `online`
requests status after an outage without duplicating an in-progress request.
Retained bridge online is connectivity context and cannot renew a source reading.
If no bridge status is initially available, a live child online report and state
reply can establish availability. ST-MQ resets bridge status on its own reconnect.

Both default door entries use `max_age_seconds: 0`, `mqtt.state_path: "value"`,
`mqtt.timestamp_path: "timestamp"`, their command/availability topics and
`mqtt.bridge_availability_topic: "homeassistant/status"`. Equipment display can recover a last-known
event-only contact without changing its source timestamp. The garage model's
five-minute source-age rule remains in force. A cached report predating an
availability failure also does not restore the model's current contact input.

## Optional temperature consumer

The air publisher does not change ST-MQ's selected garage temperature source.
Native Shelly MQTT remains the default. This disabled example shows the optional
HA route for the existing rear temperature signal:

```json
{
  "id": "garage_air",
  "label": "Garage air via HA",
  "area": "garage",
  "kind": "temperature",
  "signal": "garage_temperature",
  "enabled": false,
  "connection": "mqtt:stmq/garage/air/status/temperature",
  "max_age_seconds": 120,
  "mqtt": {
    "state_path": "value",
    "timestamp_path": "timestamp",
    "request_topic": "stmq/garage/air/command",
    "request_payload": "status_update",
    "availability_topic": "stmq/garage/air/availability",
    "bridge_availability_topic": "homeassistant/status"
  }
}
```

Before selecting this route, verify genuine source reports satisfy the garage's
two-minute freshness requirement and that the sensor represents the intended
protection location. Replace the existing route for that signal when enabling it.
A change-only feed can become stale while HA remains online. Queries containing
cached source timestamps cannot extend temperature validity.

## Installation and migration

Generate the three definitions with the private source entity identifiers and
install them alongside the existing automations. All five legacy topic routes
remain enabled for the separate production consumers until their migration starts.
The four legacy door automations are unchanged. The legacy temperature automation
uses its source state trigger instead of a minute timer, preserving its source,
topic, payload and retention. No minute temperature publisher remains. The new
topics can be verified with read-only status requests, including source timestamps,
availability and query replies, without moving either door.

Private configuration and automation backups belong in
`~/.config/st-mq/ha-door-migration`, with directory mode `0700` and file mode
`0600`. Do not copy household entity identifiers or exported automations into Git.
See the [topic migration guide](mqtt-topics.md) for the separate manual SmartThings
changes and ST-MQ cutover steps.
