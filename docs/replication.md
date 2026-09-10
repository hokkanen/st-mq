# Read-only LAN replica

ST-MQ can copy its primary SQLite database to another Linux computer. The second
computer serves recorded history and charts, but cannot record measurements,
change settings, learn, connect to providers, or command equipment. Its role is
machine-local configuration; copied primary settings cannot activate a controller.
This is one-way replication. There is no automatic control takeover or reverse
database recovery.

Both computers should run the same ST-MQ release. The viewer checks the database
schema without migrating it. If a new snapshot cannot be opened, an already
running viewer keeps its previous readable generation and reports the problem.
The separate production 0.7.5 installation and CSV imports are unaffected.

## Set up two standalone Linux computers

Install ST-MQ and build its UI on both computers using the normal installation
instructions. Both need Node.js 22.19 or newer. The primary needs an SSH client;
the replica needs an SSH server and an account that can run Node.js and write its
dedicated replica directory. Neither the replica viewer nor synchronization needs
MQTT or provider credentials.

Install `sqlite3_rsync` on both computers. This is a SQLite tool, distinct from
ordinary `rsync`. To build the pinned official version used by the container and
CI, install a C compiler, curl, tar and unzip, then run:

```sh
node scripts/build-sqlite-rsync.js --output "$HOME/.local/bin/sqlite3_rsync"
```

The builder verifies official source archive checksums before compilation. Make
the binary available on each computer's PATH, including noninteractive SSH
sessions, or configure its absolute path below. The add-on image includes the
tool and SSH client already.

On the replica, choose a **dedicated, initially empty directory** for received
snapshots, such as `/srv/st-mq-replica`, accessible to the receiver and viewer.
Run the receiver and viewer as the same Unix user (or run the viewer as root);
private directory and file permissions intentionally do not grant group access.
Start the viewer with:

```sh
STMQ_ROLE=replica STMQ_REPLICA_DIR=/srv/st-mq-replica npm start
```

Alternatively set `controller.role` to `replica` and `replication.directory` in
that machine's private configuration. Outgoing `replication.enabled` must be
false. Until the first verified snapshot arrives, the UI reports that it is
waiting. Use the existing web-token and binding settings for authenticated LAN
access; no token is needed for the default loopback-only viewer.

On the primary, configure an SSH host alias for the replica, including its user,
identity file and verified host key. The service uses unattended authentication
and strict host-key checking. Keep SSH keys and configuration outside the checkout.
Use a persistent SSH configuration/key location when running in a container.
Set `replication.ssh_config` to its absolute path; this is honored by both SSH
channels. An SSH config can specify `IdentityFile` and `UserKnownHostsFile` paths
inside that persistent directory. For the add-on, `/config/replication-ssh/config`
and its private directory survive container replacement. Provision the key and
known host entry there before enabling replication.

Add a `replication` section to the primary's private settings. This invented
example assumes the replica checkout is `/opt/st-mq` and its host alias is
`stmq-replica`:

```json
{
  "replication": {
    "enabled": true,
    "ssh_host": "stmq-replica",
    "ssh_config": "/etc/st-mq/ssh/config",
    "remote_directory": "/srv/st-mq-replica",
    "receiver_path": "/opt/st-mq/scripts/replica-receiver.js",
    "node_path": "node",
    "rsync_path": "sqlite3_rsync",
    "remote_rsync_path": "sqlite3_rsync",
    "interval_seconds": 60,
    "timeout_seconds": 3600
  }
}
```

`remote_directory` must match the viewer's local directory. The executable
`rsync_path` runs on the primary; `node_path`, `receiver_path` and
`remote_rsync_path` run on the replica. Use absolute paths if those executables
are not available through the noninteractive SSH PATH. Restart ST-MQ after
changing role or replication settings. Existing acquisition and control settings
on the primary remain in effect.

Remote paths and executable names accept letters, numbers, dots, underscores,
slashes and hyphens; spaces and parent-directory traversal are rejected. This
keeps the SSH command interface unambiguous.

The supplied `deploy/st-mq.service` uses `ProtectHome=true`: install the tool in
`/usr/local/bin/sqlite3_rsync` and keep the service's SSH configuration, identity
and known-host file under a private `/etc/st-mq/ssh` directory readable by the
`stmq` user, instead of relying on files under a home directory. Its writable
state directory is `/var/lib/st-mq`; a replica viewer can use
`/var/lib/st-mq/replica`. Put local environment overrides in `/etc/st-mq.env` as
supported by that unit.

## Outages and large catch-ups

The primary attempts synchronization automatically while it runs. Only one
attempt runs at a time. An unreachable receiver, failed transfer or failed
verification is reported without stopping home control. Subsequent attempts
compare against the latest published replica; there is no queue of telemetry
messages or retained change log that can expire during a long outage.
Failed attempts back off to a maximum of five minutes, unless the configured
interval is longer. If the delta tool rejects its destination, the same pinned
source snapshot gets one retry against an empty incoming file; this also handles
database page-size changes. Missing or damaged replica bases are copied afresh.

The receiver keeps serving its last verified snapshot during synchronization.
It receives the next snapshot into a separate incoming file, verifies it, then
atomically publishes its manifest. Readers switch generations without combining
queries from different snapshots. An interrupted transfer cannot become visible
history. Receiver ownership uses an operating-system-backed SQLite lock, released
on process or machine failure; a long transfer does not lose a timed lease.

The transfer timeout defaults to one hour and can be raised to 24 hours for large
databases or slow links. The interval is the delay between attempts; a long
transfer does not start overlapping copies. A replica that loses its database
can be initialized again from the primary. If the primary is offline, the viewer
still serves saved history, marked stale, until synchronization resumes.

Replication uses incremental network transfer, but snapshot preparation and
verification perform local disk work proportional to database size. A background
worker pins a consistent primary read transaction, makes a SQLite backup and
hashes it. This does not block the controller's JavaScript event loop, although
it consumes disk bandwidth and a long read can retain primary WAL pages. Increase
the interval for large databases or slow storage. Prepare enough disk space for
the source snapshot, and on the replica for the current, previous and incoming
snapshots. Filesystem reflinks reduce local copying where available; do not assume
they are available when sizing storage. Allow additional headroom for SQLite's
rollback journal during catch-up and for older files still held open by ongoing
viewer requests. Old published generations and interrupted incoming files are
pruned; the manifest names the current and previous retained snapshots.

There is no zero-loss guarantee: the replica contains only a successfully copied
primary snapshot. A permanently lost primary disk can lose changes newer than
that snapshot, and no computer records provider history while the primary is
stopped. Ordinary retained backups remain useful because replication also copies
intentional deletions and application mistakes.

## What identity verification means

Every successful publication requires a full SQLite `integrity_check`, matching
file length and matching SHA-256 of the standalone source and received database.
The digest includes schema, table, index and free-page contents. It excludes only
SQLite's change counter and writer/version counters in header bytes 24–27 and
92–99, which SQLite can legitimately change while copying a database. The digest
format is versioned as `sha256-sqlite-pages-v1`. This verifies the pinned source
snapshot, rather than comparing the replica with a primary that has kept writing.

The viewer shows the primary snapshot time, last successful synchronization and
verification time. The snapshot timestamp describes when the source read was
pinned, not when a long transfer finished. Chart observation extensions stop at
that snapshot time. Clocks should be synchronized on both computers.

To check a saved replica again without writing to it:

```sh
node scripts/replica-verify.js --directory /srv/st-mq-replica
```

The publication manifest and receiver bookkeeping stay outside the mirrored
database. Snapshots and metadata use private file permissions (`0600`) in a
private directory (`0700`). SSH authenticates and encrypts the transfer; the
digest detects content mismatch and is not a substitute for authentication.

## Configuration reference

| Private setting | Environment override | Default |
| --- | --- | --- |
| `controller.role` | `STMQ_ROLE` | `primary`; choose `replica` for the viewer |
| `replication.enabled` | `STMQ_REPLICATION_ENABLED` | `false`; environment accepts `0` or `1` |
| `replication.directory` | `STMQ_REPLICA_DIR` | `<database directory>/replica` |
| `replication.ssh_host` | `STMQ_REPLICATION_SSH_HOST` | Required when sending; SSH alias |
| `replication.ssh_config` | `STMQ_REPLICATION_SSH_CONFIG` | Empty: normal SSH configuration; otherwise absolute local path passed with `-F` |
| `replication.remote_directory` | `STMQ_REPLICATION_REMOTE_DIR` | Required when sending; absolute path |
| `replication.receiver_path` | `STMQ_REPLICATION_RECEIVER` | Required when sending; absolute path |
| `replication.node_path` | `STMQ_REPLICATION_NODE` | `node` on receiver |
| `replication.rsync_path` | `STMQ_REPLICATION_RSYNC` | `sqlite3_rsync` on primary |
| `replication.remote_rsync_path` | `STMQ_REPLICATION_REMOTE_RSYNC` | `sqlite3_rsync` on receiver |
| `replication.interval_seconds` | `STMQ_REPLICATION_INTERVAL_SECONDS` | `60`; range 10–86400 |
| `replication.timeout_seconds` | `STMQ_REPLICATION_TIMEOUT_SECONDS` | `3600`; range 30–86400 |
| `replication.stale_seconds` | `STMQ_REPLICA_STALE_SECONDS` | `180`; adjust for longer sync intervals |
| — | `STMQ_REPLICATION_WORK_DIR` | `<data directory>/replication` on primary |

Replication is disabled by default. No remote machine is configured by installing
this feature. The add-on can send to a standalone Linux replica; an add-on viewer
also works when its configured replica directory is populated by a receiver with
access to that directory. The viewer itself does not start an SSH server.

Implementation references: [SQLite remote-copy tool](https://sqlite.org/rsync.html),
[SQLite online backup API](https://sqlite.org/backup.html), and the unchanged
[model reconstruction contract](reconstruction-and-versioning.md).
