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
| Dashboard controls | Everyday preferences and temporary actions described by the relevant feature. |
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

## Section map

The public `options` and `schema` use the same section order. Settings stay with
the feature that owns them; whitespace separates related groups within the
larger sections without adding another configuration format.

| Sections, in file order | Settings they own |
| --- | --- |
| `controller`, `garage`, `charging`, `electricity` | Home operation and heating, Garage policy/adapter, charger and vehicle sources, electricity tariffs. |
| `geoloc`, `mqtt`, `entsoe`, `easee`, `teslamate` | Location, broker access and provider connections. |
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
