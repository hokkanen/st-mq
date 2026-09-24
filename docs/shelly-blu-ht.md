# Shelly BLU H&T over local MQTT

The BLU H&T / BLU H&T ZB can report directly to ST-MQ through a Bluetooth-capable
Shelly Plus running the supplied bridge script. No Shelly account, phone app,
Home Assistant or Zigbee coordinator is needed for this Bluetooth route. The
Plus 1 receives Bluetooth; it is not a Zigbee coordinator.

The public equipment configuration labels the Shelly BLU H&T **Caravan air** in
Garage MQTT diagnostics and shows its temperature and humidity inside **Garage →
Sensors & More equipment → Caravan**. Its topic prefix is `stmq/garage/caravan_air`, beside the other Caravan devices.
Regenerate and reinstall the bridge script when adopting this current configuration;
ST-MQ does not subscribe to the former Home topic.
`caravan_temperature` (°C) and `caravan_humidity` (% RH) are recorded and available
in chart history. Battery and Bluetooth signal strength are live diagnostics only.
This sensor is not an input to Home learning, its indoor average, or Garage protection.

## Gateway setup

1. Enable Bluetooth and configure the gateway's MQTT connection to the same broker
   as ST-MQ. The script uses the gateway's existing broker credentials. Allow it
   to publish `stmq/garage/caravan_air/state` and subscribe to `stmq/garage/caravan_air/get`.
2. Identify the sensor's Bluetooth address using a nearby BLE scanner. Match the
   H&T device, rather than selecting an arbitrary temperature advertisement.
   Unencrypted BTHome advertisements need no Bluetooth pairing. The bridge only
   accepts the configured address. Encrypted advertisements are unsupported and
   are ignored; they require a separate decryption/bonding setup.
3. Generate the script from the repository root. The prompt keeps the hardware
   address out of command history; the generated private file stays outside Git:

   ```sh
   read -r -p 'Sensor Bluetooth address: ' BLU_ADDRESS
   export BLU_ADDRESS
   node --input-type=module - <<'JS'
   import { writeFileSync } from 'node:fs';
   import { bluHtScript } from './integrations/shelly/blu-ht.js';
   writeFileSync('/tmp/stmq-blu-ht.js', bluHtScript({ address: process.env.BLU_ADDRESS }), { mode: 0o600 });
   JS
   unset BLU_ADDRESS
   ```

4. Open the Plus's local web interface, create a script, paste the generated
   contents, start it, and enable running on startup. The script uses the Gen2
   `BLE.Scanner.Start` / `Subscribe` API, verified on Plus 1 firmware 1.7.5.
   It performs no relay operations. Clock synchronization must work on the Plus;
   readings are withheld until it has a valid Unix clock.
5. Apply ST-MQ configuration and check the new equipment card. If private
   configuration supplies `equipment.devices`, it replaces the public list;
   append the object returned by `bluHtEquipment()` to that private list.
   Keep any sensor hardware address out of public configuration and Git.

`bluHtScript()` and `bluHtEquipment()` accept a matching `prefix` for additional
sensors. Each equipment entry also needs its own `id`. The default entry is Caravan air;
additional sensors can supply `label`, `area`, `temperatureSignal` and
`humiditySignal` (custom IDs default to their own signal names). These generators do not
modify device settings or install scripts themselves.

## Reporting and polling

The H&T ZB broadcasts a BTHome sample about every 60 seconds. A short physical
button press triggers an immediate measurement and transmission. The bridge
publishes every genuine report, including unchanged values, and suppresses
repeated packets within an advertising burst. Payloads use QoS 1 without retention:

```json
{"temperature":21.5,"humidity":46,"battery":95,"rssi":-65,"timestamp":1789992000000,"time_basis":"blu-received"}
```

`timestamp` is UTC epoch milliseconds when the gateway received the Bluetooth
report, not a sensor-provided measurement clock. ST-MQ marks the equipment
unavailable after 180 seconds without a new report. A stopped script, out-of-range
sensor, flat battery or gateway outage therefore cannot leave it healthy forever.

To read the latest received sample, publish the literal string `status` to
`stmq/garage/caravan_air/get`. The bridge replies on `stmq/garage/caravan_air/state` with the
**original timestamp**. ST-MQ sends this query on startup/reconnection and when
**Recheck** is used. No sample means no response until a Bluetooth report arrives.
A stale cached reply stays stale; polling does not establish a new measurement.
The script never republishes cached data on a timer.

The sensor's documented GATT `BTHome sample` characteristic also reads its latest
sample. It is not a documented remote command to force a measurement, and this
bridge does not use GATT connections. Its regular 60-second broadcasts are the
normal update mechanism. The ZB model can separately participate in Zigbee, but
that requires a Zigbee coordinator rather than this Plus 1 Bluetooth bridge.

References: [H&T ZB protocol and reporting](https://shelly-api-docs.shelly.cloud/docs-ble/Devices/BLU_ZB/ht_ZB/),
[original BLU H&T](https://shelly-api-docs.shelly.cloud/docs-ble/Devices/BLU/ht/),
[BLE scripting](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/BLE/),
[MQTT scripting](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/MQTT/).
