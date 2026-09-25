# Configuration guide

ST-MQ uses shared defaults and sparse installation overrides. The JSON field
paths are the same in both files; nested objects merge without copying their
other fields. There is no separate file to maintain for each feature.

## Where a setting belongs

| Location | Purpose |
| --- | --- |
| `config.json.options` | Shared defaults, standard MQTT topics, equipment definitions and engineering defaults. Changes here affect installations that have no override. |
| Standalone `secrets.json` | Credentials, private locations/device identifiers and only the installation choices you want to supply or override. Non-secret overrides are allowed. |
| Saved Home Assistant add-on options | The authoritative installation settings in the add-on. An uploaded sparse `secrets.json` is an import into these settings. |
| Environment variables | Explicit process/deployment overrides, taking precedence over file settings. |
| Dashboard controls | Explicit temporary session/deadline overrides and labeled device actions; permanent controller defaults are edited only in configuration. |
| `config.json.schema` and manifest metadata | Software configuration: accepted fields, types, ranges and Home Assistant packaging. These are not installation overrides. |

Any supported option can be overridden. Validation checks field names, types and
ranges; it cannot establish whether installation assumptions are physically true.
Approval and commissioning flags must describe the installation, rather than
being switched on simply to remove a blocked status. Algorithm versions and fixed
code constants follow the software's versioning contract.

## Keep the private file small

For an installation whose owner has enabled Garage control and approved the
protection assumptions, the complete Garage override is:

```json
{
  "garage": {
    "enabled": true,
    "protection": {
      "approved": true
    }
  }
}
```

Merge that section into your existing file, keeping credentials and other
intentional overrides. It inherits the public driver, MQTT topics, sensor
requirements and protection parameters. Approval does not commission the Pill or
make an unavailable adapter ready; see [Garage heating](garage.md).

Only write the leaves you need to change. Leave default topics, timing values,
equipment lists and empty credential placeholders out of the private file.
Keep any explicit value you intend to pin even if it currently equals a shared
default. Removing such a value lets future shared defaults take effect.

Objects merge recursively; arrays replace the complete array. In particular,
`equipment.devices` is a complete inventory when overridden, not a patch to one
device. Prefer the public inventory for common equipment definitions. An empty
object does not clear an inherited object. Explicit `false`, zero and permitted
empty strings override defaults. Standalone supports `null` only for optional
fields; Home Assistant rejects `null`. Do not add JSON comments or invented
section headings as fields: the configuration validator rejects unknown keys.

On standalone installations the permanent file is
`$XDG_CONFIG_HOME/st-mq/secrets.json`, normally `~/.config/st-mq/secrets.json`;
`STMQ_CONFIG` can select another file. Start or **Apply configuration** rereads
and merges it without expanding or rewriting it. Removing an override restores
the shared default on the next application. Keep the directory at mode `0700`
and the file at `0600`.

In Home Assistant, save add-on options and then choose **Apply configuration**.
An uploaded private file merges into those saved options and is removed after
successful import and application. Omitting a key from a later import preserves
its saved value. See [permanent configuration](../README.md#permanent-configuration-and-prices)
for exact paths, reload behavior and restart requirements.

## Charging defaults and dashboard overrides

`charging.defaults` supplies both charging points whenever the vehicle is
unidentified: `readyBy: "06:00"`, `manualSoc: 20`, `minimumSoc: 80`, and
`capacityKwh: 74`. `charging.vehicles.bmw.defaults` and
`charging.vehicles.tesla.defaults` override only the leaves supplied for the
identified vehicle. Their public capacity defaults are 74 kWh and 57 kWh;
other values inherit the shared defaults. Capacity and starting charge are
planning assumptions when no applicable live reading exists.

The permanent automatic scheduling switches are
`charging.chargers.charger1.schedulingEnabled` and
`charging.chargers.charger2.schedulingEnabled`, both false by default.
Charger 2's separate `enabled` field controls its physical integration and does
not grant scheduling or commissioning permission. `charging.priority` is
`balanced`, `charger1` or `charger2`, initially `balanced`.

For example, merge only these intentional choices into your configuration:

```json
{
  "charging": {
    "defaults": { "readyBy": "07:00" },
    "chargers": { "charger1": { "schedulingEnabled": true } },
    "vehicles": { "tesla": { "defaults": { "minimumSoc": 90 } } }
  }
}
```

**Save for this session** cannot change these defaults. Its scope ends with the
physical connection; restart preserves only the same ongoing session. Automatic
scheduling enablement and priority are shown read-only in the dashboard. **Charge
Now** releases automatic scheduling for the current connection, subject to
native limits and device readiness. See [charging](charging.md).

Heat-pump parameter edits remain in effect until deliberately changed. Native
readback is authoritative; readable pump settings are not controller defaults.
Garage initially reads a fresh unambiguous native setting. A chosen lower room
target is retained as device-bound application state because external sensing
uses a native 17°C target. It has no expiry or configured temperature fallback.
Fresh native/sensor evidence is still required to activate the external feed.
Home Heat control actions Normal, Reduction and Preheat retain their separate
temporary behavior. The H66 assumptions `compressor_integral_a1`,
`aux_integral_a2`, `compressor_hysteresis_c`, `aux_hysteresis_c` and `a2_basis`
remain in configuration because the integration cannot read those settings.
Native heat-pump and dehumidifier controls directly change the device's settings;
local charger setup explicitly configures the device connection. Those actions
are labeled separately and do not change controller configuration defaults.

## Heating strategies and limits

Home `controller.savings_strategy` and Garage `garage.savingsStrategy` choose
`gentle`, `balanced` or `savings`, displayed as **Gentle**, **Balanced** and
**More savings**. Both default to Balanced. Change the owning configuration
source and choose **Apply configuration**. The **Heating strategy & comfort**
and **Heating strategy & protection** sections explain the current strategy,
its decision rules and independent limits. **Pause price control** temporarily
suspends automatic savings; every named strategy can still start worthwhile
heating changes.

| Strategy | Home minimum benefit before other burdens | Garage threshold multiplier | Benefit retained |
| --- | --- | --- | --- |
| Gentle | 50 cents | 1.5 × `minSavingsEur` | At least 60% of best qualifying benefit |
| Balanced | 30 cents | 1 × `minSavingsEur` | At least 80% |
| More savings | 10 cents | 0.5 × `minSavingsEur` | Greatest qualifying benefit |

These are decision policies, not predicted annual savings. Home additionally
prices temperature variation and cycle duration. Garage chooses the shortest
qualifying safe pause retaining the selected share of benefit. Garage
`minSavingsEur` is the threshold at Balanced, after estimated recovery cost and
uncertainty: the default €0.50 gives effective thresholds of €0.75, €0.50 and
€0.25 respectively. `minOffMs`, `minOnMs`, `maxPausesPerDay`, both rear/front
sensors and protection requirements remain independent constraints. See
[Garage policy](garage-model.md#one-opportunity-at-a-time).

Home's shared `controller.max_drop_c` and `controller.max_rise_c` apply around
each participating room's learned reference, falling back to the overall comfort
reference where needed. The strategy changes selection within these bounds;
it never widens them. Room references are learned separately, but there are no
separate configured drop/rise limits per room. The heat models provide predictions
and evidence; these configured decision rules do not change how they learn.

The retired numeric fields `controller.savings_aggressiveness` and
`garage.aggressiveness`, and the ineffective `garage.frontRequired` flag, are
rejected. There are no aliases or automatic conversions. Both Garage protection
locations have always been required by the current protection algorithm.
Unsupported saved development settings require a deliberate fresh database;
loading or applying configuration never rewrites the owner's source.

## Section map

The public `options` and `schema` use the same section order. Settings stay with
the feature that owns them; whitespace separates related groups within the
larger sections without adding another configuration format.

| Sections, in file order | Settings they own |
| --- | --- |
| `controller`, `garage`, `charging`, `electricity` | Home operation and heating, Garage policy/adapter, charger/vehicle sources and permanent charging defaults, electricity tariffs. |
| `geoloc`, `mqtt`, `entsoe`, `easee`, `teslamate` | Location, broker access and provider connections. `easee.local_ocpp` contains the authenticated local charger listener and explicit authorization tags; see [Easee setup](charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later). |
| `equipment` | The current MQTT/Shelly equipment inventory and device mappings. |
| `acquisition`, `recording` | Provider polling/freshness and recording/storage settings. |
| `pairing`, `replication` | Instance pairing, failover and database replication. |

Equipment mappings use `equipment.devices`. Retired role-based Shelly and
individual MQTT temperature-topic fields are rejected. The heat-pump adapter
belongs to `garage.adapter`; physical Charger 2 belongs to `charging.chargers.charger2`.

## Adding a feature or changing a default

Add a field beside related fields in the owning section and in the matching
schema position. Give a new top-level section a clear owner and place it beside
related sections. Update this map when adding a section. Do not append unrelated
settings at the end of a file or duplicate defaults into private examples.
Before v1.0.0, update field paths and all current callers together when the design changes. Reject retired paths; do not add development configuration migrations.

Feature tests should configure the synthetic devices and integrations their
scenario needs. Tests specifically about public defaults should read the public
manifest. This keeps startup/reconnect tests independent of unrelated equipment
changes while retaining coverage for fresh-installation defaults and sparse
installation overrides. The shared Garage default remains disabled and
unapproved; a separate override test verifies that an owner's explicit choices
work while inheriting public topics and protection parameters.
