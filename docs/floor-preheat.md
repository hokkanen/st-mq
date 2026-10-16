# Home floor preheating

The floor controller uses one **SONOFF 4CH PRO R3** running the fixed board
profile from the separate [firmware repository](https://github.com/hokkanen/sonoff-4chpro-mqtt).
That repository owns firmware, installation, the versioned MQTT protocol and
hardware qualification. This application owns circuit assignment, manual controls,
pooled preheating, recording and durable restoration.

**Home → Sensors & Equipment → Ground-floor circuits** shows current control
readiness, each circuit's reported GPIO output and individual timed controls.
The device header shows connection availability independently of commissioning,
active overrides or pending release. **Overrides & release** explains operation;
**Device details** contains commissioning, automatic enablement, firmware and
report evidence. Release obligations remain visible when the card is closed.

**Data & settings → Connections & configuration → Home floor preheating**, above
Garage freeze protection, contains the hardware details, installation steps,
circuit assignment and setup guide. MQTT diagnostics describe connection health
and routing. Output states and control readiness stay in Home; setup and MQTT
diagnostics do not provide another control path.

| Connection | Floor circuit | Pipe length |
| --- | --- | --- |
| 1 | Living | 106 m |
| 2 | Living | 62 m |
| 3 | Storage | 38 m |
| 4 | Storage | 80 m |

Lengths label the pipe in each circuit; they do not measure flow, floor area or
thermal capacity. Other loops retain their existing fixed valve settings.
Automatic floor preheat is one pooled treatment requiring fresh ON readback for
all four selected outputs.

## Evidence and ownership

The firmware reports **GPIO output readback**, not relay-contact continuity,
valve position, water flow or delivered heat. The owner explicitly approved using
this feedback to confirm the commanded override after physical commissioning on
2026-10-15. ON and OFF labels always describe reported output logic; missing,
retained, stale or invalid feedback remains unknown. A broker acknowledgement or
an accepted request alone is insufficient. GPIO agreement is not proof that a
relay contact moved or that ordinary thermostat operation was physically restored.

The wiring must make **OFF release the override while leaving ordinary thermostat
heating electrically possible**, including loss of device power. Verify that
independently during commissioning. The controller cannot detect a mechanically
stuck contact from GPIO readback.

Only the active master may send control requests. Observing outputs, configuring
thermal priors, retained Online, copying a database or elapsed time grants no
permission. Configuration owns device identity and commissioning; dashboard
commands never rewrite them.

## Individual timed controls

An administrator can select **Override on** or **Release** for each circuit in
Home. Each new manual treatment lasts at most 15 minutes. Selecting another
circuit changes the mask within that same treatment and retains its original
end; retries and repeated clicks never extend it. Releasing one circuit preserves
other selected circuits. Releasing the final circuit ends the entire lease.
The device protocol has one board lease, so independent deadlines are not offered.

Individual overrides do not raise the heat-pump ROOM setting or enable Home
Automatic. They are unavailable during a pooled preheat lease and prevent a new
pooled treatment until released. Ordinary Normal/Pause maintenance preserves the
manual deadline; an explicit Home Normal/Reduced selection, shutdown or handover
releases the applicable override. A native ROOM edit supersedes the coupled
manual Preheat treatment; it does not edit an independent circuit override. Partial
selection, including all four selected manually, is excluded from pooled thermal
learning and evidence. Local expiry still applies if the host disappears.

## Thermal model and control settings

Preheating requests the captured normal ROOM setting plus
`controller.preheat_room_boost_c` (default **5 °C**), capped at the device's supported
maximum. Renewals maintain that request without adding another increment. This is
a heat-pump demand setting; automatic planning constrains the occupied indoor-average forecast using the learned
reference and `max_drop_c` / `max_rise_c` (both default **1.5 °C**).

A positive `controller.floor_thermal_priors.capacity_kwh_per_c` enables one separate
selected-slab state. Configure it in the installation's private configuration,
then choose **Apply reviewed configuration**. The following keys express fixed assumptions:

| Key | Meaning |
| --- | --- |
| `capacity_kwh_per_c` | Selected concrete heat capacity, kWh/K; geometry and material assumptions establish a prior, not usable tariff storage. |
| `native_capacity_kwh_per_c` | Remaining building reserve, kWh/K; when omitted, the selected capacity is subtracted from the seeded total reserve. |
| `exchange_kw_per_c` | Effective slab-to-room conductance, kW/K; a provisional release assumption until measured. |
| `ground_loss_kw_per_c` | Effective slab-to-ground conductance, kW/K; positive insulated floors still lose heat. |
| `ground_c` | Assumed slow ground temperature, °C, independent of outdoor air and heat-pump brine. |
| `open_allocation_fraction` | Fraction of space-heating input allocated to the selected slab with confirmed override. |
| `closed_allocation_fraction` | Fraction allocated with native thermostat authority; OFF does not imply no heat. |

Document the basis for each installation value privately. Floor area and thickness
can support a material-capacity estimate; they do not measure hydraulic allocation,
release time, ground temperature or charging efficiency. The permanently open loops
remain in the native building reserve. The model conserves supplied heat across both
paths. With an explicit slab, the fitted envelope coefficient describes above-ground loss; slab-to-ground exchange is a separate passive path. The current model starts with fresh priors rather than converting old total-loss fits.
DHW-routed compressor heat is excluded from space heating as a deliberate simplifying
assumption.

Thermal configuration and relay permission are independent. Keep
`controller.floor_preheat.enabled` and `controller.floor_preheat.commissioned`
false until the installed firmware and physical checks below pass.
Commissioning permits supervised individual controls; enabling adds pooled
preheating to the Home heat-control path. Configuring the slab does not activate any output or establish usable
storage from room temperature alone.

Normal DHWR scheduling continues during preheat. During tariff reduction it is
suppressed and DHW demand settings are reduced. Space heating resumes immediately
when reduction ends, followed by a bounded recovery hold
(`controller.recovery_hold_minutes`, default **60 minutes**) with those hot-water
restrictions retained. AUX shares that deadline when
`controller.recovery_compressor_only` is enabled, with independent early release
for indoor-average comfort. At expiry, native DHW settings and circulation eligibility return;
a circulation pulse is not forced. To restore normal hot-water settings earlier,
pause price control; this selects Normal heating and restores the captured native
settings. A timed circulation run can then be started if needed. The deadline is not extended by ongoing estimated
thermal recovery.

## Protocol and restoration

Use [MQTT lease protocol v1](https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/protocol.md):

| Purpose | Fixed topic |
| --- | --- |
| Requests | `cmnd/sonoff4chpro/LEASE` |
| Replies and state | `stat/sonoff4chpro/LEASE` |
| Availability context | `tele/sonoff4chpro/LWT` |

Commands are non-retained. Exact device identity, a fresh MQTT generation,
short-lived challenge, treatment counter, sequence and lease capability fence
activation and renewal. Current feedback must match the device and connection;
request confirmation additionally matches the outstanding request. Capabilities
are private control data and must not appear in API responses or logs.

The host uses custom `get` for polling. Native Tasmota status/maintenance commands
terminate a lease and must never be used as ordinary monitoring. Retained Online
is only context. Periodic correlated readback establishes current GPIO evidence;
stale observations cannot be renewed by reading an application cache.

Automatic renewal defaults to 300 seconds; each device-local lease grants at most
900 seconds, capped at the immutable planned end. Renewal preserves unchanged
outputs. Host monotonic remaining time is mapped conservatively from the received
challenge to the device's monotonic clock; transport delay cannot add time. The
firmware rejects replay, an expired challenge, wrong ownership and deadline
extension, and releases on expiry, known disconnection, reboot or maintenance.
These are software safeguards, not proof against every hardware failure.

Before activation, durably record a release obligation bound to the exact device,
broker, connection and treatment. Cancellation, partial activation, lost feedback,
restart and expired permission require release. Restart never recreates a manual
ON request. Missing OFF confirmation keeps restoration pending and blocks a new
treatment. Replacing the device or broker never transfers authority or erases the
old obligation. Malformed and retired saved formats cannot supply permission.
Standby and authority loss cancel pending activation; graceful shutdown/handover
releases owned outputs while the original master still has authority.

Manual Home **Preheat** remains a single fixed lease for both the floor treatment
and ROOM increase. It does not accumulate ROOM boosts or gain time through
renewal. ROOM restoration begins at the original end even when floor release is
unconfirmed. A local relay timer cannot restore ROOM through a broken host or
heat-pump connection.

The four exact-change history series are `floor_groundfloor_1_active` through
`floor_groundfloor_4_active`. They record GPIO logic and its quality with original
observation clocks, never commands, inferred expiry or physical valve position.
No historical gap is filled from present feedback.

## Configuration

`controller.floor_preheat` owns:

| Field | Default | Meaning |
| --- | --- | --- |
| `device_mac` | empty | Exact physical identity, uppercase colon form; store privately. |
| `commissioned` | `false` | Physical installation and installed firmware have been checked. |
| `enabled` | `false` | Permit pooled floor preheating when the Home controller requests it. |
| `renew_seconds` | `300` | Automatic lease renewal interval. |
| `lease_seconds` | `900` | Maximum local lease and manual Home Preheat duration. |

A configured identity allows observation; commissioning permits manual controls.
Pooled enablement additionally requires commissioning. Both permission flags
remain false in public defaults. Use the existing private configuration and
**Apply reviewed configuration**; do not copy public defaults or place actual
hardware identifiers in Git. Retired device mappings and unknown fields are
rejected, without aliases or automatic migration.

## Setup and commissioning

1. Follow the firmware repository's [compatibility guide](https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/compatibility.md)
   and [operations guide](https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/operations.md).
   Verify the fixed firmware profile and artifact identity. Configure its MQTT
   connection and the application's private physical identity. Review reported
   identity, firmware readiness and all four outputs while control is disabled.
2. Verify each numbered circuit and the safe unpowered/OFF thermostat path.
   Independently check actual contact continuity, actuator power and travel delays;
   GPIO readback cannot perform this check. Other fixed loops retain their settings.
3. With unloaded hardware, exercise acquire, each individual mask, unchanged
   renewal, partial release and whole-board release. Check local expiry at a short
   planned end and at the maximum lease. Record observed outputs and physical
   contacts separately. An unwired board can qualify protocol/relay behavior but
   cannot qualify installed valves, thermostat failback, flow or delivered heat.
4. Test host loss, broker loss, device restart, failed renewal, delayed/duplicate
   activation and lost feedback. Verify physical release without a host command.
   Firmware test results are listed in its [qualification status](https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/status.md);
   they do not replace installation-specific checks.
5. Record the reviewed result privately before setting `commissioned:true`.
   Supervise individual controls first. Enable pooled preheat only after wiring,
   safe limits and heat-pump behavior are checked. Thermal priors and treatment
   evidence separately govern automatic economic selection.

The initial automatic treatment remains pooled. Individual manual controls do
not implement independent room scheduling or automatic thermal tuning. Observe
supply and floor limits, room temperatures, hydraulic redistribution and complete
recovery before drawing conclusions about heating performance or savings.
