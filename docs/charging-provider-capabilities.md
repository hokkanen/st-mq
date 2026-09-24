# Charging provider capabilities

| Capability | Charger 1: Easee | Charger 2: Shelly EVSE | TeslaMate / BMW |
| --- | --- | --- | --- |
| Physical home energy | Easee phase intervals | Shelly native meter deltas | Never |
| Live phase currents and voltages | L1–L3; local OCPP phase-neutral voltage, cloud terminal voltages require verified mapping | L1–L3 from native `phase_info`, in configured phase order | Never used as charger meter readings |
| Live active power | Reported total; phase energy is estimated | Native phase power and total power | Never used as charger meter readings |
| Connection lifecycle | Timestamped Easee state | Commissioned physical work-state mapping | Corroborating vehicle edges |
| Economic control | Exclusive cloud delayed starts or native OCPP expiring 0 A transaction pauses | EVSE start/stop over MQTT RPC | No vehicle writes |
| Current changes by ST-MQ | Native OCPP may impose an expiring 0 A pause; no positive-current setpoint | Verified common current | Read native limits only |
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
total (kWh) and the separate `energy_charge` session reading (kWh). `phaseMap`
assigns the native phases to installation L1–L3. Original measurement and receipt
times remain visible; missing, retained, stale or disconnected readings are
unavailable even when charger control is commissioned. Conversely, valid read-only
measurements do not require permission to control charging.

The manual documents accumulated energy only as a total. No native phase-energy
counters are advertised or created, and current phase values do not become extra
recorded history. Easee keeps its existing measured L1–L3 current/voltage readings,
reported total active power and explicitly estimated phase-energy intervals.

## Commissioning contract

Charger 2 defaults `enabled:false, verified:false`. Configure a concrete `deviceId` and `topicPrefix` to acquire it. To admit commands, explicitly commission the observed model and firmware, service 0, distinct connected/disconnected/charging work-state strings, current range/step and physical phase mapping. The initial supported allocation profile requires a 6 A minimum and a 1 A step; other minima/steps are rejected until the allocator and hardware contract explicitly support them. The adapter discovers each role's component ID, checks unique mapping and service ownership, and requires write access for the current/start roles. Observed model/firmware and current capabilities must exactly match the configured profile. Any mismatch or unreadable capability withdraws control.

Every refresh reads native service config, status and [schedules](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Schedule/). Active errors/flags or a nonrunning service block commands. External `auto_balance` must be disabled for this distinct ST-MQ/Equalizer allocation arrangement; ST-MQ never changes it. Global charge/time caps and automatic-start settings are inspected and preserved. Enabled native schedules own start/stop conservatively; schedule semantics are not reconstructed from guessed windows.

The source contract requires positive native `last_update_ts` values in seconds. Zero/unknown timestamps are unavailable. Physical current uses its source age; a correlated read can renew receipt evidence for an unchanged setting without inventing a new measurement. Unknown work-state strings never mean disconnected or charging. `phase_info` is validated as W, V, A and accumulated kWh. Model-, firmware- and installation-specific state/counter behavior still needs physical verification.

## MQTT and commands

The [MQTT channel](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/) and [RPC envelope](https://shelly-api-docs.shelly.cloud/gen2/General/RPCProtocol/) are used on the configured broker. Subscription admission precedes bounded ordered replay. Requests use random correlated IDs and a per-instance reply route. Replies must come from the configured device; retained replies cannot confirm a command. Timestamped first-seen DUP notifications can establish a real source event, whereas replay cannot create another plug epoch. Oversized payloads, unknown roles and buffer overflow cannot grant control.

Only `Number.Set` for `current_limit` and `Boolean.Set` for `start_charging` are mutation methods. Neither relay writes, service configuration writes, vehicle writes nor native-schedule edits are permitted. Commands use QoS 0, `retain:false`, no offline queue and no automatic application retry. Durable intent records association, session, revision and absolute expiry; authority and scope are rechecked after awaits immediately before publication.

Status distinguishes proposed, dispatched, accepted, read-back and physical-effect stages. A successful RPC response alone proves no current reduction. A possible dispatch followed by timeout/restart remains uncertain until a compatible fresh native reading reconciles it. Manual changes survive priority changes and current-format restart within their connection scope.

## Hardware verification still required

All current tests use invented device identities and synthetic traffic. Before setting `verified:true` on the arrived hardware, confirm:

- Actual model, firmware, role IDs/permissions, min/max/step, native work-state meanings and source-clock behavior.
- Plug detection versus full/paused/faulted states; current changes during charging; Boolean pause/resume and native schedule interaction.
- Phase order, additive model, fuse values/margins and Equalizer response with asymmetric household loads.
- Meter units, resets and cadence across stop/resume/reboot; source-time completeness at session boundaries.
- Manual app changes, reconnect, lost replies and process/broker/device outages, including retained last setpoint and any actual autonomous fallback mechanism.

No autonomous 12 A controller-loss mechanism has been verified. The implemented 12 A telemetry-loss policy requires ST-MQ and a reachable controllable charger. It is explicitly not a hardware protection guarantee. The current implementation remains useful for disabled commissioning and synthetic validation without claiming that those hardware checks have happened.
