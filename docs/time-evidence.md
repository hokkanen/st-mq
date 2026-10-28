# Time and evidence

Source time, receipt time, admission time and evaluation time have different
meanings. ST-MQ preserves them instead of correcting device timestamps or adding
a future allowance to every freshness comparison.

- **Source time** is the device/provider's measurement or transition timestamp.
- **Transport receipt time** is local wall time when the response or packet arrives. An
  HTTP request's start time is not its receipt time. Re-reading a cache does not
  produce another receipt.
- **Admission time** records when a slightly early report became eligible for
  use. It never replaces either original clock or renews source freshness.
- **Evaluation time** is the current local wall time, sampled after awaited
  acquisition where necessary. A historical query uses its explicit cutoff.
  Durations for bounded pending work use a monotonic clock.

Queueing behind native acquisition or a storage transaction spends time without
changing a report's source or receipt clock. When processing a queued vehicle
report, evaluate current charger readiness against the processing clock: a newer
admitted native readback must not appear future-dated against the older packet's
receipt. Source-time admission still validates the original clocks independently.
Queued equipment snapshots, availability and temperature messages likewise check
current Caravan qualification against processing time. A newer admitted meter
must not become unavailable merely because another message arrived earlier.
Heating's staged control preparation rechecks its five-second age limit inside
writer admission, before continuing. A stale preparation restarts control from
fresh observations without retiming committed learning inputs or checkpoints.

## Device report admission

The shared policy in `src/domain/time-evidence.js` permits at most 1,000 ms of
source lead relative to actual receipt. Such a report waits until local wall
time reaches its source timestamp. It cannot establish a session, vehicle target,
command confirmation, measured current, temperature or learned input before
then. A greater lead, invalid timestamp or future local receipt is rejected.
Simply waiting until a previously rejected large lead passes cannot validate it.

The pending queue in `src/acquisition/source-time-pending.js` is connection-local
and bounded by count and a monotonic deadline for a still-future source clock.
Timers recheck the original report
automatically; another device message or polling cycle is not required. Ordered
transition streams retain unplug, permission and subsequent reconnect order.
Disconnect, replacement, rollback and queue failure keep evidence and command
permission fenced. Neither repeated packets nor wall-clock rollback extend a
source-clock wait. If writer admission runs after that deadline but the original
source clock is already ready, the queue admits the report with its original
source and receipt clocks. Each consumer still checks the report's remaining
freshness, required fields and current connection; writer delay cannot renew
evidence or grant permission before admission. A correlated read waits only for
its own reply; this
does not retry a device command.

For a native metered Shelly switch, a partial `NotifyStatus` containing only
`ts` and that switch's `id`/`aenergy` leaves independently admitted required
switch, power and current readings available until their original expiry. The
counter remains quarantined and keeps its source timestamp; its receipt cannot
renew those readings. Required custom mappings on the same switch component,
mixed/full reports, faults and later required packets retain the availability
fence and device queue order. Rejecting or expiring a counter-only packet does
not withdraw unrelated fresh evidence. An actual connection loss or required
reading expiry still withdraws availability.

Native evidence carries optional `admittedAt`. Canonical observations retain an
exact `raw.timeAdmission` object containing `sourceTime`, `receivedAt` and
`admittedAt`. Its original clocks must match the observation, and its admission
must be at or after both clocks and at or before evaluation. Reports with ordinary
clock ordering also carry admission metadata when held behind an earlier queued
transition. Reports admitted immediately need no metadata. An unexplained source-after-receipt observation
remains invalid after clock catch-up and cannot borrow another report's proof.

Freshness retains the original source/receipt basis: waiting spends the report's
remaining lifetime. Invalid data, retained MQTT packets, stale connections and
unknown values remain subject to their existing evidence checks. Independent
current sources need no timestamp pairing or common snapshot. This policy does
not replace the current allocation contract or electrical limits.

## Recording and replay

Coverage and causal readers cannot expose a deferred report before admission.
Recording, indoor selection, voltage estimation, electrical integration, native
energy tails and recovery use the same admission validation. Original timestamps
and energy interval geometry remain intact. A later aggregate publication keeps
its separate publication receipt; it cannot backdate the supporting evidence.

Electrical rows marked `raw.acquisitionOnly` may represent a published snapshot
of already admitted OCPP or stream values. Their `receivedAt` is the snapshot
publication time, sampled after reading the snapshot; it is not a new transport
receipt or independent measurement. The original source clocks and native
transport evidence remain unchanged. These rows feed electrical integration and
voltage coverage rather than being stored as new raw measurements. Repeated
publication cannot renew source freshness: native OCPP snapshots retain their
60-second source bound, ordinary electrical inputs retain their five-minute
bound, and existing held-value exceptions require independent device telemetry.

Home learning uses `committed-house-v17-time-evidence-admission` because admission
changes input selection. Current journals replay deterministically under that
algorithm. The current schema includes an index for bounded startup rejection of unsupported
learning algorithms, including inactive journal epochs. Earlier development
algorithms are rejected before mutation and need a deliberate fresh start;
no migration, historical timestamp repair, older
interpreter or fitted-model seeding is provided. The supported read-only 0.7.5
CSV import boundary is unchanged.

## Other clock domains

Command acknowledgement ordering still follows each protocol's confirmation
contract. Whole-second device timestamps require correlated native readback where
specified; a tolerance cannot prove command receipt. Session identity, command
leases, restoration deadlines, authentication, pairing authority and snapshot
acceptance retain their own exact checks. No global future-time grace grants
control or extends a physical obligation.

Pairing browser display ages use the server's status clock advanced by monotonic
elapsed time. Pairing snapshot presentation allows the existing 60-second cross-computer
uncertainty and displays zero age within it, never a negative age. This is display
policy only; it changes neither roles nor permission to promote or control.
Paired and mirror publications bind their source clocks to the exact delivered
checkpoint's frozen source read. A pending retry keeps those clocks even when
the master has newer data; a static seed keeps its original export clocks.
An earlier checkpoint query, receiver receipt time and transaction seal time
cannot substitute for that read boundary. Saved charging and learning dates
remain independently checked against the publication clock.
Market periods and forecasts are intentionally future dated and retain their
issue/availability checks instead of device-report admission.

Validation covers +1, +4, +400 and +1,000 ms leads, larger skew, stale or retained
evidence, clock rollback, reconnect, queued transitions, transaction failure,
original timestamp persistence, causal history and deterministic replay. See
[development validation](development-validation.md).
