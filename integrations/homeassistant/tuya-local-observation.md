# Tuya Local received-observation adapter

The DESD8LW bridge requires this small, reviewed source patch alongside the
`electriq_desd8lw_dehumidifier.yaml` profile. It reuses Tuya Local's existing
connection and native controls. It opens no second device connection.

Tuya Local's normal entity values temporarily include requested settings while
commands await device feedback. Its entity update time can also advance when an
unrelated datapoint arrives. Those values and Home Assistant `last_reported`
therefore cannot establish independent confirmed measurements. Calling
`homeassistant.update_entity` does not force a poll while this integration is
running. The patch instead captures accepted device replies before pending
settings are overlaid.

Only the dedicated profile's humidifier entity gains `local_observations`:

```json
{
  "identity": "opaque SHA-256 digest",
  "1": { "value": false, "timestamp": 1800000000000 },
  "2": { "value": 55, "timestamp": 1800000000000 },
  "4": { "value": "mid", "timestamp": 1800000000000 },
  "6": { "value": 50, "timestamp": 1800000000000 }
}
```

The four keys are power, target humidity, fan speed and measured relative
humidity. Timestamps are UTC milliseconds at **native report receipt**, not the
sensor's internal sampling clock. Each field advances only when that datapoint
arrives. Partial packets preserve other fields' timestamps; full replies omit
unreported fields. Heartbeats, cached reads and requested settings never renew
measurements. Connection loss and native cache reset clear observations; a new
connection requires new reports. The identity digest comes from Tuya Local's
native `unique_id` (the configured device ID for an appliance without a child
ID). The bridge requires it to match the selected private identity.

TinyTuya 1.20.0 can return an unsolicited partial `STATUS` frame from
`status()` before the corresponding query reply. Calling `status()` alone is
therefore insufficient proof that the first returned datapoints are a complete
read. On an exclusively owned, direct protocol 3.3 API/socket without forced-DPS
reads, the adapter can
recognize a newly decoded configured-socket frame with good CRC, zero frame
return code and a different sequence from the freshly sent supported query. It
records those present fields incrementally, retaining other original field
clocks. CRC is an integrity check, not proof of cryptographic authentication.

One memory-only query ticket also recognizes the delayed matching complete reply
in the existing receive loop. That reply withdraws omitted fields, including an
empty `dps` object. A second query before resolution, unqualified correlation or
loss of source exclusivity uses conservative omission handling on that connection
until its API/socket/protocol or native cache resets. This is uncertainty handling,
not proof that every subsequent packet is complete. Shared API wrappers, child
sources, forced-DPS configurations and unproved protocols retain the existing fail-closed polling behavior;
protocol 3.5's different response sequence rules are not guessed. Sequence
classification adds no query, queue drain, retry or socket reset. In particular, it
does not identify the cause of an earlier household bridge withdrawal.

While the single ticket or conservative connection state is active, the existing
receive uses the existing native command lock so its response metadata cannot
race a command. A silent native read can delay that command by the existing
socket timeout; no new timeout is added. Cancellation, errors and connection
reset preserve the native close behavior, release the lock and revoke old reply
generation. The consumer checks the original result identity, API/socket/protocol and
currently selected source owner again after the executor await. A revoked or
replaced source cannot repopulate cleared observations. If forced-DPS reads are
activated while a ticket is held, observations are withdrawn before that existing
read can consume an unclassified query reply. The
adapter adds no guarantee that arbitrary stream behavior is interruptible within
an absolute wall-clock deadline.

For an exclusively owned direct SDK source, a newly decoded `55AA` frame whose
integrity result is explicitly `false` is not usable device evidence even if its
encrypted body decodes. This applies to the first reply after a socket opens as
well as established status/receive calls. The adapter withdraws local observations
and discards the reply before either consumer can publish fields or renew clocks.
Full encrypted-wire protocol 3.3 CRC fixtures qualify this boundary; CRC does not
supply cryptographic authentication.

If a shared API exposes a failed integrity flag during the call, observations
are conservatively withdrawn without claiming the metadata belongs to that exact
returned body. A child API's parent-only metadata is not borrowed; this guard
makes no integrity claim for missing, stale, unknown or unattributed metadata.
Those cases retain the existing conservative classification. No SDK callsite,
retry or socket reset is added. Rejection leaves the old cache age unchanged, so
the existing loop may select an additional normal status poll while waiting for
usable data. This is evidence admission, not a traffic-reduction claim or proof
that a live household packet had an integrity error.

The patch preserves native connection locking and the existing retry handler.
It also forwards TinyTuya's returned command errors to that handler before
marking the requested datapoints sent. Previously, a returned connection error
could be discarded and the pending write marked sent without a successful
transport result. A successful `nowait` result still means only a transport
attempt, not device receipt or a new observation. The handler's existing retry
count, cache/evidence reset and empty-status exception remain unchanged.
Each locked retry reads the current unsent entries instead of replaying an
earlier failed batch. A successful result marks only the exact entries captured
for that attempt: a newer command, even one requesting the same value, remains
unsent until its own attempt. Removed entries are not recreated, and an empty
batch sends nothing and leaves native protocol-health flags and failure counts
unchanged. This does not cancel an already in-flight native attempt
or change a setting-write exhausted-retry reset; neither command bookkeeping nor
successful transport supplies received device evidence.
The bridge checks an expiring, identity-bound command before passing it to the
native Home Assistant service. Once handed off, Tuya Local's own delivery and
retry behavior applies; MQTT expiry is not a device-local cancellation guarantee.
Only a genuine subsequent device reply confirms the resulting state.

## Bounded status refresh after connection withdrawal

On the current registered DESD8LW humidifier, an established socket replacement
can withdraw native fields while the ordinary entity cache still looks recent.
The discarded reply remains unusable. For the exclusively owned direct protocol
3.3 persistent source, the adapter can request one earlier invocation of the
existing full-status retry handler. A current scheduled status read already
serves a replacement detected before that read; it does not add another request.
Poll-only, temporary polling, shared/child APIs, forced-DPS and other profiles or
protocols retain their existing polling paths.

The memory-only budget belongs to the actual API, protocol, selected source owner
and registered entity. It is consumed before native lock/executor waits. Further
socket replacement, errors, omissions or partial/cache/pending values cannot
rearm it. The budget renews only after all four exported fields have genuinely
arrived on the current admitted source, including boolean native power, as required
by the bridge. Unsupported power values remain unknown; the adapter adds no new
humidity or fan interpretation. Cleared generations and changed source ownership
cancel pending work and cannot admit its later reply. Original field receipt
clocks, query correlation and conservative omission rules remain unchanged.
The first native dispatch separately rechecks the captured observation generation
and shutdown state after lock/executor waits; neither becomes a new budget key.

Unsent commands defer the added read, and a newly queued command before its first
native attempt cancels it. A command arriving after a read starts waits for the
existing native lock and socket timeout, just as during an ordinary full read.
The added read uses the existing retry count, backoff and protocol handling; one
handler invocation may therefore send multiple wire queries. No new polling
interval, repeated refresh cadence, connection reset or serialization policy is
introduced. If only this added read exhausts its retries while its exact source
remains current, the terminal cache reset preserves the actual current pending
entries. It never restores an earlier snapshot, recreates a removed request or
replays a superseded value. The ordinary status-read boundary below separately
retains only unsent current intent; setting-write resets remain unchanged.

This avoids one demonstrated offline delay until the next periodic full poll. It
does not diagnose a household withdrawal or guarantee immediate device recovery.
The source patch still needs the separately reviewed Core restart below.

## Commands queued behind an ordinary status read

An ordinary periodic status read can exhaust its retries while a newer native
command waits for the same lock. Its terminal reset still withdraws observations
and clears the cache and connection/poll clocks. For a current exclusively owned
direct API without forced-DPS or child sources, it retains only the actual
currently unsent command entries. The first read dispatch captures the API,
physical identity, selected protocol and exact selected API/lock/owner record
after initial protocol selection and lock admission. Terminal retention requires
that same source; changed identity, API, protocol, ownership or shutdown uses the
existing reset. Shared, child and unproved sources retain their existing behavior.

Sent overlays are removed. Newer opposite or same-value entries retain their
own objects and supersede the earlier request; removed entries are not recreated.
No pending-command snapshot is restored. A setting-write terminal failure keeps
its existing reset behavior. This preserves a command already accepted by the
native integration, not fresh feedback or new command permission; only a later
device report confirms physical execution. Native polling, locking, retry counts,
protocol selection and backoff remain unchanged.

## Native field withdrawal diagnostics

The dedicated DESD8LW humidifier profile emits a fixed warning when an existing
producer actually removes held native fields. Other profiles, healthy reports,
startup with no held fields and repeated empty clears stay silent. Eligibility
and the last warning time are memory-only for that current device instance;
neither supplies source health or command permission.

The new message contains only `ST-MQ native-field-withdrawal:` and one authored
category. It includes no device names, identifiers, addresses, payloads, values
or exception text. Existing upstream messages have their own logging behavior.

| Category | Existing producer boundary |
| --- | --- |
| `monitor-stopped` | Native monitor stop or normal receive-generator exit |
| `receive-loop-ended` | Receive-loop finalization |
| `connection-paused` | Temporary native connection pause |
| `connection-mode-changed` | Poll/persistent mode or missing-socket transition |
| `forced-read-with-pending-query` | Forced-DPS read with unresolved query evidence |
| `native-transport-error` | Existing low-level native error handling |
| `receive-cancelled` | Receive cancellation |
| `receive-exception` | Existing receive exception handling |
| `reply-context-changed` | Consumer rejects a reply after its source changes |
| `connection-context-changed` | Native-call API/socket/protocol context changes |
| `failed-frame-integrity-flag` | Existing explicitly failed frame-integrity rejection |
| `cache-reset` | Native cache reset |
| `native-call-retry` | Existing native-call retry after failure |
| `full-classification-omission` | Full/conservative classification removes omitted fields |

Warnings are capped at one per 30 monotonic seconds per instance. Nested clears
emit only for the first actual withdrawal, and a failed diagnostic sink cannot
prevent evidence removal or alter native calls. Rapid flapping can suppress later
messages: this is deliberately incomplete diagnostic evidence. The category
identifies the producer branch, not a firmware, network or hardware cause. Native
field clocks, observation admission, query/retry counts and control remain on
their existing paths. Installing this diagnostic source still requires the
separately planned Home Assistant restart described below.

## Apply the reviewed patch

This adapter supports only the exact reviewed **2026.9.2** source hashes listed
in `tuya-local-observation.json`. An unknown or partially patched source is
rejected before mutation. Review a changed upstream source before updating the
adapter; a matching version label alone is insufficient.
An earlier patch's bytes are unsupported. To replace an already patched
installation, stop Core and deliberately restore both exact reviewed pristine
source files from their private backup before checking and applying the current
bundle. Keep a separate backup of the installed files for operational rollback;
the installer does not translate an earlier patch or select it at runtime.

Run the installer in an environment with Python 3 and write access to Home
Assistant Core's `custom_components/tuya_local` directory, such as a suitable
Terminal & SSH session. The current official Terminal & SSH app exposes Core's
configuration at `/homeassistant`, used below. If your file tool instead maps
Core's configuration to `/config`, substitute that prefix. ST-MQ's app container
has its own `/config` and cannot patch Core.

Copy `scripts/apply-tuya-local-observation.py` and the three files
`integrations/homeassistant/tuya-local-observation.json`,
`integrations/homeassistant/tuya-local-observation.patch` and
`integrations/homeassistant/tuya-local-desd8lw.yaml` with their relative layout
intact. Run from the copied bundle's root, first checking without writing:

```sh
python3 scripts/apply-tuya-local-observation.py \
  --integration-dir /homeassistant/custom_components/tuya_local --check
```

Apply with a private backup directory outside this repository and the integration:

```sh
python3 scripts/apply-tuya-local-observation.py \
  --integration-dir /homeassistant/custom_components/tuya_local \
  --backup-dir /homeassistant/private-backups/tuya-local-observation
```

The installer performs no network calls, Home Assistant restart, service call or
device command. It validates both files and the patch before backing up original
bytes, preserves permissions and line endings, then replaces each file atomically.
A failed second replacement restores the first. A reviewed Home Assistant restart
is required to load the patched Python classes; plan it separately from file
installation. HACS may replace the patch during an integration update. A missing
observation attribute makes the bridge unavailable rather than falling back to
optimistic entity state.

Offline validation: `node --test test/tuya-local-observation.test.js`. The tests
execute patched upstream methods and the pinned current SDK query/receive producers using synthetic native replies and checks
partial reports, pending values, reconnects, physical identity, scoped attributes,
returned command errors, native retries, exact source checks, backups, idempotence
and installation rollback. Pending-command interleavings check newer opposite
and same-value choices, lock waits, removal, multiple datapoints and retry order.
`test/tuya-local-query-replies.test.js` additionally checks delayed complete and
empty replies, overlapping queries, shared API ownership, frame integrity and
return codes, known invalid-integrity present fields, stale/unknown metadata,
cancellation, native timeout lock waits and source
replacement. Its SDK fixture executes first-frame selection and decoded-response
handling at a controlled validated-frame boundary; separate offline AES/CRC probes
qualify wire-parser reachability. These synthetic checks do not identify the cause of
an unconfirmed live command or prove physical delivery.
`test/tuya-local-withdrawal-diagnostics.test.js` additionally executes every current
clear caller and the full-omission producer, checks nested clears, constructor and
profile scope, the exact monotonic rate boundary, sink failure and fixed-message
privacy. It uses the same controlled decoded-frame boundary; logging assertions
do not independently validate encryption or CRC parsing.
`test/tuya-local-status-refresh.test.js` additionally runs the actual native loop,
SDK status/receive consumers and command retry handler at that controlled frame
boundary. It covers consumed budgets, complete/partial/invalid power, current
source and generation changes, queued/cancelled/in-flight work, poll-only behavior
and late superseding commands. Controlled executor gates compare ordinary and
added reads without claiming measured household command latency. Separate
source-pinned AES/CRC probes qualify the actual socket-reopen/parser path.
`test/tuya-local-read-command-retention.test.js` executes the whole periodic
status/receive producer and current native command path at the controlled frame
boundary. It checks current unsent entries, late supersession, multiple datapoints,
removed/sent entries, physical source and selected-owner loss, actual initial
protocol selection, and unchanged setting-write terminal failure. It does not
prove device delivery or household latency.
