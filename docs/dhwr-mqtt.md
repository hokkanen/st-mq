# DHWR MQTT switch setup

ST-MQ starts and stops domestic hot-water recirculation. Configure a **switch**
with separate ON and OFF actions in the MQTT-to-device integration. Remove the
old SmartThings push-button action and its fixed ten-minute duration from this
path. No device setup or live commands are performed by installing this code.

The private configuration supports:

```json
{
  "mqtt": { "dhwr_topic": "from_stmq/dhwr/set" },
  "controller": { "dhwr_duration_minutes": 10 }
}
```

Keep the existing broker address and authentication settings. The topic must be
an exact topic, without MQTT wildcards. ST-MQ sends the literal uppercase string
`ON` to start, then `OFF` after the configured duration (1–60 minutes). Messages
use QoS 1 with retain disabled. Configure the receiving integration to set the
switch idempotently: duplicate ON messages must not create independent timers.
The old `from_stmq/heat/action` `heaton60` button message is no longer published.
The heating test's **Start DHWR** action uses the same ST-MQ timer as automation.
Reload settings to apply a new duration; an existing run is stopped through the
normal runtime restoration before the new configuration starts.

The deadline starts when ON delivery completes; subsequent heating command or
H66 readback latency does not extend it. ST-MQ saves an OFF obligation before
attempting ON, because a lost broker acknowledgement can still mean delivery.
The expiry timer sends OFF without waiting for the next control tick. Shutdown,
control restoration and restart also send OFF. Failed OFF delivery remains
pending and is retried while ST-MQ owns control. Turning off automatic control
restores equipment; monitoring/shadow mode never starts a new automatic run.
In a paired installation, a demoted instance stops sending commands; its saved
obligation is handled by the instance that owns control on restoration.

A stopped process or unreachable broker cannot deliver OFF. Set the device's
own maximum-on watchdog, if supported, above the longest configured ST-MQ run
as an independent failsafe, and set its power-on state to OFF. This watchdog is
not the normal run-duration control. Verify ON, timed OFF and restart restoration
on the installed device before enabling active control.

MQTT acknowledgement proves broker delivery, not physical pump operation. The
chart therefore shows **requested** circulation, clipped by recorded OFF
requests. Imported historical CSV `heaton60` pulses keep their original ten-minute
interpretation. This changes actuator execution, not the committed learning
algorithm, prior journal data or imported CSV provenance.
