# Pair mode: master and read-only slave

Pair mode supports manual role changes and protected history recovery. Unlike
a [read-only mirror](replication.md), its slave is prepared to take control.
The master records measurements, learns and controls the home. The slave
displays verified database snapshots. Losing the slave or the connection to it
does not stop the master, and the slave never promotes itself after a timeout.

Mirroring verifies a copied database snapshot; recovery determines whether another
computer has history absent from the master. An observation recording an
unavailable measurement is still a stored record. Its missing-value quality must
never make an identical record appear absent or cause recovery to copy it again.

Both computers select `controller.topology: "pair"`. The other topology choices
are `standalone` for independent operation and `mirror` for one-way SSH
synchronization. The `pair` section owns peer synchronization, snapshot storage
and freshness settings; pair mode never reads the `mirror` section. Neither
section has an `enabled` flag.

## Before enabling pairing

Run the same ST-MQ release on both machines. Both need their own working local
MQTT broker, provider configuration and any device verification required for
normal control. The mirrored database does not copy credentials, machine role,
node identity or network configuration. A slave therefore needs its future
controller configuration provisioned locally before it can take over.

Use two fixed management addresses and reserve a third, unused IPv4 address as
the broker's virtual IP on their common LAN/subnet. Keep that address outside
the DHCP allocation range. Independent MQTT devices use the virtual IP; apps
and publishers that require HA keep using its fixed broker endpoint. ST-MQ's
primary connection uses the broker on its own computer, through loopback, a
local interface address or the Home Assistant `core-mosquitto` app. ST-MQ
rejects a remote primary broker or its own virtual IP as primary. Ubuntu can
also configure `mqtt.ha` for TeslaMate, BMW CarData, garage doors and the Tuya
dehumidifier bridge. See [MQTT routing](configuration.md#primary-mqtt-and-ha-hosted-integrations).

Configure equivalent MQTT users, permissions and required listeners on both
brokers. The master owns a TCP frontend at `VIP:1883` and closes its accepted
connections before releasing the VIP, forcing those clients to reconnect.
Fixed HA connections remain open. This does not transfer retained messages,
broker sessions or queued MQTT messages. Fresh measurements must be reacquired after takeover. ST-MQ's database
copy is separate from the broker's data and cannot provide a lossless MQTT
handover.

The peer connection always uses the other machine's fixed address, never the
virtual IP. Permit the configured peer TCP port between the two computers;
the default is 1244. The connection uses HTTP; peer messages and snapshot chunks
use authenticated encryption with the shared pairing token. This token is
distinct from the web access token and MQTT credentials. Neither the token nor household contents
belong in Git or diagnostic output.

### Updating a locally built Home Assistant app

A local rebuild can leave Supervisor validating options against cached app
metadata. If it still requires retired fields, keep the app stopped and preserve
its private options before refreshing the metadata. Supervisor 2026.09.3 supports
this procedure through its v1 API:

1. Read `GET /store/repositories` and retain the exact set of `source` values,
   including built-in repositories. Record the checkout's current commit.
2. Send `POST /supervisor/options` with only `addons_repositories` set to that
   unchanged list. Verify that the repository set and checkout commit remain
   unchanged. This rereads local manifests without fetching or resetting Git.
3. Run `POST /addons/<app-slug>/rebuild` again, then inspect the changed field
   descriptors in `GET /addons/<app-slug>/info`. Apply the current options only
   after the installed schema has refreshed, before starting the app.

The installed `schema` is a descriptor array, not the manifest's raw mapping;
`GET /store/addons/<app-slug>` does not expose it. The repository-list option is
deprecated but supported in that Supervisor release; if unavailable, stop and
check the installed API. Do not substitute `/addons/reload` or `/store/reload`:
their Git update can reset an unpublished checkout to the remote branch. See
Supervisor's [options handler](https://github.com/home-assistant/supervisor/blob/2026.09.3/supervisor/api/supervisor.py#L157-L174),
[manifest refresh](https://github.com/home-assistant/supervisor/blob/2026.09.3/supervisor/store/__init__.py#L261-L308)
and [Git update](https://github.com/home-assistant/supervisor/blob/2026.09.3/supervisor/store/git.py#L241-L278).

## Configuration

Store settings in each installation's private configuration. These invented
addresses and interface name are examples and must be replaced:

```json
{
  "controller": {
    "topology": "pair",
    "input": "mqtt"
  },
  "mqtt": {
    "address": "mqtt://127.0.0.1"
  },
  "pair": {
    "pair_id": "example-home-pair",
    "token": "replace-example-pairing-token-with-a-new-private-random-value",
    "peer_url": "http://192.0.2.20:1244",
    "listen_host": "192.0.2.10",
    "port": 1244,
    "directory": "/var/lib/st-mq/pairing",
    "snapshot_directory": "/var/lib/st-mq/pair-snapshots",
    "stale_seconds": 180,
    "interval_seconds": 60,
    "timeout_seconds": 3600,
    "vip_interface": "eth0",
    "vip_address": "192.0.2.30",
    "vip_prefix": 24,
    "vip_helper": "/usr/local/bin/st-mq-vip",
    "vip_socket": "/run/st-mq-vip/socket"
  }
}
```

The example selects live `controller.input: "mqtt"`. Adapt this to `providers`
if that is the installation's live input, and keep the intended control mode in
each machine's private configuration. The default simulated input cannot be
used for pair mode. Pairing controls whether
that runtime may start; copied active settings cannot activate a slave.

On the second machine, also select `controller.topology: "pair"`. Point
`peer_url` back to the first machine; `listen_host` belongs to the computer
being configured. Use the same pair ID, private token and virtual IP.
Interface names and storage paths are machine-local and may differ. A listener
using `0.0.0.0` can keep that value on both computers. When copying Ubuntu configuration to
HA, use the [HA field checklist](configuration.md#copying-ubuntu-configuration-to-ha-for-pair-mode)
before importing. It covers the local Mosquitto connection, clearing Ubuntu's
separate `mqtt.ha` route and helper socket, peer/listener addresses, the actual
HA interface and preserving HA's existing storage. Normal imports merge:
omitting a field does not clear its saved value. The same guidance appears in
HA's Configuration form and ST-MQ's Configuration disclosure.

Generate a fresh random pairing token of at least 32 characters with a password
manager or a script that writes directly to the private configuration. Do not
use the example token. Private directories use mode `0700` and private files
use `0600`.

Pair mode has no configured role. Fresh installations without existing local
history start as read-only slaves. After completing setup on both, use **Promote this
computer to master** on exactly one computer to establish the first master. Confirm
that no other computer is controlling the equipment; the other computer stays
a slave and receives verified snapshots. Opening the dashboard or restarting
never automatically promotes either computer. Existing local history starts in
**Protected recovery** so ordinary synchronization cannot overwrite it. Review
that history and use the explicit promotion or recovery actions.

Saved pair state owns the runtime role, relinquishment and protected recovery.
Handover and promotion update that state, never the configuration file. A restart
does not undo a handover or clear protection. Do not copy or delete the pair state
directory to force a role change; use the explicit management actions.

| Private setting | Environment override | Default |
| --- | --- | --- |
| `controller.topology` | `STMQ_TOPOLOGY` | `standalone`; choose `pair` on both computers |
| `pair.pair_id` | `STMQ_PAIR_ID` | Required in pair mode |
| `pair.token` | `STMQ_PAIR_TOKEN` | Required in pair mode |
| `pair.peer_url` | `STMQ_PAIR_PEER_URL` | Required fixed peer origin |
| `pair.listen_host` | `STMQ_PAIR_HOST` | `0.0.0.0` |
| `pair.port` | `STMQ_PAIR_PORT` | `1244` |
| `pair.directory` | `STMQ_PAIR_DIR` | `<data directory>/pairing` |
| `pair.snapshot_directory` | `STMQ_PAIR_SNAPSHOT_DIR` | `<database directory>/pair-snapshots` |
| `pair.stale_seconds` | `STMQ_PAIR_STALE_SECONDS` | `180`; adjust for longer sync intervals |
| `pair.interval_seconds` | `STMQ_PAIR_INTERVAL_SECONDS` | `60` |
| `pair.timeout_seconds` | `STMQ_PAIR_TIMEOUT_SECONDS` | `3600` |
| `pair.vip_interface` | `STMQ_PAIR_VIP_INTERFACE` | Required |
| `pair.vip_address` | `STMQ_PAIR_VIP_ADDRESS` | Required IPv4 address |
| `pair.vip_prefix` | `STMQ_PAIR_VIP_PREFIX` | `24` |
| `pair.vip_helper` | `STMQ_PAIR_VIP_HELPER` | `/usr/local/bin/st-mq-vip` |
| `pair.vip_socket` | `STMQ_PAIR_VIP_SOCKET` | `/run/st-mq-vip/socket` on standalone Linux; empty in the app |

Restart after changing pair configuration. The pair state directory must be
separate from the database directory and `pair.snapshot_directory`. Pair mode
does not borrow storage or freshness settings from `mirror`. The state directory
keeps its existing `pairing` name so a configuration rename cannot bypass saved
authority. Incompatible saved state is rejected before mutation with deliberate
fresh-start guidance; it is never silently skipped or reset. Pair authority state
uses version 3 and the encrypted peer protocol uses version 2 (`/v2/pair`). Both
computers must run this contract; earlier formats are not translated.

<a id="fresh-development-databases"></a>

## Deliberate fresh start after a development schema change

The paired dashboard's **Reset pairing → Start fresh** is the preferred way
to start over. It archives the database and pairing storage together, including
promoted databases hidden in private app storage. No manual path changes are
needed. See [Reset pairing](#reset-pairing) for the two choices, restoration
requirements and archive locations. The manual procedure below remains useful
when the dashboard cannot start because of invalid configuration or unavailable
storage.

Use this procedure when both computers have incompatible development databases
and you have chosen to start new history. It preserves the old files; it does
not migrate or import them. If a same-version, current-schema master or backup
already has the history you want, preserve that source instead of resetting it.
Normal protected-history recovery also requires the current schema.

1. Stop both applications, including any service restart/watchdog mechanism, and
   install the same current build on both. Keep a backup of the old database,
   its SQLite sidecars (`-wal`, `-shm`, `-journal` when present), pair state and
   snapshots. A Home Assistant app backup must include its private app data.
   Keep backups private. Resolve outstanding temporary equipment changes and
   restoration duties before replacing the old runtime: a fresh database cannot
   carry its saved pump restoration, charging ownership or commissioning state.
   Stopping software or changing
   storage does not confirm that equipment restored its native settings.
2. Select unused database, pair-state and pair-snapshot locations on **both**
   computers as described below. Keep the existing peer addresses, shared token,
   pair ID, virtual-IP settings and integration configuration. Do not edit saved
   `state.json` or copy an old database into the new directories.
3. Start both applications. With empty selected storage they initially show
   **Pair · Slave**. On Ubuntu only, choose **Promote this computer to master**
   and confirm that no old controller still owns control or the virtual IP.
   Wait for **Pair · Master** on Ubuntu and a verified fresh snapshot on Home
   Assistant. Do not promote the Home Assistant computer as well.
4. Review device setup, restoration and each feature's control permission before
   resuming automation. New history does not recover the previous learned model,
   dashboard control choices or live device evidence. Keep the new storage
   settings for subsequent starts; returning to the old paths reopens old state.

### Ubuntu storage

Leave `STMQ_DATA_DIR` unchanged so unrelated provider tokens and local files stay
available. Set all three overrides below in the environment that normally starts
the application; changing only `STMQ_DATABASE_DIR` does not redirect a saved
master's `activeDbPath`. A promoted master can store its database inside the pair
directory as `master-<epoch>.sqlite`.

For the example systemd installation, choose unused locations beneath its
writable `/var/lib/st-mq` directory. Add or update these entries in
`/etc/st-mq.env`, which the supplied unit loads:

```sh
STMQ_DATABASE_DIR=/var/lib/st-mq/fresh-1/database
STMQ_PAIR_DIR=/var/lib/st-mq/fresh-1/pairing
STMQ_PAIR_SNAPSHOT_DIR=/var/lib/st-mq/fresh-1/pair-snapshots
```

Keep this environment file private. For a different unit, use its configured
environment source; an `EnvironmentFile` overrides a unit's `Environment`
entries. Reload systemd if changing the unit itself. Use the actual service
name/account, and ensure the selected parent directory is writable by that
account. For a shell-launched checkout, use the equivalent
environment on its usual start command, with an unused location such as
`$PWD/var/fresh-1` instead of `/var/lib/st-mq/fresh-1`. The three variables override
any saved `pair.directory` and `pair.snapshot_directory` configuration. Keep the
old directories intact; choose another suffix if `fresh-1` has already been used.

### Home Assistant app storage

Stop **Settings → Apps → Home Energy** and keep it stopped while changing storage.
The app's `/config` is its own app-configuration directory, exposed to suitable
file editors or SSH environments as `/addon_configs/<actual-app-slug>`. It is
not Home Assistant Core's `/config`. Find the actual installed app slug; do not
substitute the repository name.

Rename the existing `/addon_configs/<actual-app-slug>/st-mq` directory to an
unused sibling such as `st-mq-before-fresh-1`. This preserves the database,
sidecars, snapshots and exports under that directory. Leave the sibling
`secrets.json` file in place. On next start, the app creates a new empty
`/config/st-mq` database directory.

In Home Energy's **Configuration**, change these two fields in the existing
`pair` section while preserving its other settings:

```yaml
pair:
  directory: /data/st-mq/pairing-fresh-1
  snapshot_directory: /config/st-mq/pair-snapshots-fresh-1
```

Choose unused names. The old default `/data/st-mq/pairing` is private to this
app and is normally inaccessible from another SSH app. Leave it intact; the new
`pair.directory` selects fresh authority without deleting it. A previously
promoted master's database may also be inside that old pair directory, which is
why renaming `/config/st-mq` alone is insufficient. Save the configuration, then
continue with step 3 above. If this installation overrides the database path or
uses different storage mounts, preserve and replace those selected paths instead.

## MQTT address management

The controlling runtime owns a TCP frontend bound only to `VIP:1883`. It forwards
the connection to the configured local primary broker without inspecting,
buffering for later delivery or changing MQTT messages. Authentication stays
with the broker. Protocol bytes pass through unchanged; devices must use the
same MQTT transport as the primary endpoint. There is no extra broker process
or bidirectional topic bridge. Both existing brokers keep running.

The broker's own listener must leave `VIP:1883` free. A normal HA/Ubuntu setup is:

| Client | Destination |
| --- | --- |
| Independent equipment | `VIP:1883` |
| HA apps and HA ST-MQ | `core-mosquitto:1883` on HA's internal app network |
| External fixed HA clients and Ubuntu's `mqtt.ha` | HA fixed address, host port `1885` |
| Ubuntu ST-MQ and its frontend upstream | `127.0.0.1:1883` |

Publish HA Mosquitto's container port 1883 as host port 1885, after checking that
the host port is free. Bind Ubuntu Mosquitto's listener to loopback instead of
all host addresses. A wildcard listener or Docker port publication on host 1883
would conflict with the frontend or intercept VIP traffic. The one-time broker
port/binding changes require a planned broker restart and adjustment of any
fixed-address clients that used the old host port. Internal HA clients using
`core-mosquitto:1883` retain that endpoint. Ordinary handovers do not restart
either broker.

Before handover, the receiving computer checks its local broker TCP endpoint
and whether it can bind the prospective frontend port. The probe has no MQTT
credentials or device commands; it proves TCP reachability, not authentication,
device subscriptions or eventual recovery. The master opens its frontend only
after primary MQTT subscriptions are ready. Losing an optional HA connection
does not block independent equipment from reconnecting.

The peers must agree on the current frontend implementation, VIP port and wire
protocol before the old master stops. A missing or different frontend contract
blocks handover. Install the same current implementation on both computers
before the first handover; there is no mixed-version transport bridge.

The frontend bounds concurrent sessions and connection establishment, uses
stream backpressure, and closes both ends when either end fails. Demotion stops
accepting connections and closes all accepted frontend/upstream sockets while
the old master still owns the VIP. Stopping a listening socket alone would leave
existing TCP connections alive. Pair authority, device evidence and restoration
rules still govern every command independently of frontend readiness.

The address helper accepts only acquisition or release of a locally configured
interface/address pair. Its root-owned policy is
`/etc/st-mq-vip/policy.json`, with this structure:

```json
{
  "interface": "eth0",
  "address": "192.0.2.30",
  "prefixLength": 24
}
```

The helper adds/removes only that address and announces ownership with
gratuitous ARP. Its policy must be a regular file owned by root and not writable
by group or other users. Network changes require host networking privileges;
the ordinary unprivileged service cannot acquire an address by itself.

On Ubuntu, install `iproute2` and `iputils-arping`. The restricted helper runs
as a separate systemd service with only the network capabilities it needs.
The `stmq` application user accesses its Unix socket; the main service keeps
`NoNewPrivileges=true` and does not use `sudo` to change addresses.

From the checkout, install the helper's public code and units into root-owned
locations. These commands assume the application's existing `stmq` user/group
and Node at `/usr/bin/node`:

```sh
sudo install -d -m 0755 /usr/local/lib/st-mq/scripts /usr/local/lib/st-mq/src/pairing /usr/local/lib/st-mq/src/replication
sudo install -o root -g root -m 0644 package.json /usr/local/lib/st-mq/package.json
sudo install -o root -g root -m 0644 scripts/pair-vip.js /usr/local/lib/st-mq/scripts/pair-vip.js
sudo install -o root -g root -m 0644 src/pairing/vip.js src/pairing/state.js /usr/local/lib/st-mq/src/pairing/
sudo install -o root -g root -m 0644 src/replication/publication.js /usr/local/lib/st-mq/src/replication/publication.js
sudo install -o root -g root -m 0644 deploy/st-mq-vip.service deploy/st-mq-vip.socket /etc/systemd/system/
```

Create the root-owned policy file shown above with mode `0600`, using the same
interface, address and prefix as this machine's pairing settings. Its separate
private directory, `/etc/st-mq-vip`, must be owned by root with mode `0700`.
It does not change the ownership or permissions of the application's private
configuration directory. Then enable the socket:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now st-mq-vip.socket
```

The service is started on demand. Its socket admits only root and the `stmq`
group, and its policy restricts requests to the configured address. Update the
installed helper code with ST-MQ releases; it must not point to a checkout that
the unprivileged application user can modify.

The Home Assistant app uses host networking and `NET_ADMIN`/`NET_RAW` for
this feature. Its broker still runs on the same Home Assistant host, and the
bundled address helper runs directly inside the app.
On paired app startup, ST-MQ creates the root-owned policy from the validated
local virtual-IP settings.

Do not run an independent automatic VIP failover configuration alongside
ST-MQ's manual role management. The slave must not acquire the address merely
because the master is unreachable.

## Daily operation and outages

The paired-computers panel reports local role, peer reachability, broker
address ownership, snapshot age, verification and operation progress. It is
hidden unless `controller.topology` is `pair`. A regular slave continues serving
its last verified snapshot while the master or network is unavailable.

The compact summary separates peer connectivity from reported snapshot age.
Amber marks unavailable connections, blocked mirroring and decisions requiring
attention; ordinary progress and informational comparisons use quieter colors.
Expanded details group this computer, the other computer and database mirroring.
Losing the dashboard connection replaces current-status claims with unconfirmed
status until a new report arrives. Neither connectivity nor color grants control.
Chart and event-history failures do not invalidate a successful local status
report. A late failed request also cannot overwrite newer pairing evidence.
An intentionally stopped peer affects the other-computer status independently.
An unavailable slave leaves the master's equipment control running; it makes
mirroring unconfirmed, without implying that the slave normally controls equipment.
The warning that an unreachable master may still control equipment belongs to
manual promotion. A reported conflict between two masters is shown separately.

MQTT address ownership and device-listener readiness are checked separately.
An assigned address alone cannot confirm an active listener. Connection counts
describe open transport connections; individual device readiness still requires
fresh reports. Listener errors remain visible even when the virtual IP is assigned.

The master also shows the slave's reported snapshot and verification times,
with the time that report was received. These are observations from the peer,
not proof that it includes writes made after that snapshot. An unreachable peer
has unknown current synchronization status. During transfers or role changes,
the panels show progress rather than claim that both databases are current.

The master retries synchronization after a slave outage. Routine transfer uses
[hash-linked SQLite transaction commits](sqlite-journal.md), starting at the
slave's durable checkpoint. Each received transaction checks its predecessor,
content hash and expected previous row values. Its changes and new checkpoint
commit atomically. Incomplete frames and disconnected transfers never expose a
partial transaction; restart reconciles the durable publication receipt with the
actual database checkpoint. A receiver retains one writable SQLite database,
while read-only viewers pin coherent read transactions.

Only a receiver with no base needs a full initial snapshot. Independent histories
without a common journal ancestor and explicit exceptional repairs can also need
a full snapshot. Those exports retain full integrity and byte-content validation.
Normal synchronization, startup and handover neither copy the complete database
nor hash all its pages. Transport frames are bounded at 256 KiB; source commits
retain their atomic boundary even when they require several frames. Journal
history is retained, so a long outage can resume from the last accepted commit.
Unexpected local writes or a mismatched accepted checkpoint protect the slave
instead of silently overwriting its history.

**Verify with full snapshot** adds the independent full verifier to a manual
operation. Handover and incremental rejoin compare the source and receiver only
at the same transaction checkpoint; a newer master is never compared against an
older slave as if they should already match. **Recording details → Verify
database** runs the same verifier manually. Optional background checks are
configured with `recording.full_verification_interval_hours` (`0` disables them).
These full checks are intentionally proportional to database size and can consume
storage bandwidth. Their results are separate from routine journal continuity.

Synchronization is asynchronous. Forced takeover can therefore start from a
snapshot older than the last master write. A snapshot that was recently
received can also contain older history; the panel shows its source time.

Moving the broker address does not restart applications on the failed computer.
If Home Assistant and TeslaMate ran there, BMW/Tesla vehicle feeds and HA door
publishers remain unavailable. Charging retains manual inputs and, for the same
identified connection, its last known charge estimate plus recorded energy.
Unknown Garage doors block a new target reduction below 2°C outdoors, the same
rule as an open door. Independent fresh pipe and room evidence continues
protection; lost protection inputs require restoration. An existing external
temperature sample or manual timed OFF lease keeps its original local expiry
while the replacement host reacquires fresh state. Promotion cannot renew either
permission from copied observations. See [charging outages](charging/execution-and-recovery.md#missing-feeds-and-controller-outages)
and [garage protection](garage.md#independent-freeze-protection).

Home heating restoration still requires a reachable H66 gateway and broker.
H66 has no documented device-side expiry for ST-MQ's temporary setting writes;
persisted obligations are retried after reconnection. Do not mistake a promoted
master or mirrored database for confirmation that an unreachable pump restored
its native settings. Directly connected devices can recover independently of HA.

## Graceful handover

When both computers are available and the slave is ready, use **Hand over to
the other computer** on the master and confirm the operation. The old master
finishes required restoration and control work while it still owns authority,
closes VIP MQTT and local OCPP connections, transfers the remaining commits
through the final checkpoint and releases its role/address. Both computers reuse
their existing database files during the role change. The new master then starts its local controller,
owns the MQTT address and opens its frontend after primary subscriptions are
ready. Devices reconnect to the new local broker; fixed HA clients retain their
connections. Fresh input becomes available according to each device's normal
publishing schedule. A transferred master role and listening frontend are not
proof that every device has recovered. Check device connection status and fresh
reports separately, including OCPP.

The dashboard may briefly reconnect while its runtime changes. An accepted
request is not yet a completed handover: wait for the confirmed role. If the
response is lost, **Recheck the same request** uses its original identifier;
it does not create another promotion or handover. A browser reload retains
that pending identifier. It never retries a promotion automatically.

### MQTT source identity across computers

The two computers use different broker addresses even when they receive the
same equipment and vehicle reports. Those transport addresses must not reset
saved Home permission, Garage intent, charger instructions, Caravan settings
or consumed vehicle-identification evidence during a handover.

The active current master initializes one `pair:mqtt-source-context` record
from its current primary and HA source identities. An absent separate HA
connection uses primary's identity. This current record travels in verified
snapshots, with a digest of the current effective integration definitions. It
does not scan, translate or rewrite existing equipment state or evidence.
The original source identities remain stable; current transport addresses,
connection health and message freshness remain separate.

Handover preparation compares the current equipment/provider contract and
pins the receiving computer's actual routes to that operation. The final
snapshot must contain the same source context and contract. Only after the
old master confirms control release does activation commit the local binding.
Its private `mqtt-source-context.json` file lives in the pair state directory.
A restart must match that binding; changing broker addresses or users cannot
silently reuse earlier equipment authority. Ordinary equipment configuration
edits still apply their own identity boundaries and update the current
contract for the next transfer.

Different effective equipment definitions, including definitions changed by a
newer build, reject handover with `mqtt_source_contract_mismatch`. Run the same
current build and matching equipment configuration on both computers. This is
distinct from invalid saved source identity or route binding; neither failure
authorizes deleting the binding or bypassing the check. The dashboard keeps the
actionable failure visible in the pairing alert and operation message.

An explicitly confirmed outage promotion may bind its current routes after
validating the accepted snapshot's existing source context and current
integration definitions. A replica cannot invent missing source context from
its own endpoints. A copied database, retained MQTT publication or a binding
record alone never grants command permission or proves a live device identity.
Malformed or contradictory context stays protected instead of being repaired
or reset automatically.

For the initial installation of this implementation, start the already
authoritative HA master with its existing internal broker address before the
first new handover. That preserves its current identity bytes while establishing
the source context. Install the same current implementation on both peers and
align their effective equipment/provider definitions before transferring control.

### Local Easee charger continuity

For ST-MQ's local Easee OCPP connection, both computers must use the same
charger identity, charge-point identity, authorization mode, authorization tags
and stable server URL. With a blank `easee.local_ocpp.server_url`, paired setup uses
`ws://<pairing VIP>:<OCPP port>/ocpp`; use the same OCPP port on both computers.
An explicit server URL must equal that same VIP URL. Paired OCPP currently
requires a direct connection to the VIP; fixed management addresses and
reverse-proxy endpoints are rejected. Bind the listener to `0.0.0.0` or to
the VIP itself on both computers.

With no explicit `easee.local_ocpp.password`, paired setup derives a separate
OCPP credential from the existing shared pairing token and charger identity.
Both computers can obtain the same credential without transferring it in the
database. If an explicit OCPP password is configured, provide the same value
in both private configurations. Do not use an independently generated
standalone credential on each paired computer. The ordinary requirements for
each computer's own Easee cloud credentials still apply. See
[Easee setup](charging/integrations/easee.md) for commissioning and endpoint requirements.

Before stopping the current master, handover checks that the slave can accept
the same endpoint, charger identity, credentials, authorization mode and tags. It
briefly binds and closes the future local OCPP port to catch a conflicting
listener; it does not start an OCPP service or contact the charger. If the
listener is configured to bind the VIP, the check uses the wildcard address
because the slave does not own the VIP yet. A mismatch refuses the handover
while the current master continues operating. Readiness cannot guarantee
future port availability, network routing or charger reconnect timing.
Matching empty authorization-tag lists do not block a general paired handover.
In `plug-and-charge` mode, both computers derive the same private virtual tag
for automatic local authorization; an explicit tag list is optional. In `rfid`
mode, an empty list keeps charger setup blocked until tags are configured.
Check the separate Easee setup and connection status to confirm that a charger
has actually been commissioned.

The current master closes its device connections before creating the final
snapshot. That snapshot includes the OCPP transaction ledger, setup journal
and native charging ownership, preserving transaction IDs, pending profile
commands and commissioning state. A paused transaction retains its finite
profile expiry even while the computers transfer control. The slave validates the
final setup state before activation. Only the authoritative master owns the
live listener and provisions the charger. The moved VIP gives the charger the
same endpoint and credentials, so a role handover keeps OCPP active and does
not reconfigure the charger through Easee cloud. Ordinary application stops and
restarts also preserve native OCPP configuration and outstanding profile
obligations; they close the connection without applying `OcppOff`. Returning to
cloud control requires an explicit integration change.
Existing finite pauses can expire autonomously, but a new plug-in may wait for
OCPP authorization and the Easee app cannot be assumed to bypass that wait.
The promoted computer must restore the local listener and fresh authorization
for new transactions. The new connection also needs fresh telemetry; an open
socket or recent electrical readings are not transferred.

If validation fails after the original master has stopped, neither computer
automatically resumes control. The original history remains protected; review
the reported readiness problem and current roles before explicitly promoting
a computer. Forced promotion still uses the last verified snapshot, so it can
lose transactions written after that snapshot, just as it can lose other
recent history.

## Force promotion

After the pair has an established master, use **Promote this computer to master**
on a slave or protected computer only after the old master has actually failed,
been stopped, or been isolated from the equipment. Confirm the operation in the UI. Being unreachable is not
proof that the old master stopped controlling the home. Promotion uses the
available local history and does not automatically fetch or merge missing
history from another master.

A killed ST-MQ process can leave the virtual IP on a host that is still running.
Before force promotion in that situation, release the old host's virtual IP
or isolate that host from the LAN. Stopping just the controller does not prove
the broker address was removed. Address management has no automatic lease or
timeout takeover; the confirmation trusts your assessment of the old host.

There is no automatic timeout promotion. There is also no external power or
network fencing device in this feature. If two live computers are separated
by a network partition, they cannot negotiate authority until communication
returns. Manual promotion cannot eliminate that interval of possible
simultaneous control.

## Software upgrades

Use the existing handover; an upgrade does not introduce another authority path.
Keep the installed runtime separate from development checkouts. Replacing source
files under a running process can give newly created workers a different database
or learning contract from the process that started them.

For a release pair that explicitly supports a rolling upgrade:

1. Preserve a verified database backup and the separate private configuration and
   pairing state. Read the target release's upgrade requirements first.
2. Upgrade the slave and start it without changing its saved role. Confirm that it
   can synchronize and use the master's history; a connected peer alone is not
   proof of compatibility or handover readiness.
3. Use ordinary **Hand over to the other computer** and wait for completion: the receiving computer
   is master and the former master is slave. Do not stop a computer merely because
   the request was accepted. Interrupted or uncertain handovers remain protected.
4. Upgrade the former master. Its saved slave role and history ancestry survive;
   it returns as a slave and catches up without manual history recovery. Confirm
   synchronization before considering the upgrade complete.

The current pre-v1.0.0 runtime rejects incompatible development databases and
learning journals. This sequence does not promise mixed-version operation today;
follow each release's requirements, including a deliberate stopped upgrade or
archived fresh development start when required. An incompatible format is not
evidence of corruption or divergent history. Preserve originals and resolve the
reported compatibility problem; repeated checks cannot translate old formats.

Beginning with the v1.0.0 production baseline, [F9](../AGENTS.md#f9) requires each
later production release to provide and test its specific upgrade from the
preceding production release's database and persisted state. Older production
backups retain a documented path through intermediate releases. This is a release
obligation, not a universal old-database reader or speculative migration framework.
Any unsupported rolling transition must be explained before the master stops.
Restoration duties, recorded history and roles are part of the upgrade contract;
copying a database alone does not transfer command permission.

## Reset pairing

The admin-only **Reset pairing** action changes only this computer. It keeps
configuration, peer addresses, shared credentials, provider tokens and the other
computer's data unchanged. A confirmation is required; a changed pairing role
or history invalidates an open confirmation.

| Choice | History | Result |
| --- | --- | --- |
| **Keep local history** | Archives previous pairing files and retains a separate active copy of the selected local database, including its saved learning and control records. | A new pairing identity in **Protected recovery** when history exists. Explicit promotion or protected recovery is required; ordinary mirroring cannot overwrite the retained history. |
| **Start fresh** | Archives local databases, SQLite sidecars, pairing files and snapshots. Nothing in those archives is automatically deleted. | A new pairing identity as an empty, read-only slave. It may receive a verified snapshot from an existing master; otherwise explicitly promote exactly one computer. |

Neither choice promotes the computer. Both forget the previous pairing authority,
accepted-snapshot lineage, saved errors and unfinished pairing operations. Keep
local history does not migrate or repair an incompatible database: its schema
error remains until a deliberate fresh start. No reset automatically imports
archived history. [History recovery](#protected-history-and-manual-recovery)
remains a separate, explicit operation for supported current-format history.

The action stops the local runtime and synchronization, attempts ordinary graceful
restoration when this computer has control, and releases its virtual IP before
moving files. Starting fresh requires confirmation that temporary equipment
changes have been resolved. Known saved restoration obligations on a former
controller block a fresh start even after confirmation; retain the database or
resolve those duties first. An incompatible or unreadable database is never
decoded to infer equipment state. Its physical state must be checked separately;
archiving records does not restore equipment. A slave's recorded copy does not
transfer its master's physical obligations to the slave.

Archives use private permissions and are named by time and operation ID:

- Home Assistant: `/config/reset-archives/<archive>/` inside the app, normally
  accessible as `/addon_configs/<actual-app-slug>/reset-archives/<archive>/`.
- Ubuntu: `<dataDir>/reset-archives/<archive>/`.

The result displays the specific archive path for 24 hours. Archives include the
original `state.json`, the configured database when present, the actual promoted
or published database, and their SQLite companion files. Configuration and
unrelated files in the data directory are excluded. Each identifiable supported
database also produces a verified self-contained `.sqlite` file in the archive's
`backups` directory, using the same snapshot generator as dashboard and CLI exports.
These files include committed WAL content and require no companion files. Distinct
databases get separately identified backups; reset never merges their histories.
The current archive manifest records each portable backup and its checksum only
after verified publication. These backups are available from **Recording details
→ Recover history → Open recovery**, including when the computer later runs standalone. The
reset result reports how many usable backups were made and any unavailable
history; it does not claim that preserved raw files are portable backups.

Corrupt or incompatible source databases remain byte-for-byte in the original
archive. They are neither converted nor repaired; the reset result reports that
a recovery backup is unavailable and why. No identifiable database likewise
reports unavailable history. This does not prevent a deliberate fresh reset.
Storage or publication failures leave reset protected and incomplete for explicit
retry instead of claiming a completed backup. Keep mode uses a separate
copy of the selected database; the archived copy stays inactive. On the same
filesystem, files are renamed; between filesystems, each copy is verified and
flushed before the original filesystem entry is removed. Permanent deletion of
archives is manual. Ensure enough free space for the raw archive, portable backups,
temporary verification copies and any retained active copy.

An interrupted archive remains protected across restart. The dashboard offers
retry of the same choice using the same archive; it never resumes control or
finishes a reset automatically. Unreadable pairing state can open a protected
management page without interpreting or rewriting the rejected state. In that
case **Keep local history** is unavailable because the active history cannot be
identified reliably; **Start fresh** archives the configured storage intact.
Invalid configuration, unsafe paths or storage permissions can still require
repair outside the dashboard. Configured directory aliases, such as a checkout's
`var` symbolic link to persistent storage, are resolved to their physical locations.
Overlapping physical pairing/snapshot/archive paths, links within their contents,
and a link at the derived `reset-archives` directory are refused. The archive
records its physical source locations; retargeting a configured directory link
blocks a pending reset until its original location is restored.

After resetting only one computer, the other may protect its previous lineage.
Review its retained history before recovery or its own explicit reset. Resetting
both computers fresh requires selecting a master again. Existing manual recovery
and rejoin behavior is unchanged; reset archives are never used as disposable
snapshot files or removed by replica retention.

## Protected history and manual recovery

Every prospective slave passes a history/lineage check before ordinary
mirroring. Local writes or an unrecognized/divergent history put it in
**Protected recovery**. Mirroring must not erase that history merely because
the other computer is the master. A protected computer remains available for
history inspection and recovery but cannot control equipment. Protection
survives a restart and is not cleared by a timer.

An activation failure also leaves a protected management page available. Fix
the local broker or virtual-IP setup, then explicitly retry promotion. An
unreadable donor remains protected and reports an error; its damaged file is
not replaced merely because a comparison could not finish.

The slave does not need to be online for the master to start or continue running.
An initial startup failure is a local setup problem, not a request to discard or
recover history. The panel keeps its setup diagnosis through restart. Restarting
does not clear protection or promote the computer automatically.

| Reported problem | Next step |
| --- | --- |
| Address helper unavailable | Install the helper for this release and enable `st-mq-vip.socket` on standalone Linux. |
| Address helper permission denied | Give the application user access to the helper socket's configured group, then start a fresh login/session. |
| Address policy invalid | Check `/etc/st-mq-vip/policy.json`, root ownership and permissions using the setup instructions above. |
| Address policy mismatch | Match its interface, address and prefix to this computer's pairing settings. |
| Network interface missing | Use the actual LAN interface on this computer; the other computer can use a different interface name. |
| Address assignment or announcement failed | Check the helper's network capabilities and the installed `iproute2` / `iputils-arping` tools. |
| Address release failed | Keep this computer protected. Check the helper and address ownership before promoting either computer. |
| MQTT broker must be local | Point this controller at its local broker, such as `mqtt://127.0.0.1`, with credentials in the separate MQTT fields. Devices use the virtual IP. |
| MQTT name cannot be resolved | Check the local broker hostname; `core-mosquitto` is the Home Assistant app alias. |
| Device MQTT listener unavailable | Free host port 1883 for the VIP frontend. Bind the Linux broker to loopback and publish HA's broker on a separate fixed host port. |
| Local MQTT broker unavailable | Restore the configured local broker's TCP listener before retrying. This readiness probe does not verify credentials. |
| MQTT handover not ready | Run the same current frontend implementation on both peers and match the VIP port and wire protocol. |
| MQTT source context invalid | Match the current integration definitions and preserve the pair's source context and local route binding. Route changes require an explicitly verified handover or promotion; do not delete binding files to bypass the check. |

Fix saved configuration outside the dashboard, restart when configuration changed,
then explicitly retry promotion after confirming that no other controller owns
control or the virtual IP. Do not delete pairing state or overwrite a database
to clear protection. A failed address release also keeps the protected management
page available; the page does not grant device control.

Slave and protected dashboards keep the same cards, history, recorded settings
and available device evidence visible. Snapshot time and provenance distinguish
recorded values from live state. Missing live readings remain unavailable;
viewing the page never connects to devices or starts the controller. Local
configuration defaults and equipment mappings are identified separately from
values saved by the source computer.

Electricity, prices, vehicle telemetry and temperature/weather summaries use
recorded-snapshot status on read-only computers. Individual readings retain
their original source times; missing saved readings are identified explicitly,
including instantaneous electrical readings that are intentionally live-only.
Snapshot publication time never becomes a device measurement time. The Garage
sender and circulation card follow the same rule: saved evidence remains
inspectable, without implying a live device connection or protection readiness.

All dashboard database edits, settings changes, configuration application and
device commands are disabled, with the same restriction enforced by the API.
Downloading a verified database copy remains available; saving a new database
file on the server requires the active master. Explicit pairing actions retain
their own confirmation and authority checks. Internal snapshot publication and
pair-state persistence remain necessary and do not grant dashboard editing rights.

The header identifies this computer as **Pair · Master** or **Pair · Slave**.
Owning the master role does not enable automatic equipment control by itself.
Protected recovery and transitions are shown separately from normal roles.
Open **Paired computers**, just above **Event log**, for connection and snapshot details,
recovery controls, handover or manual promotion. **Review history** opens the
same [Recover history window](recording.md#recover-history-from-a-backup-or-paired-computer)
as the **Recover history** fold in **Recording details**, with the peer preselected
in the **Recover history** view. It uses the same aligned action layout as
handover and reset; protected history receives attention emphasis. The section
stays compact when closed and still shows important progress or attention messages. Slaves use
the same layout, with recovery and handover performed from the master's UI.

Checks are initiated on the master. When the other computer is a normal slave,
the result is an informational **No recovery needed** result with a checkmark.
It validates that slave snapshot, not whether every current master record has
already been mirrored. Current synchronization and compatibility problems remain
visible separately and take precedence over an earlier successful source check.
For a shared journal, the check examines only changes since the common
checkpoint and their referenced evidence. Its counts and ranges describe that
changed scope, not a full historical inventory. No trial import or model rebuild
runs during a source check. Normal mirroring remains enabled, so recovery and resume-mirroring actions
are unavailable. A record
present only in that older snapshot can reflect a deliberate master deletion;
the next ordinary snapshot applies the deletion. The source check does not
authorize resurrecting it. A healthy mirror containing the same records must
not cause recovery to duplicate those records merely because their measurements are
unavailable, stale or invalid.

Availability notifications appear separately in collapsed diagnostics, grouped
only when source, exact evidence times, status and reason match. A point event
shows one timestamp and **duration unknown**; a positive report span shows first
and last evidence, not a confirmed recovery time. These are not computer outages.
Energy gaps, diagnostic periods and point groups each have an independent display
limit. Totals count evidence records, and expanding a group reveals its signals.
Point notifications do not receive an instantaneous potential-coverage assessment.

During normal mirroring, the window's paired-history workflow offers the optional
source check. Recovery and resume-mirroring steps appear when the peer reports
protected history or a protected-history decision remains unresolved. Backup
sources and previous recoveries use the same window, including outside pair mode.
These presentation choices do not change the server's readiness checks or the
required confirmations.

For a computer in **Protected recovery**:

1. In **Review history**, **Check other computer** identifies the donor checkpoint
   and transfers the bounded journal suffix since the common ancestor. It assesses
   the changed records and their dependencies using the existing recovery rules.
   Independent databases without shared ancestry require a full donor snapshot
   and inventory as an exceptional repair. These are potential coverage, never a
   promise of recoverable entries. Sparse measurements do not establish outages.
   Checking does not copy the master database, run a trial
   import or change the master's history. Missing entries, conflicts and model
   changes remain unknown until recovery.
2. Review the source check, then **Recover history**. The request
   identifies the checked donor snapshot. One merge compares and imports history
   against the current master. Existing master history wins
   overlaps. The importer accepts supported gaps with their provenance;
   it does not combine arbitrary SQLite rows or overwrite the master's
   existing journal, forecasts or control records.
3. Wait for the recovery result and any necessary model reconstruction. The result
   reports missing, conflicting, already present and skipped entries. When accepted
   history affects learning, recovery selects a
   documented learning epoch and uses the established ordered replay contract.
   The existing model keeps control available while the replacement catches
   up; a partial or stale rebuilt model is not published.
4. After successful recovery, explicitly **Resume mirroring**. The other computer
   retains its divergent commits as an inactive branch, reverses only that suffix
   and applies the master's commits. Normal one-way synchronization then resumes.

If you stop after recovery, protection stays active. Waiting, closing the
dashboard or restarting does not resume mirroring. A repeated check of the same
unchanged donor keeps the completed recovery result; it does not turn
**Resume mirroring** into a request to skip recovery.
New donor history requires a fresh review. Handover remains unavailable while
the other computer is protected. Recovery and rejoin recheck the donor's role
and identity before acting, so a preview cannot authorize a different computer
or a newly promoted controller.

Paired recoveries also appear under **Previous recoveries** in the shared window.
The active controller can review and revert a recovery's accepted history, then
restore it later. These source corrections preserve recorded evidence and later
independent work. They do not undo a completed mirroring handover, change either
computer's role or grant equipment control. See
[reversible recovery](recording.md#recover-history-from-a-backup-or-paired-computer).

The recovery result's displayed period spans the earliest and latest imported
entries; it is not necessarily one continuous recording outage. Counts describe stored records,
not the number of measurements that were physically acquired or lost.

The checked snapshot includes durable energy still in an open recorder interval.
Recovery can retain this as immutable measured history without copying the other
computer's accumulator or control state. Existing master intervals, including
its open energy, win overlaps. Phase cohorts are accepted atomically, and repeated
recovery does not add their energy again. If resumed live integration straddles a
recovered interval, that local interval is skipped without prorating; any
uncovered remainder stays unknown and later readings resume normally.

Recovery is optional after a successful protected-history check. To keep the master's history
and model as they are, choose **Skip recovery and resume mirroring** after reviewing the preview
and confirm that the other computer's unrecovered history will not be merged.
The source check does not establish whether any history is missing on the master.
This does not import gaps or rebuild the model. The other database is replaced
with a verified master snapshot, including removal of entries absent from the
master. The result says that mirroring resumed without recovery. A pending or
failed check cannot enable this option, and a changed donor or an outdated preview
requires a new check.
Unknown gap counts never authorize skipping recovery without that explicit discard
confirmation. After a successful recovery, **Resume mirroring** still requires
confirmation before replacing protected history. If a release response is lost,
retry the saved request. A new check cannot replace an unresolved release and
silently abandon its outcome.

Accepted historical entries are imported in bounded transactions and may
become visible before the model rebuild finishes. An interruption can leave
valid partial gap additions while the previous model continues serving
control. A later explicit recovery skips those existing entries and finishes
the work. The selected learning epoch and complete, caught-up checkpoint are
published together. The master's original journal epoch remains available for
reconstructing its original model; recovery does not rewrite it as a new
learning algorithm.

Frozen donor energy accumulators also contain measured history. Recovery saves
each valid open interval as immutable energy observations with the donor snapshot
provenance, preserving its original receipt time, phase values and interval
boundaries. All phases are accepted or rejected together. Existing master energy,
including its current open interval, wins overlaps; totals are never prorated to
fill partial gaps. The donor file and the master's live acquisition cursors,
adaptive thresholds and control state stay unchanged. A retried recovery neither
duplicates accepted energy nor recreates an accepted phase deliberately removed
from the master. Local saved-record statistics include accepted history without
copying donor poll statistics.

Reconstructed epochs reuse existing immutable journal payloads through direct
references. Only newly accepted inputs and compact ordering records add storage;
checking or repeating a recovery with no new learning history does not create
another epoch. Original inputs and completed epoch metadata remain available
for replay. As a scale example, the synthetic missing-week test has 690 unique
inputs and 18 ordering references in a 1.86 MB database including its indexes
and state. Actual storage depends on the retained history and its provenance.

Conflicts and unsupported donor entries are counted, not silently rewritten
into the master. Shared-lineage rejoin retains the divergent journal suffix,
including excluded datasets and before/after row values, inside the same database.
The retained branch is inactive evidence and cannot restore control permissions.
Only changed records consume additional retained storage; rejoin does not create
another full database copy. The branch archive and rollback commit atomically,
while the saved release request makes retries use the originally reviewed donor
and target checkpoints. Lost replies never authorize a different replacement.

Independent donor histories require exceptional full replacement. That path
retains the original former-master database and its SQLite sidecars; a protected
snapshot-only donor retains a pinned self-contained export. These exceptional
copies can each be database-sized and have no automatic expiry. The confirmation
discloses that storage cost. Missing or invalid retained evidence blocks completion.

Promotion always uses the current accepted database and its equipment/restoration
checks. It reuses the existing file rather than cloning historical pages. Retained
branches and exceptional backup files never grant authority. Independent verified
backups remain available for maintenance; a database with WAL sidecars is not a
portable single-file backup.

## Two masters reconnecting

Simultaneous active claims are resolved automatically when the computers can
communicate. A Home Assistant installation wins over an Ubuntu installation;
with the same platform, the stable node IDs provide a deterministic winner.
This rule applies to competing active masters, not to an ordinary returning
slave or a successful intentional handover.

A restarting computer with a saved master role checks a reachable peer before
acquiring the virtual IP or opening equipment connections. If the peer has the
higher-priority master claim, the restarting computer stays protected. If the
restarting computer wins, it waits for the peer to confirm successful control
shutdown and address release. A failed shutdown or a lost confirmation leaves
the restarting computer protected for explicit review. Simultaneous restarts
use the same deterministic rule. This check is bounded to ten seconds.

A saved master can still start when the peer is unavailable and no competing
claim was observed. This preserves operation without the slave; it cannot prove
that an unreachable computer has stopped during a network partition. A reachable
peer's refusal, invalid response or unconfirmed release does not grant startup
permission.

The winner continues with its own database. The loser immediately stops
issuing device commands, withdraws the virtual IP and enters protected
recovery. It does not send ordinary shutdown restoration commands that could
undo the winner's control, and it cannot silently begin mirroring. The master
can then check and explicitly recover missing history using the workflow above.

The preference is an authority rule, not a claim that the winner necessarily
has newer or more complete data. It cannot prevent commands already sent
during a network partition. Database integrity verification and automatic
role reconciliation also do not replace ordinary backups.

## Duplicate controllers outside paired mode

Live standalone installations also announce controller identity through their
MQTT broker. If two ST-MQ controllers using that broker claim the same home,
the same platform/node-ID preference stops the losing controller without
issuing restoration commands. Its dashboard displays **Controller stopped**
and preserves read-only local history. Restarting alone does not clear this
protection; use paired recovery to retain missing history before rejoining.
This guard only detects controllers that can receive each other's identity
announcements. It does not introduce automatic failover or synchronize brokers.
