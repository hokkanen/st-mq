# Charging provider capabilities

| Capability | Charger 1: Easee | Charger 2: Shelly EVSE | TeslaMate / BMW |
| --- | --- | --- | --- |
| Physical home energy | Easee phase intervals | Shelly native meter deltas | Never |
| Live phase currents and voltages | L1–L3; local OCPP phase-neutral voltage, cloud terminal voltages require verified mapping | L1–L3 from native `phase_info`, in configured phase order | Never used as charger meter readings |
| Live active power | Reported total; phase energy is estimated | Native phase power and total power | Never used as charger meter readings |
| Recorded energy check | Stored phase-energy sum versus final native session meter | Not applicable: records native meter increments without power integration | Never a physical meter reference |
| Connection lifecycle | Timestamped Easee state | Supported physical work-state mapping | Corroborating vehicle edges |
| Economic control | Exclusive cloud delayed starts or native OCPP expiring 0 A transaction pauses | EVSE start/stop over MQTT RPC | No vehicle writes |
| Active vehicle identification | One bounded attempt per physical connection; native expiring pause | Same attempt lifecycle; application-managed start-permission pause | Independent live vehicle evidence |
| Identification pause recovery | Ordinary correlation pause expires after 90–91 seconds; an extra probe's final economic pause lasts until scheduled release | Persisted restoration obligation; an application/MQTT outage can extend the stop until safe recovery | No charger control |
| Current changes by ST-MQ | Native OCPP imposes expiring 0 A pauses; released charging uses native current limits | Native current by default; optional verified current limiter | Read native limits only |
| SoC/capacity/target | Assigned vehicle or explicit fallback | Assigned vehicle or explicit fallback | Applicable vehicle evidence |
| Supply voltage | Physical installation evidence | Physical installation evidence | Never used for home supply |

Charger 1's native OCPP mode takes over authorization and scheduling from the
cloud. `authorization_mode: "plug-and-charge"` uses a private derived virtual tag
for RFID-free startup; the default `rfid` mode requires configured tags.
Native pause expiry releases the restriction and leaves positive charging
current to the charger, vehicle and Equalizer. Cloud readings can back up local
telemetry; control does not switch back merely because telemetry does. The
[Easee setup record](audit/OCPP-SETUP.md) separates bounded live observations from
synthetic protocol validation and untested installation conditions.
Normal service stop requests cloud handback; paired handover keeps OCPP active.
After a crash or power loss, new charging or Easee app Start can remain blocked
waiting for approval. Restart ST-MQ or disable Direct OCPP through Easee
configuration; an expired pause does not restore cloud authorization.

The Charger 2 profile targets the [Top AC Portable EV Charger](https://shelly-api-docs.shelly.cloud/gen2/Devices/ShellyX/XT1/TopACPortableEVCharger/) on Shelly XT1. The integration uses the documented EVSE roles for state, current, start permission and electrical data. This is not a generic Shelly relay adapter. [XT1](https://shelly-api-docs.shelly.cloud/gen2/Devices/ShellyX/XT1/) documents role addressing, service state and access permissions; [Number](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Number/) documents numeric limits and `meta.ui.step`.

The device documentation's `phase_info` response supplies `phase_a`, `phase_b` and
`phase_c`, each with `voltage`, `current` and `power`, plus `total_power` and
`total_act_energy`. The public provider status exposes phase currents (A), voltages
(V), active powers (converted from W to kW), total active power, the accumulated
total (kWh). `phaseMap`
assigns the native phases to installation L1–L3. Original measurement and receipt
times remain visible; missing, retained, stale or disconnected readings are
unavailable even when charger control is available. Conversely, valid read-only
measurements do not require permission to control charging.

The provider list uses four groups: phase currents, phase voltages, active power
and recorded phase energy. The power group includes total and phase readings;
the energy group names the native lifetime-counter input. Electrical acquisition
health remains independent of control readiness. Native `energy_charge` and
`time_charge` roles are unused and are not polled.

The manual documents accumulated energy only as a total. No native phase-energy
counters are advertised or created. Recording allocates each accepted native
meter increment using endpoint phase powers into three estimated phase-energy
intervals; their sum preserves the measured increment. There is no fourth
total-energy series, and raw current phase values stay live-only. Unknown phase
shares leave a gap and retain the measured increment as diagnostic evidence.
Easee keeps its existing measured L1–L3 current/voltage readings, reported total
active power and explicitly estimated phase-energy intervals.

## Connection and automatic readiness

Charger 2 defaults to `enabled:false`. Configure `enabled:true`, a concrete
`deviceId` and `topicPrefix` under `charging.chargers.charger2`. The integration
checks the device identity, service 0, unique typed role ownership, access and
reported enum options. Supported connection-state meanings belong to the Top AC
profile, not user configuration. The profile uses `charger_free` for unplugged,
`charger_charging` for charging, and `charger_wait`, `charger_pause`,
`charger_complete` and `charger_end` for connected but not charging. These are
also the states recognized by the [upstream Top AC integration](https://github.com/evcc-io/evcc/blob/master/charger/shelly-topac.go).
Unknown or fault states cannot authorize commands or establish an unplug.

Basic start/stop requires fresh native state, start permission and current setting, working MQTT,
a running service and no active errors or flags. It preserves native current
settings, energy/time caps, automatic-start settings and `auto_balance`.
Automatic charging remains a separate dashboard choice. Changing a setting in
the native app takes priority; turning Automatic charging on does not enable a native Stop or
raise a native current limit. Enabled native schedules own start/stop until
removed; removal gives the app release priority for the current connection.
Shelly schedule windows are not inferred from unverified cron semantics.

Optional `limiterEnabled:true` enables current writes. It additionally requires
reported writable numeric capabilities supporting the integration's 6 A minimum
and 1 A step, sufficient native maximum, and disabled native `auto_balance`.
Missing step metadata blocks this optional capability, not basic start/stop.
Configure the installation's phase order, fuse ratings, margins and
`additiveCurrentVerified` for the load model; these cannot be discovered from
charger RPC. With the limiter disabled, planning reserves the native charging
current and the controller sends no current-setting RPC or 12 A fallback.
With an enabled but unavailable limiter, control waits for its requirements.

Manual `verified`, model/firmware pins, state lists, `minimumCurrentA` and
`currentStepA` are retired configuration fields and are rejected. Readiness is
computed from actual supported capabilities. An older development database must
be replaced explicitly with a fresh schema 18 database; it is never migrated or
reset automatically. This prevents previous commissioning/ownership records from
authorizing the new control contract.

Every refresh reads service configuration/status, numeric current capabilities
and [schedules](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Schedule/).
The source contract requires positive native `last_update_ts` values in seconds.
Zero/unknown timestamps are unavailable. A correlated read renews setting receipt
evidence without changing its original source clock. Physical current retains
its measurement age. MQTT electrical acquisition and lifetime-meter recording
remain useful independently of control availability.

## MQTT and commands

The [MQTT channel](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/) and [RPC envelope](https://shelly-api-docs.shelly.cloud/gen2/General/RPCProtocol/) are used on the configured broker. Subscription admission precedes bounded ordered replay. Requests use random correlated IDs and a per-instance reply route. Replies must come from the configured device; retained replies cannot confirm a command. Timestamped first-seen DUP notifications can establish a real source event, whereas replay cannot create another plug epoch. Oversized payloads, unknown roles and buffer overflow cannot grant control.

Only `Number.Set` for `current_limit` and `Boolean.Set` for `start_charging` are mutation methods. Neither relay writes, service configuration writes, vehicle writes nor native-schedule edits are permitted. Commands use QoS 0, `retain:false`, no offline queue and no automatic application retry. Durable intent records association, session, revision and absolute expiry; authority and scope are rechecked after awaits immediately before publication.

Status distinguishes proposed, dispatched, accepted, read-back and physical-effect stages. A successful RPC response alone proves no current reduction. A possible dispatch followed by timeout/restart remains uncertain until a compatible fresh native reading reconciles it. Manual changes survive priority changes and current-format restart within their connection scope.

Vehicle identification uses the same one-attempt lifecycle as Easee, including
when Automatic charging is OFF or Charge now is selected. Waiting for the
vehicle to allow charging consumes no delivered-energy budget. Ordinary
authorized charging has no short identification timeout. Extra charging during
an economic delay uses normal charging current and a 0.15 kWh allowance,
with a separate safety duration and metering-loss cutoff. These application guards
depend on working communication and can be delayed by an outage. Suitable BMW evidence
permits an earlier pause. The stop and its restoration obligation are saved before
dispatch and remain scoped to the equipment, physical connection and attempt.
Identification requires fresh physical noncharging evidence and the independent
vehicle response, in addition to native start-permission readback. A physical
stop returns control to the current charging choice without waiting for BMW;
matching timestamped reports remain usable until unplugging.

The Shelly identification pause has a 90–91 second application deadline and no
charger-side expiry. If the application or broker connection is unavailable,
the stop can last longer. Recovery reconciles the saved command against fresh
readings before returning to normal control for that same connection. An
unconfirmed stop that cannot be attributed to the saved command requires
explicit resume. Manual
Stop, active native schedules and electrical limits retain priority; a saved
test cannot authorize starting a replacement connection. **Identify** permits
an explicit retry or recheck when control is available and no test is ongoing.
It never renews an uncertain command or repeats an expired attempt automatically.

## Hardware verification still required

Automated tests use invented device identities and synthetic traffic. They cover
capability discovery, app priority and command fencing, not installation wiring
or autonomous outage behavior. Verify phase order, fuse values/margins and
additive-current behavior before enabling the installation load model.

The bounded 2 October 2026 live setup confirmed the expected roles, working MQTT,
source-clocked three-phase measurements and physical Boolean stop/resume. Firmware
1.7.1 omitted `meta.ui.step`: basic start/stop no longer depends on that metadata,
but optional current limiting remains unavailable. A stop reported `charger_end`
while plugged in; the profile preserves that connection. Native session-energy
comparisons are not implemented; recording uses lifetime-meter increments.
No new live hardware verification was performed for the automatic readiness and
app-priority changes. Private identities and raw captures remain outside Git.

No autonomous 12 A controller-loss mechanism has been verified. The implemented 12 A telemetry-loss policy requires ST-MQ and a reachable controllable charger. It is explicitly not a hardware protection guarantee. Automatic readiness does not establish autonomous outage behavior or qualify installation wiring.
