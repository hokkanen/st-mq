# Garage heating

Garage has manually selected **Normal** and **Away** temperatures. Neither mode
expires. There is no Garage price planner, learned building heat model, automatic
setback, timed OFF lease or predicted savings. Home heating is independent.

## Everyday controls

Normal uses the saved normal target; Away uses the configured preset (5°C by
default). Selecting Normal again restores the normal target. The selection is
bound to the configured pump and persists across application restart. Pump
readback and command confirmation remain separate from requested settings.
Changing a mode sends the real target to the heat-pump controller. It does not
replay unrelated power, mode, fan or vane commands. Native power OFF remains an
explicit device choice; frost rescue is a separate higher-priority operation.

A target increase displays a moisture advisory: avoid bringing wet or snowy cars
inside, or adding significant moisture, for roughly the next 24 hours and longer
if stored objects remain cold. Air can warm faster than surfaces; added moisture
can cause condensation on those surfaces. The time is guidance, not proof of safe
surface temperatures. The advisory has an age; the chosen heating mode has no expiry.

## Local temperature regulation

The heat-pump controller retains the requested target and external-control
enable in persistent storage. A Gen3 Shelly with the sensor add-on broadcasts
the real room temperature using BTHome Bluetooth. The heat-pump controller's
native BTHome components receive the measurement; its script does not scan or
decode arbitrary Bluetooth traffic.

With fresh input in HEAT mode, the controller confirms native 17°C before
feeding:

```
external temperature = measured room temperature + 17°C - effective target
```

The calculated value must fit the supported CN105 range/encoding. The script
maintains native 17°C while this control is active, including after a remote
setpoint change. It preserves native OFF. Non-HEAT clears and suspends the heating
override; HEAT return resumes with fresh measurements. After 180 seconds without
fresh valid measurements, it clears external sensing and selects native 16°C
while in HEAT, preserving power. This fault fallback can cause warming and is
shown separately from the selected target. Wi-Fi/MQTT loss does not expire the
saved target or interrupt a healthy local Bluetooth feed.

## Independent frost protection

The protection sender owns separate front/rear conservative pipe-temperature
estimates. It broadcasts a minimum target, rescue demand and validity alongside
the real room temperature. The heat-pump controller applies the higher required
target without overwriting the saved user target. Rescue explicitly selects HEAT
and ON. Protection is local: the sender and heat-pump controller communicate
without an ST-MQ or MQTT broker connection.

The **Freeze protection** panel shows sender availability, readings, estimates,
settings and active demand. **Protection settings** compares configured and
reported values without an editor. Installation approval, margin, pipe geometry
and heat transfer come from `garage.protection` in configuration. After editing
that source, use **Apply configuration** in **Data & settings** or restart.
ST-MQ applies the loaded parameters over MQTT when Garage is enabled and fresh
sender status and local write authority permit it. The sender validates and
persists them; only matching fresh readback confirms the configuration.
Missing/stale status is unavailable, never proof of safety. See
[pipe assumptions](garage-protection-defaults.md) and [adapter contract](garage-adapter.md).

In **MQTT connections**, local frost protection appears directly below the
Garage heat pump.

The BLU H&T is a development temperature source. It does not provide two-probe
pipe protection. The UI explicitly shows this limitation until the protection
sender is configured and fresh. Simulated protection tests are not installed
qualification.

## Recording and charts

Keep original rear/front temperatures, doors, native pump observations, actual
energy evidence and explicit mode/target/protection changes. Show requested and
effective targets separately. No Garage coefficients, learned warmth references,
forecast errors or automatic savings outcomes are produced or reconstructed.
Dedicated measured energy can still support an electricity timing comparison;
that comparison does not claim automation savings. Historical observations keep
their original timestamps and units. Generic original journal/event records are
not deleted or reinterpreted when the retired learning writer is removed.

**Garage temperatures & compressor** places heat-pump defrost above the door activity
rows. **Garage protection & electricity** combines saved/effective targets, pipe
estimates, frost-protection state and interval electricity; there is no separate
Garage electricity view. The same series retain their colours in every view and
in the series explorer, with distinct front/rear air and pipe-estimate colours.
User-facing descriptions name the heat-pump controller and local frost-protection
unit by role rather than by integration hardware. Selecting Normal or Away shows
pending confirmation until controller readback confirms the target; polling
refreshes that feedback without implying the compressor is running.

Read-only replicas display recorded evidence without granting device control.

Heating control shows matching mode cards followed by heat-pump compressor
activity, effective target and independent freeze protection. The saved target
stays in the overview and mode buttons; it does not need a second summary row.
Select a status value for confirmation, source and availability details.

The **Regulation input** under **Heat-pump readings** is the heat-pump
controller's live local-regulation input. Its intended permanent source is the
rear feed, already recorded as `garage_temperature`. The temporary Caravan BLU
H&T used for commissioning is not a rear-probe measurement. Its controller
readback remains in current diagnostic state, with the reported sensor age,
but creates no separate temperature history or chart legend entry. The
rear/front acquisition sources keep their own timestamps and coverage.

**Saved room target** is the target retained by the heat-pump controller after a
Normal/Away selection; it is not necessarily the saved Normal target while Away
is selected.
**Effective room target** includes the independent frost-protection minimum.
For example, a saved 5°C target and an 8°C protection minimum produce an 8°C
effective target without changing the saved 5°C request. Neither is the native
17°C thermostat used during active local regulation.

The state legend entries describe separate facts:

- **Local room regulation** reports whether the controller's external room
  regulation is enabled. It does not prove that regulation is currently active:
  sensor freshness, native mode and pump communication still matter.
- **Frost protection available** reports whether the controller has a usable
  protection feed. A temperature-only BLU H&T cannot provide it. False means
  protection is unavailable, not that temperatures are safe; missing readback
  remains unknown.
- **Frost override** reports an active independent protection override of the
  ordinary target/operation. Rescue may explicitly select HEAT and ON.
- **Defrost** is the pump's native reported defrost cycle, separate from protecting
  the garage's pipes against freezing.

### Recorded Garage series

These are the 19 current Garage history signals. Actual stored rows depend on
configured sources and received evidence; unsupported/missing readings are not
invented. Current adapter/sender snapshots and command events are separate from
these time series.

| Database signal | Meaning |
| --- | --- |
| `garage_temperature` | Rear air temperature |
| `garage_temperature_2` | Front air temperature |
| `garage_door1_open` | Door 1 open/closed |
| `garage_door2_open` | Door 2 open/closed |
| `garage_room_target` | Heat-pump controller's saved room target |
| `garage_effective_target` | Heat-pump controller's effective target including protection |
| `garage_away_mode` | Saved Normal/Away selection |
| `garage_external_enabled` | Heat-pump controller's local room regulation enabled |
| `garage_frost_available` | Heat-pump controller's protection feed available |
| `garage_frost_active` | Heat-pump controller's frost override active |
| `garage_pipe_rear_temperature` | Sender's estimated rear pipe temperature |
| `garage_pipe_front_temperature` | Sender's estimated front pipe temperature |
| `garage_native_power` | Native ON/OFF setting, not measured watts |
| `garage_native_indoor_temperature` | Pump-interpreted indoor temperature |
| `garage_compressor_frequency` | Reported compressor frequency, Hz |
| `garage_compressor_active` | Reported compressor running state |
| `garage_native_defrost` | Reported pump defrost state |
| `garage_native_energy` | Cumulative native energy counter, kWh; audit only |
| `garage_energy` | Qualified dedicated interval electricity, kWh |
