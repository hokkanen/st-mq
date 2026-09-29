# Configuration guide

[F3: configuration and UI ownership](../AGENTS.md#f3) is the governing policy;
this guide specifies its settings and persistence rules. Apply the
[conflicting-request process](../AGENTS.md#conflicting-requests) before changing
that ownership boundary.

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
| Dashboard controls | Temporary session/deadline overrides, labeled native-device actions and the explicitly documented persistent device-bound choices below. Controller defaults remain configuration-owned. |
| `config.json.schema` and manifest metadata | Software configuration: accepted fields, types, ranges and Home Assistant packaging. These are not installation overrides. |

Any supported option can be overridden. Validation checks field names, types and
ranges; it cannot establish whether installation assumptions are physically true.
Approval and commissioning flags must describe the installation, rather than
being switched on simply to remove a blocked status. Algorithm versions and fixed
code constants follow the software's versioning contract.

## Keep the private file small

Garage manual control can be enabled with this sparse installation override:

```json
{"garage":{"enabled":true}}
```

It inherits public adapter topics and the Away preset. Sender MQTT topics default to `heatpump/garage/sender/state` and
`heatpump/garage/sender/command`. Configure the sender with that prefix, or set
`garage.sender.stateTopic` and `commandTopic` to its actual topics. Review and
apply the protection settings in the Frost protection panel. Approval stored in application defaults
is not evidence that the sender accepted it. The panel reports actual sender
settings and freshness. See [Garage heating](garage.md).

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

## Admin and family web access

`controller.web_token` is the admin password for direct access.
`controller.web_family_token` is an optional family password, empty by default.
Set both in the existing private configuration or saved add-on options; family
access requires a nonempty admin password and the two must differ. On network
listeners each configured password must have at least 24 characters. Environment
variables `STMQ_API_TOKEN` and `STMQ_FAMILY_API_TOKEN` override their respective
fields, including explicit empty values.

Choose **Apply configuration** as admin to rotate or clear passwords without
restarting. Clearing the family password disables family login; clearing both
disables direct add-on access. Home Assistant ingress retains full admin access
through Home Assistant authentication, independently of these passwords.

Family reads all application data with credentials concealed, and may record
firewood, remove entries within 15 minutes, operate DHWR, Away/Pause and temporary
heating, Home automation and Garage manual modes, garage doors and all EV card controls. Every other write, export and
download requires admin. These permissions do not change equipment authority,
restoration or freeze protection. The role is not configurable; see the
[complete access policy](../README.md#connections-and-access).

## Database export destination

In **Export database**, **Save local copy** writes to the server directory in
`recording.export_directory`. Its shared default, `"~"`, means the home folder
of the operating-system account running the server. In an add-on or container,
this is that account's home inside the container. Choose a persistent directory
available to the server when copies must survive container replacement.

To change the destination, merge an override such as
`"recording": { "export_directory": "~/database-copies" }` into the existing
configuration and choose **Apply configuration**. Use an absolute path, `"~"`,
or a path beginning with `"~/"`; other relative paths and `~user` paths are
rejected. The server account needs write permission to the destination.

**Download database** saves a copy through the browser. Both actions create a
complete SQLite snapshot with the same timestamped filename format. See
[database exports](recording.md#single-file-database-export) for details.

## Heating automation and manual controls

Home has a durable **Plan only / Automatic** choice, bound to the equipment
identity and initially Plan only. Garage instead has persistent manual Normal/Away
selections with no expiry. Configuration owns its Away preset; the normal target
is an explicit device-bound choice. The Pill retains the requested target and
regulates locally. Changing a Garage mode does not replay native power/mode edits.

The environment is Live, Simulation or History viewer. Read-only views cannot
change controls. Home automation, charging and Caravan power permissions remain
independent. `POST /api/automation` accepts Home only; Garage mode controls use
`POST /api/garage/heating`. Garage enablement and sender wiring are installation
configuration; fresh adapter evidence is still needed to send a request.

The Frost protection panel displays the Gen3 sender's confirmed configuration and
state. Explicit edits go to the sender and are confirmed by readback. Network loss
does not expire the sender's protection or Pill's selected target. The BLU H&T
test source has no two-probe protection. See [Garage heating](garage.md).

## Charging defaults and dashboard overrides

`easee.local_ocpp.server_url` is an optional connection override. When omitted or
empty, standalone setup detects the computer's LAN IPv4 address and uses
`ws://<detected address>:<local_ocpp.port>/ocpp` (port 9001 by default). A specific
usable local IPv4 listener host takes precedence over default-route selection.
Detection runs on startup and **Apply configuration**; it does not rewrite the
configuration file. Supply `server_url` explicitly if detection is ambiguous or
the charger needs a different reachable address or proxy. Paired operation uses
the shared virtual IP; an explicit URL must exactly match that shared endpoint.
The live **Charger 1 local connection** status shows the effective base URL and
its source. See [Easee endpoint setup](charging-easee.md#endpoint-and-pairing) for
detection limits, stable addressing and proxy requirements.

`charging.defaults` supplies both charging points whenever the vehicle is
unidentified: `readyBy: "06:00"`, `manualSoc: 20`, `minimumSoc: 80`, and
`capacityKwh: 74`. `charging.vehicles.bmw.defaults` and
`charging.vehicles.tesla.defaults` override only the leaves supplied for the
identified vehicle. Their public capacity defaults are 74 kWh and 57 kWh;
other values inherit the shared defaults. Capacity and starting charge are
planning assumptions when no applicable live reading exists.

Automatic charging and shared charger priority are persistent dashboard
choices. Automatic charging starts OFF and priority starts Balanced on a fresh
installation. They survive restart and unplugging for the same equipment;
changing equipment identity clears its control choices. These are not
configuration fields. Charger 2's configured `enabled` field controls its
physical integration and does not grant scheduling or commissioning permission.

For example, merge only these intentional choices into your configuration:

```json
{
  "charging": {
    "defaults": { "readyBy": "07:00" },
    "vehicles": { "tesla": { "defaults": { "minimumSoc": 90 } } }
  }
}
```

**Save for this session** cannot change these defaults. Its scope ends with the
physical connection; restart preserves only the same ongoing session. **Charge
now** releases automatic scheduling for the current connection even with
Automatic charging OFF, subject to native limits and device readiness.
See [charging](charging.md).

Heat-pump parameter edits remain in effect until deliberately changed. Native
readback is authoritative; readable pump settings are not controller defaults.
Garage reads the Pill’s confirmed real target separately from native 17°C.
Normal/Away selection has no expiry. Local external-temperature activation needs
fresh Bluetooth evidence; sensor failure has an explicit native 16°C fallback
that preserves power. The sender’s independent frost rescue may select HEAT/ON.
Home Heat control actions Normal, Reduction and Preheat retain their separate
temporary behavior. The H66 assumptions `compressor_integral_a1`,
`aux_integral_a2`, `compressor_hysteresis_c`, `aux_hysteresis_c` and `a2_basis`
remain in configuration because the integration cannot read those settings.
Caravan dehumidifier Automatic power and its OFF/ON thresholds are durable
application choices bound to the configured appliance and Shelly BLU connection.
Their initial values are enabled, 1°C OFF and 2°C ON; configuration owns only the
sensor/actuator wiring. Disabling Automatic power exposes manual native power
without disabling the independent humidity-agreement recording gate.
Native heat-pump and dehumidifier controls directly change the device's settings;
local charger setup explicitly configures the device connection. Those actions
are labeled separately and do not change controller configuration defaults.

## Heating strategies and limits

Home `controller.savings_strategy` selects Gentle, Balanced or More savings;
Balanced is the default. The minimum benefit before other burdens is respectively
50, 30 or 10 cents. These are decision rules, not annual savings predictions.
Home's Heating strategy & comfort panel explains the policy and independent limits.
Garage has no savings strategy or economic temperature changes.

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

## Topology and role

Use one `controller.topology` choice. Both computers in a mirror or pair use the
same topology. Only mirror mode has a configured master/slave role, `mirror.role`.

| Topology | Role ownership | Settings read and behavior |
| --- | --- | --- |
| `standalone` (default) | Local runtime is master; no role setting | Local controller/provider settings; no synchronization. The UI shows **Standalone**. |
| `mirror` | `mirror.role: "master"` (default) | Local controller settings and `mirror` SSH destination/transfer settings; controls locally and sends snapshots. **Mirror · Master**. |
| `mirror` | `mirror.role: "slave"` | `mirror.directory` and `mirror.stale_seconds`; displays verified snapshots without device connections or control. Outgoing SSH settings are unnecessary. **Mirror · Slave**. |
| `pair` | Saved pair authority; fresh empty installations start as slaves | Local future-controller settings and `pair` connection, storage and virtual-IP settings; explicit promotion establishes the first master. **Pair · Master** or **Pair · Slave** reflects the actual runtime role. |

`STMQ_TOPOLOGY` overrides topology. `STMQ_MIRROR_ROLE` overrides `mirror.role`.
Pair and standalone topologies have no configured role. Master authority alone
does not enable automatic control: each feature has its own dashboard permission.
`controller.mode` and `STMQ_MODE` are retired and rejected, including during
Home Assistant bootstrap; remove them from private configuration before startup.

[Mirror mode](replication.md) uses SSH and fixed local roles. [Pair mode](pairing.md)
uses the encrypted HTTP peer protocol and manual role changes. Fresh pair installations without local history
start as slaves; after setup, manually promote exactly one computer to establish
the first master. Existing unclassified local history starts protected.
Persisted authority survives handover and restart. Handover
and promotion write pair state, never the configuration file. Copied database
contents cannot grant authority or replace local credentials.

The sections are `mirror` and `pair`, with no `enabled` fields. Pair owns
`pair.snapshot_directory` and `pair.stale_seconds`; it does not read the mirror
section. Connection environment settings use `STMQ_MIRROR_*` and `STMQ_PAIR_*`.
The former `replication`/`pairing` sections, `controller.role`, any `pair.role`,
`primary`/`replica` role values, `STMQ_ROLE`, `STMQ_REPLICATION_*`,
`STMQ_REPLICA_*` and `STMQ_PAIR_ENABLED` are rejected with actionable errors.
There are no aliases or automatic configuration/state conversions. Incompatible
saved state is reported before mutation; it is not silently reset, overwritten
or migrated. This includes saved pair authority and standalone controller
identity. Follow the reported guidance for a deliberate new setup with a fresh
state directory; preserve the rejected files.

## Section map

The public `options` and `schema` use the same section order. Settings stay with
the feature that owns them; whitespace separates related groups within the
larger sections without adding another configuration format.

| Sections, in file order | Settings they own |
| --- | --- |
| `controller`, `garage`, `charging`, `electricity` | Topology, Home operation/heating and web access passwords, Garage presets, local-protection sender and pump adapter, charger/vehicle sources and permanent charging defaults, electricity tariffs. |
| `geoloc`, `mqtt`, `entsoe`, `easee`, `teslamate` | Location, broker access and provider connections. `easee.local_ocpp` contains the authenticated local charger listener and explicit authorization tags; see [Easee setup](charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later). |
| `equipment` | The current MQTT/Shelly equipment inventory and device mappings. |
| `acquisition`, `recording` | Provider polling/freshness and recording/storage settings. |
| `pair`, `mirror` | Pair peer connection, snapshots, manual handover and recovery; mirror role, SSH connection and snapshots. `controller.topology` selects which is used. |

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
