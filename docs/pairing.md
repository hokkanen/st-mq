# Pair mode: master and read-only slave

Pair mode supports manual role changes and protected history recovery. Unlike
a [read-only mirror](replication.md), its slave is prepared to take control.
The master records measurements, learns and controls the home. The slave
displays verified database snapshots. Losing the slave or the connection to it
does not stop the master, and the slave never promotes itself after a timeout.

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
the DHCP allocation range. Devices and other MQTT clients use the virtual IP.
ST-MQ itself connects to the broker on its own computer, through loopback, a
local interface address or the Home Assistant `core-mosquitto` add-on. ST-MQ
rejects a remote broker or its own virtual IP as the controller's broker.

Configure equivalent MQTT users, permissions and required listeners on both
brokers. Moving the address causes clients to reconnect; it does not move
existing TCP connections, retained messages, broker sessions or queued MQTT
messages. Fresh measurements must be reacquired after takeover. ST-MQ's database
copy is separate from the broker's data and cannot provide a lossless MQTT
handover.

The peer connection always uses the other machine's fixed address, never the
virtual IP. Permit the configured peer TCP port between the two computers;
the default is 1244. The connection uses HTTP; peer messages and snapshot chunks
use authenticated encryption with the shared pairing token. This token is
distinct from the web access token and MQTT credentials. Neither the token nor household contents
belong in Git or diagnostic output.

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

On the second machine, also select `controller.topology: "pair"`. Swap
`peer_url` and `listen_host` to its own and the other machine's fixed addresses,
and use the same pair ID, private token and virtual IP. Interface names and
storage paths are machine-local and may differ. The add-on's local broker address
may be
`mqtt://core-mosquitto`.
Set `vip_socket` to an empty string in the add-on; it uses its bundled helper
directly. Standalone Linux defaults to the restricted local helper socket.

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
| `pair.vip_socket` | `STMQ_PAIR_VIP_SOCKET` | `/run/st-mq-vip/socket` on standalone Linux; empty in the add-on |

Restart after changing pair configuration. The pair state directory must be
separate from the database directory and `pair.snapshot_directory`. Pair mode
does not borrow storage or freshness settings from `mirror`. The state directory
keeps its existing `pairing` name so a configuration rename cannot bypass saved
authority. Incompatible saved state is rejected before mutation with deliberate
fresh-start guidance; it is never silently skipped or reset. Pair authority state
uses version 3 and the encrypted peer protocol uses version 2 (`/v2/pair`). Both
computers must run this contract; earlier formats are not translated.

## MQTT address management

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

The Home Assistant add-on uses host networking and `NET_ADMIN`/`NET_RAW` for
this feature. Its broker still runs on the same Home Assistant host, and the
bundled address helper runs directly inside the add-on.
On paired add-on startup, ST-MQ creates the root-owned policy from the validated
local virtual-IP settings.

Do not run an independent automatic VIP failover configuration alongside
ST-MQ's manual role management. The slave must not acquire the address merely
because the master is unreachable.

## Daily operation and outages

The paired-computers panel reports local role, peer reachability, broker
address ownership, snapshot age, verification and operation progress. It is
hidden unless `controller.topology` is `pair`. A regular slave continues serving
its last verified snapshot while the master or network is unavailable.

The master retries synchronization after a slave outage. Transfers are based
on consistent snapshots, with integrity and content-identity verification
before publication. An incomplete transfer cannot replace the last verified
snapshot. A long outage does not depend on retaining an unbounded MQTT event
queue. Disk space must cover the working snapshot, current/previous published
generations and a temporary recovery donor; leave room for SQLite's own
journals and concurrent master writes.

Transfers reuse matching 1 MiB chunks and retain interrupted progress. Each
received database passes SQLite integrity and SHA-256 page-content verification
before it becomes visible. The current protocol accepts databases up to 64 GiB;
an oversized or failed transfer leaves the last verified snapshot available.

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
permission from copied observations. See [charging outages](charging.md#missing-vehicle-feeds-and-takeover)
and [garage protection](garage.md#sensors-doors-and-protection).

Home heating restoration still requires a reachable H66 gateway and broker.
H66 has no documented device-side expiry for ST-MQ's temporary setting writes;
persisted obligations are retried after reconnection. Do not mistake a promoted
master or mirrored database for confirmation that an unreachable pump restored
its native settings. Directly connected devices can recover independently of HA.

## Graceful handover

When both computers are available and the slave is ready, use **Hand over to
the other computer** on the master and confirm the operation. The old master
finishes its control work while it still owns authority, prepares the final
verified history and releases its role/address. The new master then starts
its local controller and owns the MQTT address. Clients reconnect to that
broker, and fresh input becomes available according to their normal publishing
schedule.

The dashboard may briefly reconnect while its runtime changes. An accepted
request is not yet a completed handover: wait for the confirmed role. If the
response is lost, **Recheck the same request** uses its original identifier;
it does not create another promotion or handover. A browser reload retains
that pending identifier. It never retries a promotion automatically.

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
[Easee setup](charging-easee.md) for commissioning and endpoint requirements.

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
not reconfigure the charger through Easee cloud. An ordinary application stop
instead attempts to release its profiles and apply `OcppOff` before closing
its connections. A crash or power loss cannot perform that cloud handback.
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
| MQTT name cannot be resolved | Check the local broker hostname; `core-mosquitto` is the Home Assistant add-on alias. |

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

All dashboard database edits, settings changes, configuration application and
device commands are disabled, with the same restriction enforced by the API.
Downloading a verified database copy remains available; saving a new database
file on the server requires the active master. Explicit pairing actions retain
their own confirmation and authority checks. Internal snapshot publication and
pair-state persistence remain necessary and do not grant dashboard editing rights.

The header shows **Pair · Master** or **Pair · Slave** alongside the control
mode: owning the master role does not mean automatic control is enabled.
Protected recovery and transitions are shown separately from normal roles.
Open **Paired computers**, just above **Event log**, for connection and snapshot details,
recovery controls, handover or manual promotion. The section stays compact when
closed and still shows important progress or attention messages. Slaves use
the same layout, with recovery and handover performed from the master's UI.

Recovery is initiated on the master:

1. **Check other computer for missing data** takes a consistent donor snapshot
   and shows counts and periods for missing, conflicting, already present and
   skipped entries. Checking does not change the master's history.
2. Review the preview, then **Recover gaps and rebuild model**. The request
   identifies the checked donor snapshot. Existing master history wins
   overlaps. The importer accepts supported gaps with their provenance;
   it does not combine arbitrary SQLite rows or overwrite the master's
   existing journal, forecasts or control records.
3. Wait for the recovery result and model reconstruction. Recovery selects a
   documented learning epoch and uses the established ordered replay contract.
   The existing model keeps control available while the replacement catches
   up; a partial or stale rebuilt model is not published.
4. After successful recovery, explicitly **Resume mirroring**. A verified
   master snapshot makes the other database match the master, and normal
   one-way synchronization resumes.

The checked snapshot includes durable energy still in an open recorder interval.
Recovery can retain this as immutable measured history without copying the other
computer's accumulator or control state. Existing master intervals, including
its open energy, win overlaps. Phase cohorts are accepted atomically, and repeated
recovery does not add their energy again. If resumed live integration straddles a
recovered interval, that local interval is skipped without prorating; any
uncovered remainder stays unknown and later readings resume normally.

Recovery is optional after a successful check. To keep the master's history
and model as they are, choose **Skip recovery and resume mirroring** after reviewing the preview
and confirm that the other computer's unrecovered history may be discarded.
This does not import gaps or rebuild the model. The other database is replaced
with a verified master snapshot, including removal of entries absent from the
master. The result says that mirroring resumed without recovery; missing entries
shown in the preview were not recovered. A pending or failed check cannot enable
this option, and a changed donor or an outdated preview requires a new check.

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
into the master. They are not retained forever in a separate rejection
archive. Temporary donor copies can be removed after the accepted result and
verified rejoin. If those rejected records need to be kept for another
purpose, export them before completing recovery/rejoin. A failed or
interrupted recovery keeps protection in place for another explicit check.

After successful rejoin, dedicated former-master database copies in the pairing
directory are removed. The initially configured application database is an
external, user-owned path and stays on disk, inactive. It is never reopened or
promoted automatically; future promotion uses the latest verified publication.

## Two masters reconnecting

Simultaneous active claims are resolved automatically when the computers can
communicate. A Home Assistant installation wins over an Ubuntu installation;
with the same platform, the stable node IDs provide a deterministic winner.
This rule applies to competing active masters, not to an ordinary returning
slave or a successful intentional handover.

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
