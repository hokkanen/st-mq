# Caravan dehumidifier

The **electriQ DESD8LW** appears below air and energy readings in
**Garage → Sensors & More equipment → Caravan**. Its native Home Assistant
entities connect through the [MQTT automation generator](../integrations/homeassistant/dehumidifier.js).
Use **Tuya Local** entities for local-network operation. Install and commission
Tuya Local in Home Assistant first, using its
[setup instructions](https://github.com/make-all/tuya-local#configuration).
Account-assisted setup retrieves the local key once; runtime device control uses
the LAN. This implementation uses the verified DESD8LW data points: 1 for power,
2 for target humidity, 4 for fan speed and 6 for measured relative humidity.
The DESD9LW and Qlima profiles describe different data-point types or settings.

The bridge currently maps native power, 30–80% target humidity in increments of
five, and Low/Medium/High fan settings. Unsupported modes, Auto fan and louvre
settings are omitted. Controls use the bridge's advertised capabilities; missing
or unsupported options cannot be requested through either the UI or HTTP API.
Capabilities do not prove successful execution: confirmation requires a fresh
matching device report. Never use the Caravan energy plug as the appliance power
control; native shutdown allows its cooling cycle to finish.

The [manufacturer's DESD8LW manual](https://www.electriq.co.uk/files/pdf/DESD8LW%2020210901.pdf)
describes about three to four minutes of drying after native Off and requires
five minutes before restarting. For the configured Caravan native profile, every
application On path waits five minutes after actual admitted native Off: the
power check, Automatic, manual power and restoration all share the same fence.
The saved transition keeps its original appliance source, MQTT receipt and
writer admission clocks. Repeated healthy Off reports do not move that boundary.
The current process also requires five elapsed monotonic minutes from the native
MQTT receipt of that Off or first fresh connection confirmation. This receipt is
captured before queued writes, subscription buffering and deferred timestamp
admission. Small or repeated forward wall-clock corrections cannot shorten the
physical wait; time already spent waiting for admission still counts. The card's
not-before time projects the longer remaining restriction onto the current wall
clock without changing the saved transition. Missing or invalid local elapsed
evidence cannot authorize On. This process-local restriction is discarded after
restart or loss of native continuity, when the fresh confirmation rule below applies.
The application does not prevent an independent native On or infer who sent it.

Restart, connection loss and actual native-power freshness expiry leave an
unobserved interval. The first genuinely fresh admitted Off afterward starts a
separate conservative five-minute confirmation wait, once for that connection.
It does not invent an Off transition or renew the earlier transition's clocks.
A queued report already stale when admitted cannot establish this confirmation.
Clock rollback cannot shorten an existing saved wait. A different route or
physical appliance cannot inherit the earlier timing or On restoration.
Timing is a restriction, never On permission; current authority, identity,
fresh native feedback and all existing test/temperature checks still apply.

The card starts with reported power and the supported native humidity and fan
controls. **Automatic power** shows the saved enabled state and thresholds;
expand it to edit the switch and thresholds, then use **Save changes** or
**Discard**. Unsaved edits do not change the active policy. Recording status
stays visible, and **Power check** expands the observed rise/fall and test
criteria. The appliance's measured humidity appears beside its fan and report time;
the air sensor keeps its own reading above, without a duplicate in Power check.
Humidity readings remain optional live information. Native settings
and policy edits are locked while the test or its restoration is active. Family
and replica views keep their read-only restrictions.

Installation entity IDs and credentials stay outside the repository. Set up the
local integration and bridge in this order:

1. Install the [DESD8LW profile](../integrations/homeassistant/tuya-local-desd8lw.yaml)
   into Home Assistant Core's configuration directory at
   `custom_components/tuya_local/devices/electriq_desd8lw_dehumidifier.yaml`
   and select that profile for the appliance. The current official Terminal &
   SSH app exposes Core's folder at `/homeassistant`; some other file tools
   expose `/config`. ST-MQ's own `/config` is a different app folder. It creates a native humidifier,
   a **Fan speed** select and a measured-humidity sensor. The select writes only
   fan speed, so changing it does not implicitly switch the appliance on.
2. Apply the [received-observation adapter](../integrations/homeassistant/tuya-local-observation.md).
   Its installer checks the exact reviewed Tuya Local 2026.9.2 source hashes and
   preserves private backups before changing Python files. A separately reviewed
   Home Assistant restart loads the patch. The adapter exposes confirmed raw
   device replies in the humidifier's `local_observations` attribute.
   A bounded current-source refresh can request an earlier native status read
   after socket replacement withdraws those fields. Unknown fields stay unknown
   until genuinely received; this does not change the recording grace, physical
   association, native commands or five-minute restart protection.
3. Generate the two automations using `dehumidifierAutomations({ id, label,
   prefix, humidifierEntity, fanSpeedEntity, deviceIdentity })`, with prefix
   `stmq/garage/caravan_dehumidifier`. `humidifierEntity` must be the native
   `humidifier` entity and `fanSpeedEntity` its same-device `select` entity.
   Review and install each generated object as a separate automation using
   Home Assistant's **Edit in YAML** editor, as described in
   [installing the automations](homeassistant-mqtt.md#installing-the-automations).
   Its MQTT integration stays on HA's fixed broker and uses the standard
   `homeassistant/status` birth/will topic. ST-MQ routes this bridge through
   `mqtt.ha` when configured, otherwise primary; see
   [broker routing](configuration.md#primary-mqtt-and-ha-hosted-integrations).
   ST-MQ app installation does not
   install the profile, source patch or these Core automations.

`deviceIdentity` is the lowercase SHA-256 digest of the UTF-8 Tuya Local native
`unique_id`; for this appliance without a child device ID, that is the configured
Tuya device ID. It is not the Home Assistant entity ID or device-registry ID.
The observation adapter computes this digest from the actual configured native
device. The bridge requires it to match the privately selected digest before
publishing usable observations or accepting a command. Replacing the appliance
invalidates the earlier saved policy and location-test evidence.

Normal Tuya Local entity values may temporarily include pending command values.
The bridge reads all actual values and clocks from `local_observations`, while
native entity metadata establishes the supported controls. Missing adapter data,
restored states or a different physical identity leave the bridge unavailable.
Home Assistant's `last_reported` and a successful `update_entity` call cannot
substitute for received device evidence.
The adapter distinguishes positively identified unsolicited partial status
packets from the delayed matched complete query reply; the latter still removes
omitted power evidence. Unqualified or overlapping query correlation remains
conservative. This changes neither the independent recording/qualification gate
nor restoration timing. See the [adapter contract](../integrations/homeassistant/tuya-local-observation.md).

## MQTT contract

The prefix is `stmq/garage/caravan_dehumidifier`, separate from the native
Caravan energy plug prefix `stmq/garage/caravan`.

| Suffix | Direction | Payload |
| --- | --- | --- |
| `/state` | Bridge → ST-MQ | Full JSON snapshot shown below |
| `/availability` | Bridge → ST-MQ | `online` or `offline` |
| `/get` | ST-MQ → bridge | `{}` requesting a read-only status snapshot |
| `/set` | ST-MQ → bridge | One setting, physical identity and request deadline |

Example full snapshot, with an illustrative timestamp:

```json
{
  "identity": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "power": "on",
  "targetHumidity": 55,
  "fanSpeed": "low",
  "temperature": null,
  "humidity": 52,
  "timestamp": 1789992000000,
  "fieldTimestamps": {
    "power": 1789992000000,
    "targetHumidity": 1789992000000,
    "fanSpeed": 1789992000000,
    "humidity": 1789992000000,
    "temperature": null
  },
  "capabilities": {
    "power": ["off", "on"],
    "targetHumidity": [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80],
    "fanSpeed": ["low", "medium", "high"]
  }
}
```

Each `fieldTimestamps` value is the original UTC epoch millisecond at which Tuya
Local received that datapoint from the appliance. This is a native-report receipt
clock, not the sensor's internal sampling clock or an HA entity-update clock.
Partial native replies advance only the datapoints they contain. The aggregate
`timestamp` is their maximum and cannot renew an older field's evidence. This
model has no appliance temperature datapoint, so its value and clock are null.

The automation publishes on source changes, every 30 seconds, on startup and
reconnection, and in response to `/get`. Queries and periodic publications
preserve the original clocks. Snapshots use QoS 1 with retention disabled. The
bridge publishes `offline` when its source is unusable and during Home Assistant
shutdown; an `online` transport marker never extends measurement freshness.
Every required field still expires after the configured 180 seconds. Retained
data alone cannot establish availability, and connection loss clears the
adapter's old device observations.

Advance a field's clock only when a new native reply contains that datapoint.
Conflicting values at the same field clock are rejected. Each snapshot replaces
the previous settings; omitted/invalid values are unknown,
not merged with older settings. Reported power independently establishes the
recorded Off/On state; a missing fan setting does not make known power unknown.
Fan settings are displayed live and are never stored as telemetry history.

| Setting | Allowed values |
| --- | --- |
| `power` | `off`, `on` |
| `targetHumidity` | 30 through 80, in increments of 5 |
| `fanSpeed` | `low`, `medium`, `high` |

Only options listed in the current snapshot's `capabilities` can be sent.
These are the verified controls exposed by this local DESD8LW profile.

For example, a fan change sends
`{"fanSpeed":"medium","identity":"<the current 64-character identity>","requestedAt":1789992000000,"expiresAt":1789992010000}`
on `/set`. Commands are not retained and expire after ten seconds. The bridge
rejects unknown or multiple setting fields, invalid values, future or expired
requests, mismatched device identities and replayed request times. Its native actions target only the privately
selected entities. Power uses the humidifier's native on/off services, humidity
uses its humidity-setting service, and fan speed uses `select.select_option`.
A successful publish or native service response is not confirmation: the controller
waits for a matching independently received datapoint clocked at or after the
request. It does not record
requested settings as actual observations or retry old commands after reconnect.
Manual controls respect the existing master-control and read-only slave restrictions.
Brief observation-storage backlogs wait within the original command deadline.
Before dispatch, the controller checks current authority, appliance identity,
fresh feedback and the manual, automatic or test request again. Expired,
superseded or disconnected requests cannot be sent after storage recovers.
Only native reports received at or after actual dispatch can confirm a setting;
reports queued before dispatch cannot do so. Failed saves still block commands.
The request deadline fences bridge dispatch. Once a request reaches Tuya Local,
that integration's native delivery and retry behavior applies; the deadline is
not a device-local cancellation guarantee through a broken link.

The action receipt distinguishes sending, sent but awaiting a device report, and
a matching device report. If confirmation fails, it identifies the known cause:
uncertain command delivery, lost feedback or no matching report before the
deadline. An unconfirmed result does not establish whether the setting changed;
check the current reported setting before trying again.

## Automatic power and Caravan location check

The public equipment entry associates `temperature_control.sensor_device_id`
with `blu_ht`; configuration owns that wiring only. **Automatic power**, **Off
at** and **On at** are saved dashboard choices for this appliance and sensor
connection. They survive restart without changing configuration defaults. An
unrecognized/replaced connection starts with enabled, 1°C Off and 2°C On.
Thresholds accept −10 through 30°C in 0.1°C steps, with On at least 0.5°C above
Off. Authority is required to edit the policy; editing while the appliance is
unavailable grants no permission to command it. The first device identity must
be observed before saving choices; a previously bound identity permits edits
while offline.

With Automatic power enabled, fresh Caravan air temperature at or below **Off
at** requests native Off; at or above **On at** requests native On. Between the
thresholds the previous demand remains. Startup in the band uses Off demand.
Supported manual On/Off controls stay visible but disabled while Automatic power
is enabled, with an adjacent explanation. Turn off Automatic power and save to
use manual controls; an unsaved draft does not release automatic ownership.
Access, connection, power-check and restart restrictions still apply. Disabling
the policy does not disable the independent location test or recording gate.
The test owns native settings until it has restored the previous power setting;
ordinary supported native controls then become available again.

A necessary initial or renewed physical location check begins only after
30 seconds of stable, independently advancing appliance-power and Caravan-meter
reports. A successful association is retained for the same actual appliance,
meter and configured wiring across restart and normal paired handover; a process
start or brief communication loss alone does not repeat the power cycle.
The check establishes whether the Caravan meter responds to native power commands. It first establishes an
Off baseline, requesting native Off if necessary, then requests On followed by
Off. Independently advancing appliance reports must confirm the requested
settings, and independently advancing Caravan meter reports must show a power
rise with On and a fall with Off. Cached snapshots, retained publications,
command acknowledgements and elapsed time cannot provide this evidence.

The minimum detectable response is **3 W** in each direction. A modest fan load
can pass; full dehumidifying power is not required when humidity is already low.
Observed meter variation can raise that threshold. The fall must also be similar
to the rise and return close to the Off baseline. Each assessed power level needs
at least two independent meter reports spanning at least five seconds.
The test does not change the target humidity or fan speed to force a larger
load. It allows bounded time for native startup and shutdown before assessing
power. The Off baseline has an eight-minute bound covering the restart wait and
fresh baseline evidence; On has a three-minute bound and the final Off fall has
a five-minute bound covering native drying. The power check keeps collecting a
bounded fresh Off baseline while waiting, without consuming On intent or
renewing its phase deadline.
If the appliance draws no detectable extra power, the result is inconclusive
and recording stays paused. Humidity and agreement between air sensors are
not prerequisites.

Enabled Automatic power retains its cold-temperature protection during the
test. Fresh Caravan temperature at or below the Off threshold defers testing
or aborts an active test to native Off. Warmer temperature evidence allows a
new test. The dashboard explains this wait; humidity remains independent.

The test temporarily changes native power and durably saves the previous
setting before sending a command. It restores that setting and confirms fresh
device readback before normal temperature control resumes. The restoration
obligation survives restart and connection loss; a broken link cannot prove
restoration. Shutdown and reload attempt restoration within a bounded wait
before closing the command transport; unresolved obligations remain durable.
Restoration to On waits for the same native restart boundary without saving a
new attempted command or extending the original restoration dispatch clock.
A current-format restart retains the obligation and timing; a new connection's
uncertain interval may conservatively extend the remaining wait. Manual On
during the hold is refused with the remaining wait, and the card keeps On
unavailable until fresh timing and all ordinary command checks permit it.
If a connection change introduces that restriction just before a click, the
rejection explicitly says that On was not sent and identifies the required wait
or fresh native power evidence. Unknown delivery failures remain unconfirmed.
A fresh independent native power change aborts the test and supersedes its
captured setting, so restoration cannot overwrite that newer manual or native
choice. Commands always use the native appliance controls, never the
Caravan plug relay. The appliance's own protection and cooling cycle remain
in control of its physical operation.

The UI shows **Recording active/paused**, waiting for fresh reports, checking
power, restoring power, or a failed check. A pass is evidence that the Caravan
meter followed both switches; unrelated load changes can still confound that
inference. A measured failed or inconclusive check stays latched across restart
and brief flaps. Restore the previous native power first; a new physical check requires
an explicit **Recheck appliance location**, changed equipment/wiring, or a
sustained new outage followed by stable feeds. The configured, enabled `caravan`
meter in the same area supplies `caravan_power` in W or kW; no replacement-meter
preference is stored. Historical association does not establish current readings,
recordability, native power, command permission or completed restoration.

A controller shutdown during an unfinished check is an interruption rather than
a measured power-test failure. Restore its captured native power first, then
require 30 seconds of independently advancing fresh appliance and meter reports
before one new bounded check. Restart timing, cold protection, identity and
authority checks remain binding. A measured failure of that replacement check
stays latched; it cannot start another automatic retry.

While warm fresh evidence is present but recovery/retesting is pending or a check has
failed, keep the current native baseline; this sends no On command. Cold or
missing-air protection still uses current native evidence to request Off.
That same rule is checked after observation commit and immediately before
publication: newly admitted warm recovery evidence cancels a queued protective
Off without requesting On. A known-unsent cancellation does not delay a later
genuine cold or missing-air Off. An earlier dispatched command whose outcome is
still uncertain keeps its original receipt; cancelling unsent bytes cannot
establish what the appliance did.

The owner approved these exact boundaries on 2026-10-14:

- A real source loss withdraws current qualification and recording immediately.
  At **60,000 ms of continuous unavailable evidence**, the historical association
  is invalidated. Returning at 59,999 ms retains it; returning at 60,000 ms cannot
  resurrect it. Delayed detection uses the original required-field expiry, not
  the later controller tick. Queued return reports are assessed at actual writer
  admission and cannot backfill a gap or reverse an expired association.
- A genuine healthy return from both feeds ends that continuous loss. Stable
  recovery needs **30,000 ms** of elapsed healthy time and at least that much
  independent advancement of each original required source clock. At 29,999 ms
  the association remains unusable. Cache reads, retained messages, transport
  markers, future/quarantined or nonadvancing reports do not complete recovery.
  A subsequent flap resets recovery and starts its own continuous loss; distinct
  short losses are not accumulated into one outage.
- On restart or handover, unseen time conservatively starts at the last committed
  healthy checkpoint (or earlier recorded loss). This includes the checkpoint's
  age; it is not proof of the actual physical outage duration. New reports from
  this runtime must advance before recovery. Clock rollback and future saved
  evidence cannot shorten either interval.
- The strict current saved association keeps the original successful rise/fall
  proof, actual identity and full appliance/meter/sensor wiring signatures,
  failure latch and original loss/healthy/source boundaries. A checkpoint can
  advance at most once per 30 seconds, only after both admitted source clocks
  advance. Status reads and periodic cache publications do not write it. Pass,
  failure, loss, explicit physical-check and changed-wiring transitions are saved
  in their existing ordered transaction, with rollback restoring RAM and state.
- Changed equipment, broker/topic/channel, mapping/unit or selected temperature
  wiring invalidates the abandoned association durably, even on a quick A→B→A
  return. Its historical proof remains labelled history. Verified paired MQTT
  source context preserves the actual source through transport endpoint changes;
  an unverified broker edit does not. Original On restoration remains separate
  and is reconciled before any new association can be used.

**Recheck appliance location** is a physical action inside **Power check**, with
its switching/restoration effect shown beside it. The current API accepts only
`{deviceId, identity, signature, revision}` at
`POST /api/equipment/dehumidifier/location-check`. The full current signature and
revision are rechecked after writer admission; outstanding commands, tests or
restoration and duplicate/stale requests cannot start another check. Ordinary
**Recheck** and status reads remain read-only source refreshes.

A failed explicit rise/fall check is the supported contradictory coupling
witness. There is no general passive coupling monitor: zero power, low humidity,
missing fan telemetry, cached On or ordinary unrelated load variation do not
invalidate a pass by themselves. Retaining a pass through a short loss accepts
that relocation completed inside the grace may escape immediate retesting; no
probability guarantee is claimed. Initial absence of this new current state
requires a real pass; earlier ephemeral probe results are not adopted. Invalid,
retired or unknown saved fields fail closed before writable startup, without
translation, repair or deletion. Same-schema backup, replay and replication
preserve the original records. The DESD8LW is a desiccant appliance: its native
drying/cooling procedure and five-minute restart fence remain unchanged.

Qualification is never filled backwards into the test or an earlier reporting
gap. Device control authority is required for the
test and restoration; read-only replicas cannot send these commands.

Native power timing uses one strict current optional state contract. A genuinely
absent new timing record is established by actual admitted reports; malformed
records, retired timing versions or mismatched saved key/identity/route fields
are rejected before writable database setup. There is no conversion, inferred
transition or automatic repair. Same-schema backup and paired state replication
retain the original timing and restoration records; copied state grants no
device authority.

A bounded wait for a slightly early required appliance or meter timestamp pauses
test advancement and recording without creating a new connection or restarting a failed check.
The original phase deadline continues to run. With previously fresh, qualified
evidence, automatic power holds its existing demand during this brief wait;
cold or missing air evidence still protects Off. Actual stale evidence,
connection loss and rejected required timestamps withdraw current qualification
and start the separately bounded association loss; an active test is aborted.
Writer congestion does not by itself reject a required report whose original
timestamp has already arrived when admission runs. The five-second monotonic
bound still expires a timestamp that remains ahead; required evidence must
remain fresh at actual admission, and all original clocks remain unchanged.
When an already recorded, qualified state survives only this bounded wait,
recording resumes as soon as the required report is admitted. The recorder saves
a separate availability event at that time, retaining the original appliance
measurement and receipt clocks. Coverage starts at recovery, so the brief wait
remains a gap. This does not renew an expired reading, carry qualification across
a real outage, or waive the first state report required after the power test.
New healthy meter reports also update the remaining recording deadline
prospectively; the original appliance power/fan clocks still cap its lifetime.

A partial native Shelly notification containing only the energy counter waits
for its timestamp independently. It does not pause recording or the power check
while previously admitted switch, power and current readings remain fresh.
Those readings keep their original clocks and expiry. A required custom reading
on the same switch component, a mixed/full report or a fault keeps the required
evidence gate; a later required notification cannot bypass the ordered queue.
Rejecting or expiring an ancillary counter supplies no new measurement and does
not invalidate independent fresh readings. Actual meter expiry or connection
loss withdraws current qualification and starts the continuous-loss boundary.

## Recording

The single `caravan_dehumidifier_state` series uses stable numeric codes
with categorical labels in both Caravan charts, tooltips and the series explorer:

| Code | Label |
| --- | --- |
| 0 | Off |
| 1 | Low |
| 2 | Medium |
| 3 | High |
| null / gap | Unknown, unavailable or stale |

Off requires fresh reported power Off and does not depend on the fan setting.
Low, Medium and High require fresh reported power On plus the corresponding
fresh native fan report. Missing, stale or unsupported fan values while On leave
a gap; there is no Auto category. These states describe the appliance's power
and selected fan level, not measured airflow or proof of water removal. A humidity
target, full tank or shutdown cycle can affect physical operation.

The recorder retains only this combined state, appliance identity, required
power/fan receipt clocks and power-test qualification provenance. Separate fan
settings, mode, humidity target, louvre setting and the appliance's own
temperature/humidity remain live-only; commands do not generate history points.
There is no alias or conversion from either retired dehumidifier history series.
With the Caravan sensor association configured, every recorded state requires
a passed power test and fresh required appliance and Caravan meter evidence,
including when Automatic power is disabled. Unavailable evidence, testing and
unresolved restoration produce a gap instead of a claimed state. A missing
humidity report does not prevent recording.

A newly attached capture reports the qualification gap after its first fresh,
admitted usable appliance state, even before that capture has passed a power
test. Recording details distinguish that gap from a missing transport report.
Earlier recorded state and its original source time remain historical evidence;
the unavailable transition neither renews that measurement nor supplies a device
value. Repeated unqualified reports do not create repeated gap transitions.

Independently of the dehumidifier gate, the same Caravan fold records
`caravan_temperature` and `caravan_humidity` from the Shelly BLU H&T. Battery and
Bluetooth signal strength are live-only.
The Caravan plug records `caravan_energy` as measured interval kWh through the
shared adaptive recorder. It automatically balances recording frequency against
load changes, just like property and charging energy; instantaneous power, current
and plug state remain live-only. Daily totals still update on each meter report. None of these
Caravan series enters the Home heating learner.

The public `config.json` supplies all topics. If private configuration replaces
`equipment.devices`, copy the public caravan entries into that list as well;
private arrays replace defaults rather than merging by device ID.
