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

The current 70-minute reporting interval plus five-minute grace is a recorded
configuration choice under the existing report-coverage rules. A policy change
now saves an explicitly marked policy event at its effective time. It may carry
an already genuine report that remains within the new deadline, retaining that
report's source time and original receipt lineage. Its new coverage span starts
at the configuration time with zero new reports; earlier spans, outages and
committed learning samples remain unchanged. Restart cannot renew that deadline.
Explicit acquisition failures and sensor-change exclusions still require genuine
recovery evidence. This forward-only configuration event does not reinterpret
archived journal entries or change the ordered learning update and replay rules.

A confirmed MQTT subscription can likewise end a transport-only outage for a
room whose genuine report is still inside its original deadline. A saved route
hash must match the confirmed broker, topic and decoder mapping. The recovery
event retains the original source/receipt clocks and starts zero-report coverage
at reconnection; preceding outage windows and committed samples stay excluded.
Invalid payloads, device-offline evidence and sensor-change exclusions cannot be
cleared this way. Unsigned older reports need one genuine publication to establish
route lineage; no restart or retained publication certifies that missing evidence.

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

## Separate Garage learning

`committed-garage-v1-coupled` establishes Garage's own saved seed and journal
stream (`garage:<input>`). It applies this same reconstruction contract without
changing Home's learning algorithm or CSV interpretation. Ordered normalized
samples, configuration and sensor-correction events drive both live updates and
worker reconstruction. Memory publication follows successful durable checkpoint
publication; a failed write retains the previous checkpoint. A Garage failure
revokes its pause permission while Home control continues independently.

Garage's frozen episode reference and each protection location's thermal reserve are
separate from replaceable model checkpoints. A corrected reconstruction never
rewrites observed behavior, resurrects an old pause or clears physical recovery
debt. Imported rear-only history remains a separate, explicitly incomplete
reconstruction; missing front/native/OFF evidence is not fabricated. See
[Garage learning](garage.md) for its supported evidence and provisional adapter
boundary.

`committed-garage-v2-sparse` replaces v1's per-report recursive fit and short-step
readiness with a smaller duration-weighted fit, retained regime statistics,
whole OFF/recovery validation and supported-duration planning. The v1 algorithm
and `garage-exposure-v1` arithmetic remain archival at Git revision `e0b0c11`;
they are not replayed as v2. The first v2 journal entry saves a new explicit seed.
Adapter boots interrupt active evidence but do not erase completed experiments;
explicit sensor corrections still establish measurement boundaries.

An existing frozen v1 accounting episode remains an incomplete archived
assessment with an active measured restoration obligation. New code never calls
v2 prediction on its v1 model. Its original observations, frozen state and costs
remain archived; both measured locations must recover before the obligation ends.
If changed weather makes the former absolute temperatures unattainable, eight
continuous hours of verified normal native availability with both locations above
the then-configured warm-recovery threshold and local exposure repaid could close it as
incomplete. That measured restoration rule grants no comparable-service or savings
claim and never evaluates old dynamics as the new model.
Operational exposure separately upgraded to `garage-exposure-v2`, retaining at
least the previous debt and a full uncertain budget until measured warm recovery.
An explicit v1 configuration value was accepted and normalized without editing
private configuration or overriding custom numeric limits/approval. These are
recorded forward transitions, not reinterpretations of the old learning journal.

`committed-garage-v3-event-doors` replaces the fixed five-minute contact age
cutoff with confirmed event state. An unchanged door remains known while its
configured source and MQTT connection remain available. Explicit source failure,
invalid state, subscription loss, bridge outage or restart makes it unknown.
Recovery requires a live source snapshot and the configured availability evidence;
retained context and bridge birth alone cannot restore it. A recovery may confirm
the original contact timestamp without pretending that it is a new measurement.

Each resolved sample saves the door source timestamp separately from live
confirmation and the start of uninterrupted closed evidence. An opening, outage
or restart ends that closed interval. Even if the door recovers before the next
temperature sample, the interrupted interval cannot teach thermal coefficients,
baseline warmth or clean validation evidence. That learning exclusion remains
unchanged under the current protection policy. The original v3 planner also
blocked economic pauses for configured unknown or open doors; the thermal-reserve
policy removes that control veto. Frozen episode accounting preserves observed
costs and restoration debt while withholding savings qualification after a door
disturbance or gap. Historical inputs without configured contact
evidence retain their explicitly incomplete interpretation. These are compact
resolved sample inputs, not periodic door snapshots or a new telemetry archive.

The v2 journal and frozen episodes remain archival at Git revision `69a5ae4` and
are never replayed with v3 semantics. The first v3 entry saves its explicit initial
seed and begins a new learning epoch; exposure and outstanding physical recovery
obligations remain intact. Home learning, CSV formats and imported source clocks
are unchanged.

### Thermal-reserve protection policy

`garage-thermal-reserve-v1` replaces the operational degree-minute exposure index
with one continuously integrated reference temperature per protection location.
The estimated heat above the configured margin is expressed in kJ per metre of
the reference water-filled copper pipe. Cooling and warming depend on the
air/reference temperature difference and elapsed time. There is no hard air
limit, full assigned allowance, recovery dwell or fixed repayment rate.

This is a **protection and planning policy version**, not a new garage learning
algorithm. `committed-garage-v3-event-doors` retains its equations, coefficients,
door-disturbance eligibility, original ordered inputs and live/rebuild update
function. The operational transition preserves learned state and the old
journal's saved configuration and digests; it does not relabel old records as a
new algorithm. Home learning and imported CSV interpretation are unchanged.

Old `garage-exposure-v1`/`garage-exposure-v2` configuration remains readable, but
its numeric allowance and approval cannot authorize the new model. The effective
thermal policy starts unapproved with the new defaults. Old operational debt is
not converted numerically into joules. An unsupported or absent protection state
starts conservatively and requires measured recovery; the policy boundary never
grants a freshly warm reference from one air reading or forgives a persisted
restoration obligation. Old protection records remain archival under their own
arithmetic, and no private configuration file is silently rewritten.

Episode recovery checks now use the reference heat reserve, while retaining the
independent checks for measured local warmth and slow building memory. A positive
freeze-protection reserve cannot alone finish a building-recovery episode or
qualify savings. Historical frozen assessments retain their matching algorithm
and evidence; an incompatible protection baseline cannot create a comparable
recovery claim. See [protection details](garage-protection-defaults.md).
