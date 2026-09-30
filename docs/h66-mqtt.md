# H66 MQTT setup

ST-MQ connects to the Husdata H66 through the existing MQTT broker. The gateway's
web address is used for setup; `controller.h66_device` selects its MQTT identity.
The integration uses the Thermia/Danfoss C60 register profile. Confirm that the
installed gateway identifies the connected heat pump with that profile.

## Configure the gateway

Open the H66 web interface and set these MQTT options:

| Setting | Value |
| --- | --- |
| `MQTT_SRVR` | The existing ST-MQ broker's hostname or IP, reachable from the gateway |
| `MQTT_PORT` | The broker's MQTT port, conventionally `1883`; `0` disables MQTT |
| `MQTT_USER` / `MQTT_PASS` | Credentials accepted by that broker |
| `MQTT_SUBS` | `ON` in the web interface (`1` in the CLI), for native setting commands |
| `MQTT_PUBALL` | `1` minute, to repeat unchanged readings while ST-MQ is connected |
| `MQTT_DISCOV` | Optional for Home Assistant; direct ST-MQ integration does not need discovery |

Save the settings and restart the gateway. Confirm that its log reports
an MQTT connection. H66 publishes changed values immediately; periodic full
publication keeps unchanged values available for ST-MQ's freshness checks.
See Husdata's [settings explanation](https://husdata.se/docs/h60-manual/settings-explanation/).

The gateway publishes `<device>/HP/<register>`. Take `<device>` from an actual
publication; it is the exact MAC-based topic prefix, including its spelling and
case. ST-MQ subscribes to this device and sends `GETALL` to `<device>/HP/CMD` on
connection and once per minute. Setting commands use
`<device>/HP/SET/<register>`. Broker permissions must allow both directions.
See the [Husdata MQTT specification](https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/).

## Configure ST-MQ

Keep the existing `mqtt` broker connection fields. Set `controller.h66_device`
to the exact prefix **without `/HP`**, a hostname, an IP address or MQTT wildcards.
An illustrative partial configuration uses a deliberately invented identifier:

```json
{
  "controller": {
    "input": "providers",
    "h66_device": "EXAMPLE_H66_DEVICE"
  }
}
```

Both `providers` and `mqtt` input support H66. Preserve the installation's chosen
live input and keep Home heating on **Pause** while commissioning; it does
not start automatic heating commands. Explicit manual controls remain available.

Save private settings in the configured private configuration file, or save
add-on options in Home Assistant. Choose **Data & settings → Connections &
settings → Configuration → Apply configuration**. H66 device selection and
broker changes reconnect without an ST-MQ restart when input is already live.
Changing from `simulated` or `offline` to a live input requires a restart. See
[configuration application](../DOCS.md) for private imports and restart settings.

## Verify live readings

Open **Home → Sensors & Equipment →
Ground-source heat pump**. Open **All heat-pump readings**, below
**Adjust heat-pump parameters**. Readings are grouped by function with a short
description beside each value. Select a value for freshness and receipt time. Check:

- Fresh temperatures, including outdoor register `0007`, against the gateway.
- Compressor `1A01`, reversing valve `1A07` and auxiliary output `3104` against
  the gateway's current states.
- The four native settings: ROOM `0203`, hot-water start `0212`, hot-water stop
  `0208`, and operating mode `2201`.
- Further live publications while values remain unchanged, and renewed readings
  after reconnecting ST-MQ.

Compare engineering units before sending commands. MQTT temperatures should
match degrees Celsius displayed by the gateway; auxiliary output is a percentage.
Use `controller.h66_verification_file` only for an explicitly verified installed
scaling difference. A retained broker value alone does not establish live data.
H66 normally supplies no measurement timestamp, so ST-MQ labels freshness using
receipt time. A successful MQTT connection alone does not establish heat-pump
communication or a matching register profile.

## Verify native settings and temporary heating restoration

Once the readings agree, **Adjust heat-pump parameters** makes an ordinary native
device edit. Record the original setting, choose a nearby valid value, and confirm
both the gateway and dashboard report the changed value. It stays in effect until
deliberately changed again, including across controller updates, pause expiry and
application restart. Change it back explicitly after a commissioning check.

The separate **Manual heating override** uses the automatic phase actions.
Normal and Reduced are reassessed on the next controller update in Automatic;
during Pause they stay until changed, Automatic, or the optional resume time.
Preheat always ends at its original floor lease deadline, with ROOM restored at
the same time independently of floor feedback. The previous captured native
baseline includes any permanent parameter edit made before the adjustment.

Broker delivery is separate from matching native readback. A permanent native
edit is never replayed or rolled back after uncertain delivery; fresh pump
readings establish its actual result. Temporary overrides retain their persisted
restoration duty after reconnect or restart. Restoration requires the application
and gateway connection; H66 has no documented device-side expiry.
Resolve failed readback or pending restoration before enabling automatic control.
The supported controls and their roles are documented in
[learning and control](learning-and-control.md#h66-readbacks-and-commands).

Restoration rechecks the same register obligation immediately before each SET and
after its readback. An external panel change during another register's awaited
readback cancels that register's pending restoration. A no-op automatic request
owns no write, but its value is watched so a subsequent manual change invalidates
the plan. Only a fresh authorized write may acquire a new baseline. MQTT cannot
provide an atomic compare-and-set after a command has already left the host.

In-process holds also use elapsed deadlines. Backward wall-clock corrections do
not renew a one-minute setting or an owner-selected pause; forward corrections
may end one early. Restart never reuses a monotonic clock origin: persisted
current obligations are restored conservatively with fresh readback.
