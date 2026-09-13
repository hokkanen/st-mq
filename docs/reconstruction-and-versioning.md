# Model reconstruction, corrections and software versions

This is the agreed engineering contract. Changes to it require the owner's explicit
agreement. The fireplace feature keeps the existing scope of reproducible learning;
it does not add a general archive for reproducing every historical control choice.

## What can be reconstructed

Given an intact committed learning journal, its saved configuration and initial
seed, the selected fireplace and sensor-correction revisions, and the matching
learning algorithm, replay must produce the same model checkpoint. Live learning and reconstruction
must use the same ordered entry function. Checkpoints are replaceable caches with
integrity digests and journal cursors; they are not the only source of model history.
Original discarded polls are not required once their resolved learning inputs have
been committed. Imported CSV provenance and interpretation remain unchanged.

This guarantee is conditional on retaining those inputs and the corresponding
software. Corrupt or lost source history cannot always be repaired by replay, and
size limits or deliberate history removal can limit the recoverable interval.
Checksums detect accidental changes; they neither authenticate data nor replace
backups. A SQLite transaction prevents a partial checkpoint publication, but cannot
guarantee survival of every hardware or storage failure.

Existing control plans, observations, command attempts and available acknowledgements
remain useful evidence. Exact replay of every past choice is outside this contract:
we do not capture every transient provider response, scheduler state or complete
runtime snapshot. A recorded command attempt is not proof that the heat pump received
or applied it. Readback and measured behavior must remain distinct from intent.

## Manual source corrections

`fireplace_events` stores a load once and a removal once, with server timestamps,
input source and retry identifiers. The original load remains after removal, even
for an immediate mistake. This small uniform log avoids ambiguous deletion races.
A revision is the last included event ID for that source. A removed load contributes
no heat anywhere in that revision's corrected history; selecting an older revision
recovers the earlier interpretation. Raw observations and learning journal payloads
are never rewritten by the fireplace interface.

Learning derives fireplace inputs in memory from the event revision. Corrected
replay can change fitted parameters, reserve estimates and comfort/evidence state.
Affected cycle assessments lose their savings/recovery claims; their actual
observations, command history and original frozen forecasts remain recorded.
Coefficient charts replay with the current corrected fireplace revision and the
configuration recorded with each journal entry. They describe reconstructed model
history, not a complete account of every model instance used by past decisions.

If no subsequent learning window consumed a load, removal needs no coefficient
rebuild. Otherwise a worker replays the corrected history while the existing model
continues serving control. Planning uses the corrected fireplace source immediately;
the temporary reserve observer is recalculated using the active coefficients.
The worker catches up new journal entries and must match both source revision and
journal head before the engine atomically publishes its complete checkpoint and
completion status. Newer corrections supersede stale workers. Pending work survives
restart. A failed worker retains the previous model and reports failure; restarting
the service or recording another correction retries it.

## Version discipline

`committed-house-v4-fireplace` introduced the pooled fireplace response and its
original evidence rules (Git revision `a3390ad`). `committed-house-v5-fireplace`
adds meaningful-tail learning gates and fitting against retained, validated house
coefficients. The fixed response curve remains version 1. The v4 journal remains
an archive requiring its matching code; the current runtime does not relabel it.
The first v5 record establishes the new algorithm's explicit seed/learning epoch.
`committed-house-v6-sensors` introduces a configured indoor average, individual
room comfort references, bounded bidirectional comfort adaptation, and recorded
sensor-change boundaries. The v5 archive requires its matching code (for example
Git revision `dd7d378`); it is never replayed as v6. The first v6 entry saves the
explicit initial seed. Legacy CSV `temp_in` still means the original upstairs
sensor; imported learning remains separate from a live multi-sensor average.

Sensor changes are compact immutable journal context events, with a server
timestamp, logical signal, reason, settling deadline and retry identity. They
start a new measurement period under the active algorithm; an ordinary sensor
replacement does not create a new software algorithm version. Affected thermal
and comfort evidence is cleared, with house coefficients retained only as starting
estimates. Live updates and replay apply this same reset. Old observations and
frozen cycle forecasts remain unchanged, and no calibration offset is invented.
Configured average-membership or weight changes also establish a measurement
boundary. See [temperature sensors](temperature-sensors.md) for operational rules.

`committed-house-v7-held-indoor` keeps the latest genuine known reading for each
configured indoor sensor through age and disconnection, with the configured
weights unchanged. These held contributions remain usable for control and
learning; no cross-room estimate or replacement timestamp is invented. Every
committed member saves its original observation time and lineage, plus whether
it was held and needed attention (older than two hours, disconnected or an
invalid later update). Never-seen sensors remain missing. Invalid, retained,
unknown-time and future measurements cannot replace a genuine reading. Sensor
changes and their settling periods still exclude earlier measurement periods;
outdoor and equipment freshness rules are unchanged.

The v6 journal remains an archive requiring its matching code (Git revision
`113e495`); the runtime does not replay it as v7. The first v7 entry records its
explicit initial seed and starts the new learning epoch. Historical CSV indoor
values retain their original Upstairs interpretation and import provenance.

`committed-house-v8-report-coverage` adds a recorded reporting contract for
periodic indoor MQTT sensors: a 15-minute interval plus two minutes of grace by
default. A genuine newer report confirms coverage even if its temperature is
unchanged. Compact recorder spans preserve that evidence without inserting
scheduled temperature rows. Each span extends only when the next report arrives
before the previous source report expires; missed deadlines and explicit source
failures start a gap that later recovery cannot erase. Retained packets and
repeated source timestamps cannot extend coverage. The original saved temperature
and its observation time remain separate from report availability.
Enabling or changing a periodic reporting policy records one explicit availability
boundary and waits for a genuine report under the new contract. Restarting while
that report is pending does not duplicate the boundary. Disabling the policy
cannot erase a periodic gap earlier in the same learning window.

Live control uses the normal safe fallback when any configured periodic member
is unavailable. Learning also rejects a completed window that crosses a report
gap, even if the sensor has recovered by the endpoint. The committed sample saves
the complete-window coverage result and observation/coverage lineage; live
updates and rebuilding consume that same immutable sample. Sensors without this
periodic contract, including the existing H66 and garage sources, retain their
previous behavior. CSV interpretation and provenance are unchanged.

The v7 journal remains an archive requiring its matching code (Git revision
`b779b44`), and is never replayed as v8. The first v8 entry records the explicit
initial seed and starts its own learning epoch.

`committed-house-v9-reversible-sensors` adds append-only sensor-change reversals.
A reversal references the original change; both records remain in the journal.
Its selected correction revision retracts that measurement boundary throughout
reconstruction while preserving other sensor changes and configuration boundaries.
Only changes within the supported algorithm can be reverted; the v8 archive
requires its matching code (Git revision `fc5ec60`) and is never relabelled as v9.
The first v9 entry records the explicit initial seed for the new learning epoch.
A seed after an archived reset is not evidence of the state before that reset.

Acquisition and recording remain independent of resets. V9 resolves genuine
indoor endpoints, periodic coverage and outdoor interval measurements before
applying sensor exclusions. Reset-affected samples retain a compact patch of
those original temperature inputs, including bounded coverage intervals. Other
sample inputs are not duplicated. Live updates and corrected replay apply the
same pure eligibility projection to these saved inputs. Thus a reverted reset
recovers settling-period temperatures without new device polls, rewriting old
journal payloads or relying on later mutable coverage. Real reporting gaps,
invalid measurements and original historical configuration remain authoritative.
This is a temperature-input addition, not a per-minute model snapshot or a full
decision-input archive. Imported CSV interpretation and provenance are unchanged.

A sensor reversal queues the shared background correction worker even before a
subsequent sample exists, because the boundary itself cleared model state. The
worker pins both correction revisions and the selected journal epoch, catches up
the journal head, and publishes a complete checkpoint atomically. The previous
model continues serving control until publication; pending intent survives restart
and failed jobs can be retried. Reversal never resumes an interrupted historical
cycle or invents the control actions that might have occurred without the reset.
Original recorded model-input charts retain the inputs used at that time;
coefficient charts show the selected corrected model assessment.

Existing experimental SQLite contents do not require a compatibility migration.
Changes to numerical interpretation,
training selection, corrections, seeds or fitting rules require an explicit learning
algorithm version change and appropriate replay tests. Configuration changes remain
recorded with their configuration digest and snapshot. SQLite schema versioning is
separate from learning algorithm versioning.

Never interpret an old journal as a newer algorithm while claiming identical
reconstruction. Support an older version explicitly, or preserve its history as an
archive with the matching Git revision/release and establish an explicit new seed
or new learning epoch. Old implementations do not have to run beside the current
controller. Reproduction of an archived unsupported version requires checking out
its corresponding code; the current runtime must report unsupported history honestly.

The fireplace addition must remain compact: source events are stored once, input
projections are derived, and rolling model state remains bounded. Do not add repeated
full histories, per-minute model snapshots or comprehensive decision-input archives
without a separately agreed change of scope and a measured storage budget.

Retrospective firewood savings are a separate, read-only calculation under the
current corrected model and normal heating policy. A model update can revise them.
They do not claim to reconstruct a past controller's forecast or control choice,
and must remain labelled as estimated rather than measured savings.
