# Home Assistant MQTT feeds

Home Assistant's MQTT integration connects HA publishers to their broker. Its
credentials are configured separately from ST-MQ's MQTT credentials. The standard
birth and will topic is `homeassistant/status`, with `online` and `offline` payloads.

[BMW CarData](charging/integrations/bmw.md) and the
[Caravan dehumidifier](caravan-dehumidifier.md) have their own field mappings,
freshness rules and control permissions. The optional garage-air publisher uses
a privately selected HA temperature entity. It does not replace the heat-pump
controller's BTHome input or the protection sender.

## Source timestamps and availability

The garage-air publisher preserves the source entity's `last_reported` timestamp
independently of its MQTT publication time. The Caravan dehumidifier bridge uses
the per-field receipt times from its [native observation adapter](../integrations/homeassistant/tuya-local-observation.md).
A cached snapshot keeps the original clocks. A change-only temperature source can
become stale while HA remains online, so its reporting cadence must satisfy the
consumer's freshness rule.

Source availability and HA's broker availability describe different connections.
Neither an online message nor a retained value establishes a new measurement.
Unrelated source changes do not refresh the timestamps of fields not reported.

## Installing the automations

[The companion installation guide](../integrations/homeassistant/README.md#installing-automations)
covers importing generated automation objects and preserving private mappings.
These are HA Core automations; installing the ST-MQ app does not install them.
