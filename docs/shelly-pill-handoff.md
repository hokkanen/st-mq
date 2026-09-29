# Shelly Pill local-control handoff

The separate `shelly-cn105-mqtt` repository implements `shelly-cn105/v2`.
ST-MQ owns persistent Garage Normal/Away selections and sends their real targets.
The Pill owns local regulation and native pump commands; it has no mode labels,
price planner, timed OFF leases or externally renewed temperature permissions.

The temperature path is DS18B20 probes → Gen3 Shelly/add-on → BTHome Bluetooth →
Pill native BTHome components → reviewed CN105 driver. The BLU H&T can validate
the temperature path before the Gen3 is installed. Its BTHome object 0x45 carries
temperature in 0.1°C; the Gen3 uses the same real-temperature object.

The sender owns the conservative two-location pipe model and broadcasts protection
floor/rescue/validity. ST-MQ displays and configures it through MQTT. The Pill
retains the real user target and external enable through network loss/reboots,
uses fresh local sensing, preserves ordinary OFF, and explicitly selects HEAT/ON
for local frost rescue. Absent protection fields mean unavailable, not safe.

See [Garage behavior](garage.md), [adapter](garage-adapter.md) and the driver
repository's current schemas, deployment tools and qualification record. Retire
old physical OFF/external obligations through their original working driver
before replacing its sources; replacing code is not proof of restoration.
