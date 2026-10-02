# Shelly Pill local-control handoff

The separate [shelly-cn105-mqtt repository](https://github.com/hokkanen/shelly-cn105-mqtt)
implements `shelly-cn105/v2`.
ST-MQ owns persistent Garage Normal/Away selections and sends their real targets.
The Pill owns local regulation and native pump commands; it has no mode labels,
price planner, timed OFF leases or externally renewed temperature permissions.

The temperature path is DS18B20 probes → Gen3 Shelly/add-on → BTHome Bluetooth →
Pill native BTHome components → reviewed CN105 driver. BTHome object `0x45`
index 0 carries the rear room temperature in 0.1°C. The Gen3 also receives the
Caravan BLU H&T through a separate MQTT bridge; that sensor no longer supplies
the Pill's room-regulation input. Replace its native Pill registration with the
Gen3's complete temperature/protection mapping.

The sender owns the conservative two-location pipe model and broadcasts protection
floor/rescue/validity. ST-MQ displays and configures it through MQTT. The Pill
retains the real user target and external enable through network loss/reboots,
uses fresh local sensing, preserves ordinary OFF, and explicitly selects HEAT/ON
for local frost rescue. Absent protection fields mean unavailable, not safe.

See **Connections & configuration → Garage freeze protection**, below
**Floor preheating**, for sender setup and protection readback. The driver
repository owns [Pill installation](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/installation.md),
[sender installation and component mapping](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/sender.md),
and [qualification evidence](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/status.md).
See also [Garage behavior](garage.md) and [adapter](garage-adapter.md). Retire
old physical OFF/external obligations through their original working driver
before replacing its sources; replacing code is not proof of restoration.
