# Read-only database mirror

In mirror mode, the master copies its SQLite database to a second Linux
computer. The slave serves recorded history and charts, but cannot record
measurements, change settings, learn, connect to providers, or command equipment. Its role is
machine-local configuration; copied master settings cannot activate a controller.
Both computers select `controller.topology: "mirror"`; their local
`mirror.role` is `master` or `slave`. This is one-way mirroring. There is no
role-change workflow, automatic control takeover or reverse database recovery.
Use [pair mode](pairing.md) when the second computer must take control manually.

The viewer keeps the dashboard cards visible with recorded values and explicit
snapshot age. Database edits, settings changes and device commands are disabled
in both the dashboard and API. History navigation and downloading a verified
database copy remain available. Saving a new database copy on the server is a
write action and requires the active master. Missing live device state is shown
as unavailable, and any local configuration defaults are labeled separately
from settings recorded by the master.

Both computers should run the same ST-MQ release. The viewer checks the database
schema without migrating it. If a new snapshot cannot be opened, an already
running viewer keeps its previous readable generation and reports the problem.
The separate production 0.7.5 installation and CSV imports are unaffected.

## Set up two standalone Linux computers

Install ST-MQ and build its UI on both computers using the normal installation
instructions. Both need Node.js 22.19 or newer. The master needs an SSH client;
the slave needs an SSH server and an account that can run Node.js and write its
dedicated snapshot directory. Neither the slave viewer nor synchronization needs
MQTT or provider credentials.

Install `sqlite3_rsync` on both computers. This is a SQLite tool, distinct from
ordinary `rsync`. To build the pinned official version used by the container and
CI, install a C compiler, curl, tar and unzip, then run:

```sh
node scripts/build-sqlite-rsync.js --output "$HOME/.local/bin/sqlite3_rsync"
```

The builder verifies official source archive checksums before compilation. Make
the binary available on each computer's PATH, including noninteractive SSH
sessions, or configure its absolute path below. The app image includes the
tool and SSH client already.

On the slave, choose a **dedicated, initially empty directory** for received
snapshots, such as `/srv/st-mq-mirror`, accessible to the receiver and viewer.
Run the receiver and viewer as the same Unix user (or run the viewer as root);
private directory and file permissions intentionally do not grant group access.
Start the viewer with:

```sh
STMQ_TOPOLOGY=mirror STMQ_MIRROR_ROLE=slave STMQ_MIRROR_DIR=/srv/st-mq-mirror npm start
```

Alternatively set `controller.topology` to `mirror`, `mirror.role` to
`slave` and `mirror.directory` in that machine's private configuration.
A mirror slave does not need outgoing SSH settings. Until the first verified
snapshot arrives, the UI reports that it is waiting. Use the existing web-token
and binding settings for authenticated LAN access; no token is needed for the default loopback-only viewer.

On the master, configure an SSH host alias for the slave, including its user,
identity file and verified host key. The service uses unattended authentication
and strict host-key checking. Keep SSH keys and configuration outside the checkout.
Use a persistent SSH configuration/key location when running in a container.
Set `mirror.ssh_config` to its absolute path; this is honored by both SSH
channels. An SSH config can specify `IdentityFile` and `UserKnownHostsFile` paths
inside that persistent directory. For the Home Assistant app, `/config/mirror-ssh/config`
and its private directory survive container replacement. Provision the key and
known host entry there before selecting mirror topology.

Select `mirror` topology and `master` role, and add a `mirror` section to the
master's private settings. This invented example assumes the slave checkout is
`/opt/st-mq` and its host alias is `stmq-mirror`:

```json
{
  "controller": {
    "topology": "mirror"
  },
  "mirror": {
    "role": "master",
    "ssh_host": "stmq-mirror",
    "ssh_config": "/etc/st-mq/ssh/config",
    "remote_directory": "/srv/st-mq-mirror",
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
`rsync_path` runs on the master; `node_path`, `receiver_path` and
`remote_rsync_path` run on the slave. Use absolute paths if those executables
are not available through the noninteractive SSH PATH. Restart ST-MQ after
changing role or mirror settings. Existing acquisition and control settings
on the master remain in effect.

Remote paths and executable names accept letters, numbers, dots, underscores,
slashes and hyphens; spaces and parent-directory traversal are rejected. This
keeps the SSH command interface unambiguous.

The supplied `deploy/st-mq.service` uses `ProtectHome=true`: install the tool in
`/usr/local/bin/sqlite3_rsync` and keep the service's SSH configuration, identity
and known-host file under a private `/etc/st-mq/ssh` directory readable by the
`stmq` user, instead of relying on files under a home directory. Its writable
state directory is `/var/lib/st-mq`; a slave viewer can use
`/var/lib/st-mq/mirror`. Put local environment overrides in `/etc/st-mq.env` as
supported by that unit.

## Outages and large catch-ups

The master attempts synchronization automatically while it runs. Only one
attempt runs at a time. An unreachable receiver, failed transfer or failed
verification is reported without stopping home control. Subsequent attempts
compare against the latest published snapshot; there is no queue of telemetry
messages or retained change log that can expire during a long outage.
Failed attempts back off to a maximum of five minutes, unless the configured
interval is longer. If the delta tool rejects its destination, the same pinned
source snapshot gets one retry against an empty incoming file; this also handles
database page-size changes. Missing or damaged snapshot bases are copied afresh.

The receiver keeps serving its last verified snapshot during synchronization.
It receives the next snapshot into a separate incoming file, verifies it, then
atomically publishes its manifest. Readers switch generations without combining
queries from different snapshots. An interrupted transfer cannot become visible
history. Receiver ownership uses an operating-system-backed SQLite lock, released
on process or machine failure; a long transfer does not lose a timed lease.

The transfer timeout defaults to one hour and can be raised to 24 hours for large
databases or slow links. The interval is the delay between attempts; a long
transfer does not start overlapping copies. A slave that loses its database
can be initialized again from the master. If the master is offline, the viewer
still serves saved history, marked stale, until synchronization resumes.

Mirroring uses incremental network transfer, but snapshot preparation and
verification perform local disk work proportional to database size. A background
worker pins a consistent master read transaction, makes a SQLite backup and
hashes it. This does not block the controller's JavaScript event loop, although
it consumes disk bandwidth and a long read can retain master WAL pages. Increase
the interval for large databases or slow storage. Prepare enough disk space for
the source snapshot, and on the slave for the current, previous and incoming
snapshots. Filesystem reflinks reduce local copying where available; do not assume
they are available when sizing storage. Allow additional headroom for SQLite's
rollback journal during catch-up and for older files still held open by ongoing
viewer requests. Old published generations and interrupted incoming files are
pruned; the manifest names the current and previous retained snapshots.

There is no zero-loss guarantee: the slave contains only a successfully copied
master snapshot. A permanently lost master disk can lose changes newer than
that snapshot, and no computer records provider history while the master is
stopped. Ordinary retained backups remain useful because mirroring also copies
intentional deletions and application mistakes.

## What identity verification means

Every successful publication requires a full SQLite `integrity_check`, matching
file length and matching SHA-256 of the standalone source and received database.
The digest includes schema, table, index and free-page contents. It excludes only
SQLite's change counter and writer/version counters in header bytes 24–27 and
92–99, which SQLite can legitimately change while copying a database. The digest
format is versioned as `sha256-sqlite-pages-v1`. This verifies the pinned source
snapshot, rather than comparing the slave with a master that has kept writing.

The header shows **Mirror · Master** on the source and **Mirror · Slave** on
the viewer. The **Database mirroring** section shows synchronization status.
The viewer shows the master snapshot time, last successful synchronization and
verification time. The snapshot timestamp describes when the source read was
pinned, not when a long transfer finished. Chart observation extensions stop at
that snapshot time. Clocks should be synchronized on both computers.

To check a saved snapshot again without writing to it:

```sh
node scripts/replica-verify.js --directory /srv/st-mq-mirror
```

The publication manifest and receiver bookkeeping stay outside the mirrored
database. Snapshots and metadata use private file permissions (`0600`) in a
private directory (`0700`). SSH authenticates and encrypts the transfer; the
digest detects content mismatch and is not a substitute for authentication.

## Configuration reference

| Private setting | Environment override | Default |
| --- | --- | --- |
| `controller.topology` | `STMQ_TOPOLOGY` | `standalone`; choose `mirror` on both computers |
| `mirror.role` | `STMQ_MIRROR_ROLE` | `master`; choose `slave` for the viewer |
| `mirror.directory` | `STMQ_MIRROR_DIR` | `<database directory>/mirror` |
| `mirror.ssh_host` | `STMQ_MIRROR_SSH_HOST` | Required when sending; SSH alias |
| `mirror.ssh_config` | `STMQ_MIRROR_SSH_CONFIG` | Empty: normal SSH configuration; otherwise absolute local path passed with `-F` |
| `mirror.remote_directory` | `STMQ_MIRROR_REMOTE_DIR` | Required when sending; absolute path |
| `mirror.receiver_path` | `STMQ_MIRROR_RECEIVER` | Required when sending; absolute path |
| `mirror.node_path` | `STMQ_MIRROR_NODE` | `node` on receiver |
| `mirror.rsync_path` | `STMQ_MIRROR_RSYNC` | `sqlite3_rsync` on master |
| `mirror.remote_rsync_path` | `STMQ_MIRROR_REMOTE_RSYNC` | `sqlite3_rsync` on receiver |
| `mirror.interval_seconds` | `STMQ_MIRROR_INTERVAL_SECONDS` | `60`; range 10–86400 |
| `mirror.timeout_seconds` | `STMQ_MIRROR_TIMEOUT_SECONDS` | `3600`; range 30–86400 |
| `mirror.stale_seconds` | `STMQ_MIRROR_STALE_SECONDS` | `180`; adjust for longer sync intervals |
| — | `STMQ_MIRROR_WORK_DIR` | `<data directory>/mirror-work` on master |

The default topology is `standalone`, which does not synchronize databases.
`mirror` has no `enabled` flag: selecting the topology starts the appropriate
master or slave runtime. No remote computer is configured by installation.
The app can send to a Linux slave; a Home Assistant app viewer also works when its
configured snapshot directory is populated by a receiver with access to that
directory. The viewer itself does not start an SSH server.

Implementation references: [SQLite remote-copy tool](https://sqlite.org/rsync.html),
[SQLite online backup API](https://sqlite.org/backup.html), and the unchanged
[model reconstruction contract](reconstruction-and-versioning.md).
