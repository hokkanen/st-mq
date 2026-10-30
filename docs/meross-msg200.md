# Meross MSG200 local garage doors

ST-MQ speaks the native signed Meross MQTT protocol directly. Home Assistant
can independently use [Meross LAN](https://github.com/krahabb/meross_lan), which
supports MSG200 and local MQTT/HTTP operation. Neither controller needs a Meross
cloud account for local operation after provisioning. SmartThings remains a
Home Assistant MQTT bridge; keep existing cover entity IDs and automation routes
when replacing the HA integration.

## Native configuration

Put device identity and key in private configuration outside the checkout.
An `equipment.devices` override replaces the full device list; preserve all
other equipment entries. This example uses invented identity and key values:

```json
{
  "id": "garage_door1",
  "label": "Door 1",
  "area": "garage",
  "kind": "door",
  "connection": "mqtt:/appliance/0123456789abcdef0123456789abcdef/publish",
  "cover_control": false,
  "meross": {
    "uuid": "0123456789abcdef0123456789abcdef",
    "key": "abcdef0123456789abcdef0123456789",
    "channel": 1
  }
}
```

MSG200 channels are 1–3. Map each contact to the established door before enabling
`cover_control`. Each configured channel owns its existing history signal and
can share the same native device topic. Generic MQTT mappings are rejected on
Meross entries. Native Meross routes use the primary broker on each ST-MQ node;
HA-hosted generic MQTT equipment retains its separate routing.

The adapter subscribes to the device publish topic and a random application reply
topic. It queries after subscription and every equipment poll interval. Reports
expire after 90 seconds by default. An authenticated PUSH or a correlated GETACK
provides contact evidence; retained messages, SETACK, executed-command fields,
invalid signatures, stale timestamps and duplicate message IDs do not renew it.
Device clocks ahead of reception are conservatively rejected. Polling and
reconnection send state GET requests only. Signed Bind/Clock session messages
receive bounded protocol acknowledgements or clock replies; these cannot
operate a door or establish contact evidence. Open/close use the existing authority, live readiness,
bounded deadline, state-change and byte-write guards. Commands are never retained,
retried or replayed. Broker acknowledgement does not prove device acceptance or
movement. There is no native Stop command exposed for this device.

Meross MD5 signs the message ID, key and source timestamp; it does **not** protect
the payload. Trusted broker accounts and restricted topic ACLs remain necessary.
Avoid publishing untrusted data on native device or application reply topics.

## Shared broker endpoint

Reuse the existing paired VIP and local Mosquitto brokers. Optional
`pair.mqtt_tls_port` enables a second, opaque TCP frontend at `VIP:8883`, targeting
the primary broker hostname at that TLS port. Zero (default) disables it. Both
frontends share role ownership, close connections before VIP release, and require
matching listener contracts at handover. TLS standby preflight probes a separate
loopback address, permitting an existing fixed-address TLS listener while still
rejecting a conflicting wildcard listener. Certificates and broker authentication
belong to Mosquitto, not ST-MQ.

Provision equivalent device credentials and topic ACLs on both brokers, with
working local TLS listeners. Bind the Linux broker listener away from the VIP;
map the HA add-on's published TLS listener to a distinct management port if it
would conflict with the VIP frontend. Use the actual local TLS port in each
node's configuration. Validate both before binding the appliance to the VIP.
Meross firmware credentials differ from ordinary application credentials. Their
username contains colons, so the Mosquitto password-file tool cannot provision
it. Use the stock Dynamic Security plugin and the installed version's own
`mosquitto_ctrl` password tooling, with a device role limited to its native topics
and application reply topics. No anonymous access is needed.

The official HA Mosquitto app can retain its normal update path. Provision the
fixed device username as a dedicated local-only, read-only Home Assistant user
with the firmware-derived MQTT password. Do not put that colon-containing
username in the app's password-file `logins` list. Supervisor authenticates it
through HA initially and persists a hashed credential cache; when Core is down,
the installed Supervisor explicitly checks that cache. Warm and verify the cache
before binding the device. Verify a fresh connection after restarting Mosquitto
with Core stopped, and verify the cached credential on disk. This still requires
HAOS Supervisor on that host, independently of HA Core. A newly provisioned or
changed credential must be validated while Core is available before relying on
its cached value. The HA broker retains its existing account authorization model;
Ubuntu's native Dynamic Security role restricts device topic access.

Provision the same firmware credential on Ubuntu using its bundled Dynamic
Security plugin. Use the broker version's own password format; Mosquitto 2.0 and
2.1 differ. Keep ordinary password-file accounts unchanged. The configured TLS
listener must present a device-compatible certificate. Keep existing fixed TLS
listeners and certificates separately when adding the VIP's local upstream.

HA's Meross LAN uses its local HTTP path independently of ST-MQ and falls back
to it when the device's MQTT endpoint is on the other computer. Existing
HA-backed publishers and SmartThings stay on their fixed HA MQTT endpoint.

Failover remains owner-confirmed under the [pairing contract](pairing.md). This
is a shared endpoint over two independent brokers, not replicated MQTT session
or retained-message storage. Devices must reconnect and publish/query fresh state
after handover. HA clients using a fixed broker need an explicit strategy for
reaching the active broker before an appliance is moved to that endpoint.

## Safe installation and rollback

Back up the active ST-MQ database through its supported export, verify SQLite
integrity and foreign keys, and retain private configurations, HA registries,
automations and the old device binding. Deploy the committed source to the
synchronized standby first; use the documented explicit handover sequence.
Install Meross LAN alongside the old integration and validate read-only local
state before changing entity ownership. Preserve SmartThings topics and cover IDs.

Before a HA or broker restart, inspect startup automations and retained command
messages so reconnect cannot deliver an old movement request. Never test a command
by publishing an Open/Close/Stop packet while the owner is away. Keep native
ST-MQ controls disabled until installation mapping is verified. Retain the previous
Meross broker and integration until the new paths have passed physical tests.

Final attended qualification must cover both contacts and mapped commands, native
protection, HA and ST-MQ independence, SmartThings round trips, application restart,
MQTT disconnect, explicit broker handover in both directions, and restoration of
the intended HA-master/Linux-slave roles. Source tests and status GET responses
alone do not prove physical operation or outage recovery.
