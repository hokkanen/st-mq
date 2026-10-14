# Home floor preheating

The planned ground-floor circuit controller is **one SONOFF 4CH PRO R3** with
four connections. The dashboard presents this device in **Data & settings →
Connections & configuration → Home floor preheating**, directly above
**Garage freeze protection**.

| Connection | Floor circuit | Pipe length |
| --- | --- | --- |
| 1 | Living | 106 m |
| 2 | Living | 62 m |
| 3 | Storage | 38 m |
| 4 | Storage | 80 m |

Lengths identify the pipe laid inside each floor circuit. They are installation
labels, not measured flow, heated floor area or validated thermal capacity.
The four circuits are intended to form one pooled preheating treatment; all four
must have fresh ON confirmation before an override can be considered active.
Other ground-floor loops retain their existing fixed valve settings.

The dashboard reports **Integration unavailable**. The hardware selection and circuit mapping do
not establish a supported firmware, control interface or local expiry mechanism.
Floor control remains unavailable until those capabilities are implemented and
verified. Configuration currently rejects enabling floor control or marking it
commissioned. There is no device script to download or install from this
application for this setup.

The contacts must override the original thermostats only while preheating is
active. **OFF must release the override and leave ordinary thermostat-controlled
heating electrically possible.** Reported relay states establish electrical
contact feedback, not valve travel, water flow or delivered heat. The dashboard
therefore describes a confirmed OFF contact as **Override off**; unavailable
feedback remains unknown.

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
false until a supported integration is available and the physical checks below
pass. Configuring the slab does not activate any output or establish usable
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

## Required control and restoration behavior

The integration must provide a bounded device-local lease for all four contacts.
The planned automatic renewal interval is **5 minutes**, with each lease expiring
after at most **15 minutes** or at the planned preheat end, whichever comes first.
Renewal must maintain the existing ON state without cycling contacts. Loss of the
host, connection or control process must not leave an indefinite override.
A supported implementation must demonstrate this behavior on the installed
firmware; these timing settings alone do not provide it.

Manual **Preheat** uses one fixed lease, including while Home is paused. Repeated
requests must not extend its original deadline or stack the ROOM increase. Normal
or Reduced can end it sooner. ROOM restoration starts at the same deadline even
if floor release cannot be confirmed. Local contact expiry cannot restore the
heat pump's ROOM setting through a failed host or H66 connection.

Before any activation, the integration must persist the release obligation and
bind command ownership to the current device, connection and treatment. It must
reject stale or repeated activation commands, confirm each contact from fresh
device feedback, and release all owned contacts after cancellation, partial
activation, lost feedback, restart or expired permission. Missing release
confirmation keeps the obligation pending and blocks a replacement treatment.
Changing device identity or connection must never transfer old authority to the
replacement device or erase a pending physical obligation.

Contact history must record all four connections separately, preserving exact
state and quality changes. ON and OFF require actual feedback; commands,
configuration, cached status and elapsed time cannot establish a physical state.
Missing, stale and unsupported evidence remains unknown. An interrupted or partial
activation is not evidence of successful pooled floor heating.

The four current series are `floor_groundfloor_1_active` through
`floor_groundfloor_4_active`, in connection order. They remain unknown until a
supported integration supplies actual contact feedback. Any existing pending
physical release obligation remains visible; changing the planned hardware does
not confirm release or authorize commands to an unverified interface.

## Configuration

The current `controller.floor_preheat` settings are `enabled`, `commissioned`,
`renew_seconds` and `lease_seconds`. Both flags must remain false; the timing
defaults are 300 and 900 seconds respectively. There are no device address,
firmware or MQTT topic settings for the pending integration. Keep shared defaults
in the application configuration rather than copying them into the private file.
Retired device mappings are rejected instead of being reused for the new device.

## Setup and commissioning

The **Home floor preheating** section shows the single device, its four circuit
connections and current control availability. Configuration records installation
intent; it does not verify wiring, firmware capabilities or local failback.
Keep control disabled while integration is pending.

1. Confirm the installed device and the four numbered circuit connections against
   the table above. Have the wiring checked so each OFF state restores the
   thermostat path independently of the host, connection and device power. Check
   actuator power and travel delays, leaving other fixed valve settings unchanged.
2. Establish a supported firmware and control interface, including independent
   contact feedback, safe startup, bounded local expiry and rejection of stale
   activation. Verify compatible relay modes and remove competing schedules or
   command writers. Do not assume a general-purpose timer provides the required
   ownership, renewal and failure behavior.
3. With a supported integration available, verify all four ON/OFF readings and
   renewal without relay cycling. Confirm expiry both at a short planned end and
   at the maximum lease deadline, independently of host release commands.
4. Test host termination, connection loss, device restart, failed renewal,
   duplicate or delayed activation, one failed contact and lost release feedback.
   Observe actual override release and native thermostat operation. Electrical
   readback alone cannot prove that valves moved or water flowed.
5. Record the reviewed installation and commissioning outcome privately. Only
   then enable a supervised treatment, checking supply and floor limits, occupied
   room temperatures, hydraulic redistribution, valve delays and the complete
   recovery. Evidence must cover the selected circuit configuration throughout
   charging, reduction and recovery.

The initial treatment remains pooled. Independent Living/Storage control,
valve-position or flow sensing and automatic tuning of slab parameters need
separate implementation and evidence.
