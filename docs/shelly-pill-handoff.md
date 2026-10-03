# Heat-pump local-control handoff

The separate [shelly-cn105-mqtt repository](https://github.com/hokkanen/shelly-cn105-mqtt)
implements `shelly-cn105/v2`.
ST-MQ owns persistent Garage Normal/Away selections and sends their real targets.
The heat-pump controller owns local regulation and native pump commands; it has
no mode labels, price planner, timed OFF leases or externally renewed temperature permissions.

The temperature path is DS18B20 probes → protection sender/add-on → BTHome Bluetooth →
controller native BTHome components → reviewed CN105 driver. BTHome object `0x45`
index 0 carries the rear room temperature in 0.1°C. In the example installation,
the sender also receives the Caravan BLU H&T through a separate MQTT bridge; that sensor no longer supplies
the heat-pump controller's room-regulation input. Replace its native controller
registration with the sender's complete temperature/protection mapping.

The sender owns the conservative two-location pipe model and broadcasts protection
floor/rescue/validity. ST-MQ displays and configures it through MQTT. The heat-pump
controller retains the real user target and external enable through network loss/reboots,
uses fresh local sensing, preserves ordinary OFF, and explicitly selects HEAT/ON
for local frost rescue. Absent protection fields mean unavailable, not safe.

See **Connections & configuration → Garage freeze protection**, below
**Home floor preheating**, for installation and setup. The linked
**Garage → Freeze protection** fold below **Normal temperature** shows live readings,
compares configured and reported protection settings, and explains the pipe model
and its fixed safety factor. It also explains the minimum target, Heat/On rescue,
uncertain history, recovery and fault fallback. The driver
repository owns [controller installation](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/installation.md),
[sender installation and component mapping](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/sender.md),
and [qualification evidence](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/status.md).
See also [Garage behavior](garage.md) and [adapter](garage-adapter.md). Retire
old physical OFF/external obligations through their original working driver
before replacing its sources; replacing code is not proof of restoration.
