# Meross MSG200 local garage doors

ST-MQ speaks the native signed Meross MQTT protocol directly. Home Assistant
can independently use [Meross LAN](https://github.com/krahabb/meross_lan), which
supports MSG200 and local MQTT/HTTP operation. Neither controller needs a Meross
cloud account for local operation after provisioning. SmartThings remains a
Home Assistant MQTT bridge; keep existing cover entity IDs and automation routes
when replacing the HA integration.

## Meross LAN command-response compatibility

MSG200 firmware 4.2.8 can acknowledge a command with every channel's contact
followed by a scalar execution flag. Meross LAN 5.8.0 assumes the first list item
belongs to the requested channel. Consequently Door 2 can display Door 1's state
after a command, and its movement tracking does not start. Periodic contact polls
can later correct the display; that does not make the command response correct.

The reviewed installer `scripts/apply-meross-lan-msg200.py` selects the matching
channel and recognizes the separate execution flag. It preserves legacy
single-channel responses and refuses ambiguous contacts. The execution flag
starts the existing movement estimate; it is not physical completion evidence.
The same firmware acknowledges list-shaped configuration writes without applying
them. The adapter sends dictionary-shaped per-channel configuration writes for
native garage numbers and switches, retaining the existing path for other
namespaces. Always verify settings with a fresh native configuration GET and
after Core restart; an optimistic HA number is not persisted device readback.
Synthetic tests execute the installed upstream command method with different
channel states, in addition to testing the installer and unknown-source refusal.

Install the script and the `integrations/homeassistant/meross-lan-msg200*`
files in the same relative layout under `/config/stmq-meross-msg200`. Apply with:

```sh
python3 /config/stmq-meross-msg200/scripts/apply-meross-lan-msg200.py \
  --integration-dir /config/custom_components/meross_lan \
  --backup-dir /config/private-backups/meross-lan-msg200
```

Restart HA Core to load the change. Install
`integrations/homeassistant/meross-lan-update-guard.yaml` as an HA package, using
the actual HACS update entity if different. It reapplies only the exact reviewed
5.8.0 source after reinstall and reports that a Core restart is needed. Unknown
versions, dependencies and source hashes require review; the guard never patches
them or restarts HA automatically. HACS remains the update manager, with this
explicit compatibility qualification for garage command responses.

ST-MQ's `garage.door_travel_seconds` owns its movement estimate. HA's native
opening/closing duration settings are separate command timeouts; allow for the
opener's start delay and contact-report latency rather than treating a timeout
as a full-open sensor. Meross LAN's `transition_duration` attribute is its own
learned fallback, not the configured ST-MQ travel time. Configure durations only
while the doors are stationary, then recheck device readiness before commanding.

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
2.1 differ. Keep ordinary password-file credentials unchanged. Their Dynamic Security client
entries need explicit application ACL roles, with no password in those entries
so authentication still defers to the existing password file. An authentication
success alone does not establish permission to subscribe. Verify existing ST-MQ
subscriptions as well as native account restrictions before any handover. The configured TLS
listener must present a device-compatible certificate. Keep existing fixed TLS
listeners and certificates separately when adding the VIP's local upstream.

HA's Meross LAN uses its local HTTP path independently of ST-MQ and falls back
to it when the device's MQTT endpoint is on the other computer. Existing
HA-backed publishers retain their fixed HA MQTT endpoint.

Some MQTT Device Creator versions accept only an IP address and always use
port 1883. Such clients can retain the shared VIP. On Ubuntu, use the existing
Mosquitto's narrowly scoped
`integrations/homeassistant/meross-ha-bridge.conf.example` to forward HA-owned
door commands and read-only queries to HA's fixed broker, returning its contact
snapshots and availability. Supply private local and remote credentials. Never
bridge native `/appliance` or application reply topics, or a broad household
wildcard. This adds no service and keeps SmartThings dependent on HA only.

Command routes use QoS 0 at the bridge and clean sessions at both ends so a
request issued while HA's broker is disconnected is dropped instead of replayed
after recovery. Inspect both brokers for retained door commands before enabling
the bridge. The real-broker regression
`test/extended/meross-ha-bridge.test.js` verifies one-time routing, exact snapshot
payload preservation, disconnected-command loss and native-topic isolation.
An outage can still make an in-flight command outcome uncertain; inspect current
door state before issuing another request.

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
