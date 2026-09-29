# Garage heating

Garage has manually selected **Normal** and **Away** temperatures. Neither mode
expires. There is no Garage price planner, learned building heat model, automatic
setback, timed OFF lease or predicted savings. Home heating is independent.

## Everyday controls

Normal uses the saved normal target; Away uses the configured preset (5°C by
default). Selecting Normal again restores the normal target. The selection is
bound to the configured pump and persists across application restart. Pump
readback and command confirmation remain separate from requested settings.
Changing a mode sends the real target to the Pill. It does not replay unrelated
power, mode, fan or vane commands. Native power OFF remains an explicit device
choice; frost rescue is a separate higher-priority operation.

A target increase displays a moisture advisory: avoid bringing wet or snowy cars
inside, or adding significant moisture, for roughly the next 24 hours and longer
if stored objects remain cold. Air can warm faster than surfaces; added moisture
can cause condensation on those surfaces. The time is guidance, not proof of safe
surface temperatures. The advisory has an age; the chosen heating mode has no expiry.

## Local temperature regulation

The Pill retains the requested target and external-control enable in its KVS.
A Gen3 Shelly with the sensor add-on broadcasts the real room temperature using
BTHome Bluetooth. The Pill's native BTHome components receive the measurement;
its script does not scan or decode arbitrary Bluetooth traffic.

With fresh input in HEAT mode, the Pill confirms native 17°C before feeding:

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

The sending Gen3 owns separate front/rear conservative pipe-temperature estimates.
It broadcasts a minimum target, rescue demand and validity alongside the real room
temperature. The Pill applies the higher required target without overwriting the
saved user target. Rescue explicitly selects HEAT and ON. Protection is local:
ST-MQ and its MQTT broker do not need to remain connected for the sender/Pill loop.

The **Frost protection** panel shows sender availability, readings, estimates,
settings and active demand. ST-MQ can request protection-setting changes over
MQTT; the sender validates and persists them and reports actual applied settings.
Missing/stale status is unavailable, never proof of safety. See
[pipe assumptions](garage-protection-defaults.md) and [adapter contract](garage-adapter.md).

The BLU H&T is a development temperature source. It does not provide two-probe
pipe protection. The UI explicitly shows this limitation until the Gen3 sender
is configured and fresh. Simulated protection tests are not installed qualification.

## Recording and charts

Keep original rear/front temperatures, doors, native pump observations, actual
energy evidence and explicit mode/target/protection changes. Show requested and
effective targets separately. No Garage coefficients, learned warmth references,
forecast errors or automatic savings outcomes are produced or reconstructed.
Dedicated measured energy can still support an electricity timing comparison;
that comparison does not claim automation savings. Historical observations keep
their original timestamps and units. Generic original journal/event records are
not deleted or reinterpreted when the retired learning writer is removed.

Read-only replicas display recorded evidence without granting device control.
