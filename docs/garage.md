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

## Garage doors

The overview permanently shows the garage from the driveway: one centered gable
with **Left = Door 2** and **Right = Door 1**. Its compact animated button sits
between the rear temperature and room target. Selecting any part of the facade
opens the Garage doors dialog. Only the dialog's individual door buttons operate
the doors; they offer Open, Close or configured Stop according to current evidence
and command availability. Left and Right stay in the same positions at every
screen size. Other configured doors keep their names rather than being assigned
an assumed position.

The overview keeps one caption aligned with the all-in price label, with the roof
rising above the readings. An inline ≈ marks estimated travel; its explanation is
available on hover and to screen readers. The dialog retains detailed per-door
states and estimate labels.

Both views share the same illustration and reported states. Missing, stale or
ambiguous reports remain unknown. Sending or acknowledging a command does not
establish motion or position. Existing command receipts, read-only restrictions
and device authority checks still apply.

`garage.door_travel_seconds` is **18 seconds** by default, shared by both doors for
opening and closing. Travel animation uses constant linear speed; reversing
direction uses the remaining distance rather than restarting a full travel time.
Successful command publication starts the estimate's clock, but the illustration
waits for a fresh door response before showing that movement. When the response
arrives, both the overview and dialog jump to the position estimated from elapsed
time and animate the remaining distance. A response three seconds after successful
send therefore starts one sixth into an 18-second stroke, with 15 seconds left.
Unchanged reports cannot confirm a new direction or restart its timer.

Positions inferred during travel are labeled as estimates. A closed report ends
travel immediately; a binary Open/`coverState: open` report only establishes that
the door is not closed, so it does not skip or finish the opening animation.
When estimated closing reaches the floor, the downward arrow disappears in both
views. Each arrow shares its own shutter's animation clock; it does not wait for
the other door, a completion callback, or another status report. The door keeps
its attention colour and reported state until a closed
report confirms it; reduced motion hides the arrow when the shutter snaps closed.
The current contact integration has no measured opening percentage. Failed or
unacknowledged commands supply no timing anchor, and lost evidence or replacement
equipment clears pending estimates. Reported movement without a local command can
animate from the last known position, with no assumed command-start time.
This setting changes only the visualization, not motor timing or door controls.

## Local temperature regulation

The heat-pump controller retains the requested target and external-control
enable in persistent storage. The protection sender reads the rear probe and
broadcasts the real room temperature using BTHome Bluetooth. The heat-pump controller's
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

## Independent freeze protection

Open **Garage → Freeze protection**, directly below **Normal temperature**, for
live protection status and the **Rear · near pipe** and **Front · near door**
readings. Each location shows measured air temperature, estimated pipe temperature
and reserve above the configured margin. The pipe temperature and reserve are
model estimates, not direct pipe measurements. Unknown or stale evidence is
unavailable, never proof that the pipes are safe.

Protection monitors both locations in Normal and Away. When no intervention is
needed, it leaves ordinary target, power and mode choices to their existing
controls. When protection demands heating, it has two separate effects:

- **Temporary minimum room target:** the sender applies a minimum only while
  protection demands heating, including its recovery hold. There is no permanent
  5°C limit. With valid room input, a saved 3°C target temporarily becomes 5°C
  if protection requests a 5°C minimum, then returns to 3°C after release. An
  8°C selection remains 8°C with that same minimum. The saved target is never
  overwritten.
- **Heating rescue:** selects HEAT and ON, including when the pump was off or in
  another operating mode. It enables heating; it does not force the compressor
  to run continuously. Rescue can be active without increasing the room target.

After startup or missing exposure history, **pipe history uncertain** means the
sender cannot establish how cold the pipes became. It starts with a conservative
cold-state assumption and credits warming gradually. This is not a measurement
showing frozen pipes. Warm air alone cannot immediately establish a safe pipe
reserve; the estimates remain unavailable until the model has recovered. Rescue
clears after both locations have recovered and remained safe for ten minutes.
The sender then reports a zero minimum, meaning no protective target increase.
The controller follows the saved target and leaves the pump powered on.
If a configured protection feed becomes invalid or stale, a separate fault
fallback selects HEAT/ON at native 16°C while preserving the saved room target.
A stale, missing or out-of-range room measurement, or an unrepresentable calculated
external temperature, also uses native 16°C in HEAT. That room-input fallback
preserves power unless independent protection requests rescue. Valid protection
and a room-input fault can coexist, so check controller readback as well as the
sender's minimum.

The sender runs the two-location model locally and broadcasts the rear room
temperature, minimum target, rescue demand and validity to the heat-pump
controller over Bluetooth. Healthy local protection does not need ST-MQ, MQTT
or Wi-Fi.

Within **Garage → Freeze protection**, **Pipe model & settings** compares configured
and reported values without an editor. It also identifies the fixed safety factor
of 2 and explains the pipe calculation: geometry sets heat capacity and exposed
surface, air temperature drives heat exchange, cooling is counted at twice the
nominal rate and warming at half. Reserve is estimated energy above the protection
margin, not time until freezing. Pipe temperatures are estimates rather than
measurements. Installation approval, margin, pipe geometry and heat transfer
come from `garage.protection` in configuration; the fixed factor is a model
assumption, not a configurable or reported parameter.
After editing that source, use **Apply reviewed configuration** in **Data &
settings** or restart. ST-MQ applies loaded parameters over MQTT when Garage is
enabled and fresh sender status and local write authority permit it. The sender
validates and persists them; matching fresh readback confirms the configuration.
A command acknowledgement alone does not establish that protection is ready.

The live fold links to **Connections & configuration → Garage freeze protection**,
directly below **Floor preheating**, for installation and setup. That section
links back to Garage for live readings, settings and model details.

Use the [heat-pump controller and sender repository](https://github.com/hokkanen/shelly-cn105-mqtt)
for [sender setup](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/sender.md)
and [controller installation](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/installation.md).
The tested reference setup uses a **Shelly 1 Gen3, Plus Add-on and two DS18B20
probes** with firmware **2.0.1** as the sender, and **The Pill by Shelly** with
firmware **2.0.1-beta3** as the heat-pump controller. Other hardware must provide
the required sensor, Bluetooth and CN105 interfaces and be checked as an installed
system. See the [adapter contract](garage-adapter.md) for capabilities and
[pipe assumptions](garage-protection-defaults.md).

In **MQTT connections**, local freeze protection appears directly below the
Garage heat pump. The heat-pump controller receives the sender's rear-probe
temperature and all protection fields through native BTHome components.
Replace a former temperature-only commissioning
input only after verifying this complete mapping. Until fresh valid sender data
arrives, protection remains unavailable or in its configured fault fallback.
Simulated protection tests do not qualify an installed system.

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
controller's live local-regulation input. Its source is the sender's rear feed,
already recorded as `garage_temperature`. The former Caravan BLU H&T
commissioning input is not a rear-probe measurement. Regulation input
readback remains in current diagnostic state, with the reported sensor age,
but creates no separate temperature history or chart legend entry. The
rear/front acquisition sources keep their own timestamps and coverage.

**Saved room target** is the target retained by the heat-pump controller after a
Normal/Away selection; it is not necessarily the saved Normal target while Away
is selected.
**Effective room target** includes a temporary minimum while frost protection
demands heating; monitoring without demand adds no minimum. During normal room
regulation with usable input, a saved 3°C target and a 5°C protection minimum
produce a 5°C effective target until release, without changing the saved 3°C
request. Native 16°C is shown separately for a fault fallback. Neither is the native
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
  ordinary target/operation. A minimum may raise the effective target; rescue
  selects HEAT and ON even if the saved target already exceeds that minimum.
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
