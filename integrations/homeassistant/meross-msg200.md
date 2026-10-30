# Home Assistant and SmartThings MSG200 setup

Home Assistant uses [Meross LAN](https://github.com/krahabb/meross_lan) for the
MSG200's local MQTT and HTTP interfaces. MQTT Device Creator in SmartThings sends
requests to HA's cover services and receives HA's contact snapshots. Existing
cover entity IDs, MQTT topics and SmartThings devices can be preserved.

## Meross LAN installation

Install Meross LAN through HACS and configure the device's local address and key.
Keep its HA cover IDs consistent with the existing automations. Disable unused
channels in HA's entity registry. HA's MQTT integration remains connected to its
fixed broker; Meross LAN uses local HTTP when the appliance is connected to the
other broker. No Meross cloud profile is required for this configuration.

Version 5.8.0 needs the supplied MSG200 compatibility adapter for firmware 4.2.8.
That firmware can acknowledge commands with all channel states followed by a
scalar execution flag. The adapter selects the requested channel and recognizes
that flag. It also uses dictionary-shaped native configuration writes, because
this firmware can acknowledge list-shaped writes without applying them.

Install these files in the same relative layout under `/config/stmq-meross-msg200`:

- `scripts/apply-meross-lan-msg200.py`
- `integrations/homeassistant/meross-lan-msg200-state.py`
- `integrations/homeassistant/meross-lan-msg200.json`

Apply the adapter:

```sh
python3 /config/stmq-meross-msg200/scripts/apply-meross-lan-msg200.py \
  --integration-dir /config/custom_components/meross_lan \
  --backup-dir /config/private-backups/meross-lan-msg200
```

Restart HA Core to load it. Install `meross-lan-update-guard.yaml` as an HA package
using the installation's actual HACS update entity. The guard restores the fix
only for the exact reviewed 5.8.0 source and dependencies. It reports that Core
needs a restart after restoration. Unknown updates require compatibility review;
the guard does not patch them or restart Core automatically.

Configure native opening and closing timeouts with the doors stationary. Their
values include opener start delay and reporting margin. A timeout is not a
position sensor. Meross LAN's `transition_duration` attribute is a learned fallback;
it is separate from the native timeout settings and any external travel estimate.
Verify changed values through a fresh `Appliance.GarageDoor.MultipleConfig` GET
and after Core restart; an optimistic HA number is not persisted device readback.

## MQTT automations

`mqtt-feeds.js` supplies `garageMqttAutomation` for contact snapshots and
`garageCoverAutomation` for the corresponding cover services. Each door uses its
own private source entity mapping and the following topics:

| Route | Door 1 | Door 2 |
| --- | --- | --- |
| Contact | `stmq/garage/door1/status/contact` | `stmq/garage/door2/status/contact` |
| Request | `stmq/garage/door1/command/cover` | `stmq/garage/door2/command/cover` |
| Read-only snapshot query | `stmq/garage/door1/command` | `stmq/garage/door2/command` |
| Source availability | `stmq/garage/door1/availability` | `stmq/garage/door2/availability` |

Generate one publisher with `kind: "contact"` and one cover automation per door.
[Install the automation objects](README.md#installing-automations) individually.
Status publishers are installed and checked before command handlers. Commands
and snapshot requests use retention disabled. Any retained movement request is
cleared before enabling its handler; HA's MQTT automation trigger does not expose
that flag.

Contact snapshots include `value`, `timestamp`, `published_at`, `available` and
`cover_state`. The source entity's `last_reported` supplies `timestamp`; publication
and cached queries do not establish a new sensor observation. Open means not
closed, rather than a measured full-open position. `status_update` on the read-only
query topic requests a current cached snapshot without operating a door.

The cover handler accepts `open` and `closed`. Stop is dispatched only when the
HA source actually advertises Stop support. The MSG200's usual Open/Close cover
has no Stop capability; no toggle pulse is used to emulate one. A snapshot after
a request supplies source state, not command completion evidence.

## MQTT Device Creator

Keep the existing child devices and configure each shade as follows:

| Preference | Door 1 | Door 2 |
| --- | --- | --- |
| Subscribe topic | `stmq/garage/door1/status/contact` | `stmq/garage/door2/status/contact` |
| Message format / JSON key | JSON / `value` | JSON / `value` |
| Open / Close values | `open` / `closed` | `open` / `closed` |
| Publish topic | `stmq/garage/door1/command/cover` | `stmq/garage/door2/command/cover` |
| Publish changes / QoS | Enabled / 1 | Enabled / 1 |

Some Creator versions accept only a broker IP and use port 1883. With a movable
broker endpoint and HA's fixed broker on another port, install
`meross-ha-bridge.conf.example` privately in the Ubuntu Mosquitto configuration.
Use the actual fixed HA address and add private `local_username`, `local_password`,
`remote_username` and `remote_password` entries. Preserve existing broker users.

The bridge forwards only the listed HA-owned door commands and queries to HA,
and returns its contact and availability topics. Native appliance and application
reply topics remain local. Command routes use QoS 0 and clean sessions on both
ends to drop disconnected requests. An in-flight outcome can still be uncertain;
check current door state before issuing another request. State snapshots retain
their original payload timestamps. The bridge runs in the existing broker.

SmartThings shade state can change optimistically on button press. A successful
API request or virtual state change is not proof of motion. Qualification includes
the outgoing MQTT request, HA's source feedback and physical observation. Test both
doors with HA and with the virtual IP on each broker.

## Replacement and rollback

Back up HA configuration entries, entity mappings, automations and broker settings.
Validate local state and each attended movement path before removing the previous
integration or broker. Preserve original entity IDs when transferring ownership.
Remove unused integration entries and software through HA, HACS and Supervisor;
retain the rollback archive privately outside active HA configuration.
