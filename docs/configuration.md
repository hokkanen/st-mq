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
| Saved Home Assistant app options | The authoritative installation settings in the app. An uploaded sparse `secrets.json` is an import into these settings. |
| Environment variables | Explicit process/deployment overrides, taking precedence over file settings. |
| Dashboard controls | Temporary session/deadline overrides, labeled native-device actions and the explicitly documented persistent device-bound choices below. Controller defaults remain configuration-owned. |
| `config.json.schema` and manifest metadata | Software configuration: accepted fields, types, ranges and Home Assistant packaging. These are not installation overrides. |

Any supported option can be overridden. Validation checks JSON syntax, field names,
types, ranges and supported combinations; it cannot establish whether installation
assumptions are physically true.
Approval and commissioning flags must describe the installation, rather than
being switched on simply to remove a blocked status. Algorithm versions and fixed
code constants follow the software's versioning contract.

For Charger 2, configure MQTT device identity and topic, then enable the
integration. Start/stop readiness is discovered automatically; native app settings
retain authority. Optional current limiting requires separate installation
phase/fuse settings and compatible live numeric capabilities. The manual
`verified`, model/firmware pins, connection-state lists and current minimum/step
fields are retired and rejected. Charger 2 records native lifetime-meter
increments directly; there is no session-energy comparison setting. See
[charging provider capabilities](charging-provider-capabilities.md).

Public defaults leave credentials, precise location, account identifiers and
private installation endpoints empty. The MQTT broker name `core-mosquitto` is Home
Assistant's standard service name; equipment IDs and topics are generic logical
names. TeslaMate's car `1` and `Home` geofence are conventional setup defaults,
not a VIN or a household address. Floor slab, copper pipe, heat-transfer and
equipment capacity assumptions are intentional public engineering defaults.
`test/public-config-privacy.test.js` guards these boundaries without printing
values on failure; it does not replace review of newly added settings.

## Keep the private file small

Garage manual control can be enabled with this sparse installation override:

```json
{"garage":{"enabled":true}}
```

It inherits public adapter topics and the Away preset. Sender MQTT topics default to `heatpump/garage/sender/state` and
`heatpump/garage/sender/command`. Configure the sender with that prefix, or set
`garage.sender.stateTopic` and `commandTopic` to its actual topics. Review and
set installation approval and protection parameters under `garage.protection`,
then use **Apply reviewed configuration** in **Data & settings** or restart. The
**Garage → Freeze protection → Pipe model & settings** section is read-only: it
compares the loaded configuration with actual sender readback. Configured approval
is not evidence that the sender accepted it or that protection is available.
See [Garage heating](garage.md).

The current Garage configuration contains manual-control enablement, the
Away preset, temperature evidence freshness, door visualization timing, local
protection parameters and the pump/sender connections. `maxSensorAgeMs` limits
displayed air-temperature evidence; source-specific deadlines can expire it
sooner. Each connection's
`maxAgeMs` limits its own reported status. `adapter.electricalSource` selects
native counter or power evidence for qualified Garage electricity intervals;
`none` disables interval derivation while native telemetry remains diagnostic.
There are no configured Normal targets, learned building coefficients or
economic scheduling settings for Garage. Those retired fields are rejected.

`garage.door_travel_seconds` is the full opening and closing time used for both
doors' linear visual movement. Its shared default is 18 seconds; accepted values
are 1–300 seconds, including fractions. For example,
`{"garage":{"door_travel_seconds":20}}` overrides the shared duration without
changing the equipment inventory. Use **Apply reviewed configuration** after
editing it. This is a visualization assumption, not measured door position or
confirmation that a command completed. It does not change door commands,
timeouts or recorded contact states.

Only write the leaves you need to change. Leave default topics, timing values,
equipment lists and empty credential placeholders out of the private file.
Keep any explicit value you intend to pin even if it currently equals a shared
default. Removing such a value lets future shared defaults take effect.

Objects merge recursively; arrays replace the complete array. In particular,
`equipment.devices` is a complete inventory when overridden, not a patch to one
device. Prefer the public inventory for common equipment definitions. In Home
Assistant's Configuration YAML editor, every equipment entry needs the schema's
object/list containers: use `mqtt: {}`, `readings: []` and
`temperature_control: {}` when that entry has no corresponding setup. An empty
temperature-control binding does not enable appliance automation. Sparse JSON
imports through ST-MQ fill missing required containers before saving to Supervisor;
when editing Home Assistant's YAML directly, supply those containers yourself.
An empty object does not clear an inherited object. Explicit `false`, zero and
permitted empty strings override defaults. Standalone supports `null` only for optional
fields; Home Assistant rejects `null`. Do not add JSON comments or invented
section headings as fields: the configuration validator rejects unknown keys.

On standalone installations the permanent file is
`$XDG_CONFIG_HOME/st-mq/secrets.json`, normally `~/.config/st-mq/secrets.json`;
`STMQ_CONFIG` can select another file. Start or **Apply reviewed configuration** rereads
and merges it without expanding or rewriting it. Removing an override restores
the shared default on the next application. Keep the directory at mode `0700`
and the file at `0600`.

In Home Assistant, save options under **Settings → Apps → Home Energy → Configuration**,
then use **Check & review configuration** and **Apply reviewed configuration**
in ST-MQ. The English form labels/descriptions come from `translations/en.yaml`;
the YAML editor uses the exact option keys in `config.json.schema`. These files
are still supported by the current Home Assistant app format.
An uploaded private file merges into those saved options and is removed after
successful import and application. Omitting a key from a later import preserves
its saved value, including an existing `!secret` reference. Supervisor resolves
those references for runtime use while the saved options retain them. An import
must use actual values; an explicit value replaces that field's saved reference.
See [Home Assistant setup](../DOCS.md) for import paths and
[standalone startup](startup.md) for environment overrides.

## Configuration recovery

If startup cannot load valid configuration, the application serves only a
configuration recovery screen. It does not open the recording database, connect
to equipment or start control. The screen explains the failure, identifies the
configuration source and lets you check corrected settings before restarting.
Database and other runtime failures are not configuration recovery cases.

In Home Assistant, open **Home Energy → Open Web UI**. Recovery accepts only
Home Assistant ingress; direct access stays closed. Correct and save the app's
options, or copy a current `secrets.json` to the upload path shown by the screen.
If saved options contain incompatible fields, choose the explicit replacement
workflow: the uploaded options replace saved installation overrides, and omitted
settings use public defaults. Review that full replacement before saving. The
previous saved options are backed up privately before replacement. A normal
import still merges and cannot remove an omitted incompatible field.

On standalone Linux, recovery listens only on `127.0.0.1`, using a valid
`STMQ_PORT` or port `1234`. The startup log identifies a temporary private access-key
file, readable only by the account running the application. Read that file locally
and enter its key in the recovery page. The key changes for each process; do not
share it or include it in diagnostic output. For a remote machine, use an SSH
tunnel as described in [standalone startup](startup.md#configuration-recovery).
Correct the permanent file at the path displayed by the screen. Environment
errors require correcting the launch environment and restarting.

Checking and reviewing do not authorize equipment control. Saving a reviewed
Home Assistant replacement also leaves the application in recovery; restart it
explicitly after the configuration is ready. Failed imports remain available for
correction. Recovery does not translate retired settings, migrate or reset a
database, or remove existing equipment restoration obligations.

## Check and review before applying

In **Data & settings → Connections & configuration → Configuration**, admins
choose **Check & review configuration** after saving their changes. This reads
the same source and runs the same configuration checks as application, without
saving imports, reconnecting providers or sending device commands. Errors leave
the loaded configuration in place. Correct the source and check again.

The review compares changed fields with the loaded configuration and shows
current/proposed values. Credentials, coordinates, account/device identifiers,
connection addresses, topics and free text remain hidden, including in the API
response. Engineering values and supported choices remain readable. Environment
overrides still take precedence; `effective` rows show the resulting runtime
values when they differ from the source. Restart-only changes are listed and disable
application of the entire review.

Choose **Apply reviewed configuration** to continue or **Cancel** to discard the
review. An unchanged configuration can still be applied to reconnect providers
and retry configured setup. Applying rechecks the source and loaded configuration; a changed or
expired review must be repeated. Reviews expire after five minutes and are held
only in memory. This prevents applying changes made after review. Family access
cannot see or request a review or apply settings. Read-only instances cannot use
this workflow. Existing equipment restoration and authority checks still apply.

The admin API uses `POST /api/settings/preview` with `{}`, then
`POST /api/settings/reload` with the returned `{"reviewId":"…"}`. The reload
endpoint rejects an empty request or an unreviewed configuration.

## Applying changes and restarting

**Check & review configuration** reports whether the proposed settings can be
applied while running. Heating strategy, comfort and learning settings,
electricity rates, recording policy and direct-access passwords can be applied
without restarting. With live input this includes provider connections,
location, sensor topics, polling intervals, H66 selection and its verification
file. Existing environment overrides continue to take precedence.

Input mode, web listeners, data/database locations and process environment need
a restart. A review containing a restart-only change cannot be partly applied.
Finish equipment tests first. Owned temporary settings must be restored before
reconnecting; unresolved restoration blocks the change until equipment is
available. An active heating cycle ends, while Away/Pause intent and learning
history remain. Password changes take effect immediately; direct-access tabs
may need the new password. Home Assistant ingress continues to use HA login.

## Admin and family web access

`controller.web_token` is the admin password for direct access.
`controller.web_family_token` is an optional family password, empty by default.
Set both in the existing private configuration or saved app options; family
access requires a nonempty admin password and the two must differ. On network
listeners each configured password must have at least 24 characters. Environment
variables `STMQ_API_TOKEN` and `STMQ_FAMILY_API_TOKEN` override their respective
fields, including explicit empty values.

Choose **Apply reviewed configuration** as admin to rotate or clear passwords without
restarting. Clearing the family password disables family login; clearing both
disables direct app access. Every accepted Home Assistant ingress session has
full ST-MQ admin access, independently of these passwords or the Home Assistant
user's administrator flag. The administrator-only sidebar entry controls
visibility, not ingress authorization. The family role applies only to direct
access with the family password; see [Home Assistant access details](../DOCS.md#home-assistant-files-and-permissions).

Family reads all application data with credentials concealed, may calculate
read-only heating-plan comparisons, and may record
firewood, remove entries within 15 minutes, operate DHWR, Away/Pause and manual
heating, Home Automatic/Pause and Garage manual modes, garage doors and all EV card controls. Every other write, export and
download requires admin. These permissions do not change equipment authority,
restoration or freeze protection. The role is not configurable. Native pump
parameters, equipment tests, heating-plan one-cycle approvals, pairing,
configuration, integration setup and electrical limits remain admin-only.

Standalone loopback access permits an empty admin password when family access
is disabled. Listening beyond loopback requires the passwords described above.
Use a trusted local network or an authenticated HTTPS reverse proxy for remote
direct access. Credentials are concealed in API responses; the direct-access
browser keeps its entered password in session storage for that tab. **Log out**
returns to the password prompt without stopping previously requested operations.
For ingress, use Home Assistant to log out.

## Database export destination

In **Export database**, **Save local copy** writes to the server directory in
`recording.export_directory`. Its shared default, `"~"`, means the home folder
of the operating-system account running the server. In an app or container,
this is that account's home inside the container. Choose a persistent directory
available to the server when copies must survive container replacement.
For Home Assistant, use `/config/st-mq/exports` to include local exports with the
ST-MQ app backup, or `/share/st-mq` and back up Share separately. `"~"` and
`"~/database-copies"` point inside the container and are not persistent app mounts.

To change the destination, merge an override such as
`"recording": { "export_directory": "~/database-copies" }` into the existing
configuration and choose **Apply reviewed configuration**. Use an absolute path, `"~"`,
or a path beginning with `"~/"`; other relative paths and `~user` paths are
rejected. The server account needs write permission to the destination.

**Download database** saves a copy through the browser. Both actions create a
complete SQLite snapshot with the same timestamped filename format. See
[database exports](recording.md#single-file-database-export) for details.

## Heating automation and manual controls

The [Heating plan explorer](heating-plan-explorer.md) compares hypothetical
settings without editing these defaults. Its admin-only one-cycle action stores
an expiring, equipment-bound approval for the reviewed opportunity. Explicit
temporary preferences are restored to configured behavior when their scope ends;
equipment protection and outstanding restoration duties remain active. Family
access permits simulation but cannot approve or cancel this one-cycle scope.

Home has a durable **Automatic / Pause** choice, bound to the equipment
identity and initially Pause without an end time. An optional resume time
returns to Automatic; clearing the time keeps Pause. Normal/Reduced manual
choices follow the pause duration, while Preheat always ends at its lease
deadline. Garage instead has persistent manual Normal/Away selections with no
expiry. Configuration owns its Away preset; the normal target is an explicit
device-bound choice. The heat-pump controller retains the requested target and
regulates locally. Changing a Garage mode does not replay native power/mode
edits.

The environment is Live, Simulation or History viewer. Read-only views cannot
change controls. Home automation, charging and Caravan power permissions remain
independent. `POST /api/automation` accepts Home only; Garage mode controls use
`POST /api/garage/heating`. Garage enablement and sender wiring are installation
configuration; fresh adapter evidence is still needed to send a request.

**Garage → Freeze protection**, below **Normal temperature**, displays the live
rear/front readings and explains protection behavior. Its **Pipe model & settings**
compares configured and reported parameters and explains the pipe calculation,
including its fixed safety factor of 2. That factor is a model assumption, not a
configurable or independently reported parameter. The live fold links to
**Connections & configuration → Garage freeze protection**, below **Home floor
preheating**, for installation and setup; that section links back to Garage.
Installation approval, margin, pipe geometry and heat transfer come only from
`garage.protection`;
there is no dashboard override or settings-write endpoint. With Garage enabled
and local write authority, the controller applies loaded configuration through
the sender's fresh MQTT command route. Confirmation requires matching device
readback. Network loss does not expire the sender's protection or the
heat-pump controller's selected target. The BLU H&T test source has no
two-probe protection. See [Garage heating](garage.md).

## Charging defaults and dashboard overrides

`easee.local_ocpp.server_url` is an optional connection override. When omitted or
empty, standalone setup detects the computer's LAN IPv4 address and uses
`ws://<detected address>:<local_ocpp.port>/ocpp` (port 9001 by default). A specific
usable local IPv4 listener host takes precedence over default-route selection.
Detection runs on startup and **Apply reviewed configuration**; it does not rewrite the
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

`charging.chargers.charger2.limiterEnabled` defaults to `true`: current follows
property load and shared charger priority during ordinary charging and Charge
now, independently of Automatic scheduling. An explicit `false` opts into basic
native-current start/stop. The installation's phase mapping, fuse ratings and
additive-current commissioning still require verification; changing the default
does not manufacture that evidence. Unknown or stale load data uses the configured
fallback ceiling. With Charger 2 priority, Shelly excludes Charger 1's draw from
its available headroom, and Charger 1's Equalizer must yield.

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
Guided charging inputs are assessment-only assumptions. Battery percentage,
vehicle target, capacity and schedules entered there never change these defaults,
ordinary session overrides, production planning inputs or vehicle identification.
Verifying a car target that differs from telemetry records an assessment-only
acknowledgement; it never replaces the reported value or the controller's target.

`charging.report_retention_days` controls automatic expiry of completed session
reports: 30 days by default, accepting whole numbers from 1 to 3650. Age is measured
from session end. Active reports and reports explicitly saved in the dashboard
are protected. Saved status belongs to the individual historical report and
survives restart; it does not replace this configuration default. Removing saved
status returns a completed report to this policy and may immediately expire it.

See [charging](charging.md).

Heat-pump parameter edits remain in effect until deliberately changed. Native
readback is authoritative; readable pump settings are not controller defaults.
Garage reads the heat-pump controller’s confirmed real target separately from
native 17°C. Normal/Away selection has no expiry. Local external-temperature
activation needs fresh Bluetooth evidence; sensor failure has an explicit
native 16°C fallback that preserves power. The sender’s independent frost
rescue may select HEAT/ON. Home Heat control actions Normal, Reduction and
Preheat retain their separate temporary behavior. The H66 assumptions
`compressor_integral_a1`, `aux_integral_a2`, `compressor_hysteresis_c`,
`aux_hysteresis_c` and `a2_basis` remain in configuration because the
integration cannot read those settings. Caravan dehumidifier Automatic power
and its OFF/ON thresholds are durable application choices bound to the
configured appliance and Shelly BLU connection. Their initial values are
enabled, 1°C OFF and 2°C ON; configuration owns only the sensor/actuator
wiring. Disabling Automatic power exposes manual native power without
disabling the independent native On/Off power test. Dehumidifier state
recording requires the Caravan meter to show a corresponding rise and fall;
humidity is not required. The test temporarily owns native power and durably
restores its previous setting before ordinary control resumes. A failed or
inconclusive check keeps recording paused until the next appliance or meter
connection is tested. The existing enabled `caravan` device in the same area
supplies the power evidence; the test adds no configuration threshold
defaults. Native heat-pump and dehumidifier controls directly change the
device's settings; local charger setup explicitly configures the device
connection. Those actions are labeled separately and do not change controller
configuration defaults.

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

## Electricity rates and historical interpretation

All monetary options under `electricity` are **c/kWh excluding VAT**. VAT is entered
as a percentage and applied once to spot, margin, tax and transfer. These are
application defaults, not a statement of current taxes or an installation's
electricity contract. Verify the rates and their effective dates for the installation:

| Option | Excluding VAT | Including 25.5% VAT |
| --- | ---: | ---: |
| `margin_ct_per_kwh_ex_vat` | 0.33 | 0.41415 |
| `tax_ct_per_kwh_ex_vat` | 2.325 | 2.917875 |
| `day_transfer_ct_per_kwh_ex_vat` | 2.66 | 3.3383 |
| `night_transfer_ct_per_kwh_ex_vat` | 1.56 | 1.9578 |
| `winter_day_transfer_ct_per_kwh_ex_vat` | 3.32 | 4.1666 |
| `other_transfer_ct_per_kwh_ex_vat` | 1.65 | 2.07075 |

The numeric VAT-exclusive defaults are in `config.json`. `vat_percent` defaults
to `25.5`; `transfer_tariff` defaults to `day-night`. Daytime is 07:00–22:00 Finnish time. Seasonal winter daytime is
November–March, Monday–Saturday 07:00–22:00; Sundays and all other times use the
lower seasonal rate. Seasonal is available but is not activated automatically.

The optional `electricity.effective_date` is a Finnish calendar date. First-use
rates begin today if no date is supplied; subsequent changes begin when loaded.
Rates, transfer amounts and VAT are saved per period with an explicit tax basis
so future changes preserve historical calculations. Missing tax basis is not
interpreted as an older native representation. Explicit dated VAT-inclusive
tariff facts remain valid. Unstarted scheduled changes can be revised in options.
For chart history and timing comparisons, missing historical contract periods
use the nearest known rates while preserving historical spot prices. If only
today's rates are known, those rates apply to earlier readings. The historical
local time determines the day/night or seasonal transfer rate. These price
assumptions are labelled in the interface; known dated rates remain unchanged.
Simulation prices remain labelled synthetic and independent of the household
contract.

## Section map

The public `options` and `schema` use the same section order. Settings stay with
the feature that owns them; whitespace separates related groups within the
larger sections without adding another configuration format.

| Sections, in file order | Settings they own |
| --- | --- |
| `controller`, `garage`, `charging`, `electricity` | Topology, Home operation/heating and web access passwords, Garage presets, local-protection sender and pump adapter, charger/vehicle sources, permanent charging defaults and report retention, electricity tariffs. |
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
