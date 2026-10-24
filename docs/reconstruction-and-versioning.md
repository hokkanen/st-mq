# Model reconstruction, corrections and software versions

This is the detailed engineering contract for
[F2: model reconstruction](../AGENTS.md#f2). The foundational policies and
[conflicting-request process](../AGENTS.md#conflicting-requests) in `AGENTS.md`
govern changes; [F1: current-format compatibility](../AGENTS.md#f1) governs the
supported software and database boundary. Changes to the agreed reconstruction
guarantees or scope require the owner's explicit agreement after identifying the
conflict and consequences; specific informed approval already given for the change
carries forward. Maintaining algorithm identifiers and implementation details
within those guarantees does not itself require another approval. The
fireplace feature keeps the existing scope of reproducible learning; it does not
add a general archive for reproducing every historical control choice.

## What can be reconstructed

The owner-approved [production convergence and upgrade policy](../AGENTS.md#f9)
starts production data continuity at v1.0.0. Each subsequent release owns its
specific conversion from the preceding production release; older backups may use
documented intermediate releases. This does not add historical interpreters to
the current runtime or relax pre-production format rejection. An algorithm change
must explicitly describe retained evidence, any supported rebuild and any new
learning epoch. Original observations, frozen forecasts, corrections and their
provenance keep their historical meaning throughout an upgrade.

The current physical SQLite schema and the current journaled data layout have
separate identifiers. Physical schema 35 and journaled layout 31 add the compact
independent-evidence endpoint to recording coverage. They retain indexed
manual-firewood, coefficient-history, chronological coverage and bounded
journal/recovery reads. Every fresh database uses this one current layout and
its matching genesis/hash interpretation. There is no older-schema runtime
branch or alternate journal decoder. Strict physical-schema
validation rejects incompatible physical schemas before writable setup. The owner's one-time
2026-10-15 chart-index conversion exception requires verified backups and rollback,
unchanged table rows, original database/checkpoint identities and journal hashes,
and successful full current validation before coordinated code/database adoption.
It does not authorize startup conversion, journal rehashing or conversion to
a later schema. The owner separately approved the installation-only offline
coefficient-history preparation on 2026-10-21 under [F1](../AGENTS.md#f1), with
verified backups, retained source/transaction identities, external disposable
tooling and rollback. That exception adds no runtime conversion or permission to
convert other databases. For schema 34, the owner approved a further installation-only
offline conversion on 2026-10-22 under F1: stop both paired applications, preserve
verified backups and each node's own source rows, checkpoint, transaction and
authority identities, refresh only physical-file publication accounting, and
fully validate the candidates with rollback retained. The disposable tooling stays
outside Git; this is no permission to convert other databases. Runtime startup still rejects
other physical schemas before mutation. A pair with different physical schemas cannot mirror or
hand over across that boundary; both roles must use the same supported schema.
For schema 35/layout 31 the owner separately approved the installation-only
offline transition and scoped dehumidifier-history removal on 2026-10-24 under
[F1](../AGENTS.md#f1). External disposable tools must preserve the other source
history, complete learning journal, control/restoration state and pair authority,
with verified backups and rehearsed rollback. The operational replication
journal may be reanchored; its original history remains in those backups.
No conversion, journal translation, backfill or reset-on-startup is supplied
by the application, and this exception does not cover other installations.

Given an intact committed learning journal, its saved configuration and initial
seed, the selected fireplace and sensor-correction revisions, and the matching
learning algorithm and software, replay must produce the same model checkpoint
at the same committed journal boundary. This includes learned coefficients,
estimated building and slab state, comfort references and learning evidence.
Live learning and reconstruction must use the same ordered entry function.
Checkpoints are replaceable caches with integrity digests and journal cursors;
they are not the only source of model history.

The persisted checkpoint is a compact manifest over shared, content-addressed
prepared fitting samples. Hydration restores the exact working checkpoint,
including invalid barriers, historical normalization and episode membership,
before applying the existing digest and journal-boundary checks. Numerical learning
and the supported algorithm do not change. Sparse recovery checkpoints use the
same representation and retain their source revisions and selection boundaries.
Prepared cache bodies do not replace the immutable journal, configuration, seeds
or recovery contribution/decision ledger. Reverting or restoring a recovery still
selects preserved source history and rebuilds only genuinely affected learning.

The slave dashboard reads a compact recorded-model display, not a working
checkpoint. At the pinned publication boundary it validates the current storage
manifest and resolves every fitting/episode reference through the digest index,
then returns only the displayed model, references, evidence and configuration.
It does not fetch or hydrate prepared sample bodies. Displaying those saved
values is not a body-integrity or reconstruction check: complete hydration still
validates every referenced body's digest and normalized contents, and explicit
full verification retains its complete checks. No history is removed or replaced.

In memory, the Engine owns a detached recursively immutable checkpoint. Its
canonical digest can be reused only for that exact owned graph; loaded, foreign
or mutable checkpoints still receive complete validation. New journal input or
source interpretation produces a new complete checkpoint, and transaction
rollback restores the previous owned graph. This does not alter the numerical
algorithm, stored representation, journal checks or reconstruction guarantee.

File-backed live controller updates commit ordered learning inputs in short stages.
A read-only worker constructs canonical samples and applies the same ordered
learning function without retaining the writer reservation while it computes.
Later ordinary journal entries do not invalidate an intact computed prefix;
source selection, sensor boundaries, native instructions and dashboard changes
fence the next control stage. A delayed update takes fresh control inputs before
dispatch. Simulation and in-memory stores retain the same synchronous ordered function.
No physical command depends on an uncommitted input or control stage. A failed
later stage leaves earlier committed inputs available for exact replay.

Ordinary controller updates retain one final model cache for their ordered
learning work. Small caches can commit with the final stage; larger caches are saved
in a worker only after the immutable learning inputs and control intent commit.
The worker preserves the complete current checkpoint, validates its journal
boundary and source selection, and never rewinds a valid cache of the same
interpretation. A correct cache may lag the current journal head; restart replays that tail.
Initial reconstruction has a separate, committed dashboard readiness boundary:
actual observations, saved choices and independently qualified safe controls do
not wait for the model. The published learned model stays absent until the full
controller view commits. Safe manual edits do not invalidate an intact canonical
learning prefix; source selection, corrections, measurement boundaries and epoch
changes still do. The subsequent control turn checks all current instructions
and native evidence. Existing restoration duties and fixed deadlines progress
independently of replay; model-dependent automatic economics remains unavailable.
One active save and one replacement candidate bound pending work. A failed cache
save retains the previous cache and all committed inputs, reports reduced restart
acceleration, and does not roll back an already committed controller update.
Correction and recovery publication keep their separate exact-head and atomic
source-selection checks.

Final correction and recovery publication runs in a storage worker, including
sparse checkpoint capture and the complete source-selection transaction. The
application reserves one writer-admission turn through commit and synchronous
adoption of the result in memory. It holds no main-thread SQLite transaction
while awaiting the worker. Reconstruction and catch-up continue alongside live
learning; only this final publication turn queues subsequent writes. Timers and
read-only requests remain available, but write-dependent work waits for storage.
Committed replay-ready notifications schedule publication between controller
updates, so catch-up does not depend on a later update having no new learning.
Ready correction admission, reconciliation and final publication use the queue's
bounded control priority; progress notifications and ordinary cache saves retain
normal priority. Queue fairness can still interleave a learning update, so the
exact-head fence and catch-up retry remain mandatory before publication.
A single latest publication receipt per input commits with the model. The owner
joins worker exit and checks that receipt before releasing queued updates, so a
lost reply or cancellation after commit still adopts the complete saved result.
If cancellation prevents the commit, the previous selection remains intact. A
completed commit is adopted even if cancellation arrives before acknowledgement.
Shutdown revokes the worker immediately and joins publication before closing storage.

A failed source-correction publication reports failure without retrying the same
candidate on each controller update. Restart or an explicit correction retry can
resume it. Successful inline saves, correction publication and an already-current
validated cache can clear an earlier cache warning. Stale results, rollback and
older saves cannot clear a newer unresolved failure or resurrect a superseded one.
These changes preserve the learning algorithm, source evidence, charging control
state and restoration duties; they add no schema migration or older-format reader.

Preserve a consistent backup of the full SQLite database and the corresponding
software version. The journal contains resolved learning inputs, configuration and
seed information; fireplace and sensor-correction events preserve the selected
interpretation. A temperature or telemetry CSV export alone does not contain this
complete record and cannot guarantee exact reconstruction. Imported CSV provenance
and interpretation remain unchanged. Original discarded polls cannot be recovered,
but are not required once their resolved learning inputs have been committed.

Replaying the same correction revisions reproduces the same interpretation.
Selecting a later correction intentionally reconstructs a corrected model, which
can differ from the model used at the time. The source events preserve earlier
revisions without rewriting the original measurements.

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
or applied it. Recorded observations, forecasts and outcomes remain evidence in
their own right; model replay does not recreate missing physical outcomes or turn
estimated savings into measured savings. Readback and measured behavior must remain
distinct from intent.

Heating-plan exploration keeps hypothetical snapshots only in bounded memory.
An explicit admin one-cycle approval is retained with the actual cycle's frozen
plan; qualifying completed episodes also carry that approval context in the
learning journal. Simulated alternatives do not add journal entries, consume
learning allowance or validate a duration. Actual observations use the existing
ordered learning updates and completion gates. This adds provenance without a
second learning algorithm or a comprehensive archive of hypothetical decisions.

## Coefficient history and local verification

The main database stores compact changes for all four model coefficients,
including their initial/fitted/retained quality, evidence and source meaning.
Ordered learning captures intermediate changes during each committed batch; it
must not flatten them to the final model or replay the whole journal merely to
record chart output. Database backups, exports and mirroring carry this history.
The read-only live worker returns at most 128 new coefficient changes inline.
Larger new tails stage one unselected generation through acknowledged bounded
pages, with final selection inside the Engine's existing source/control fence.
Reconstructing only a model cache skips a matching already-recorded coefficient
prefix. A local durable owner marker permits cleanup of an interrupted live
stage; it does not authorize selecting an unfinished generation.
The current tables `coefficient_generations`, `coefficient_selection`,
`coefficient_events` and `coefficient_segments` are journaled application data.
There is no sidecar chart history, build/rebuild action, continuous-upkeep setting
or coefficient-history storage budget.

Coefficient charts use indexed reads of the selected main-database history.
Selecting a view, series or date range never starts reconstruction or requires a
verification run. Unsupported inputs, genuine gaps and source provenance remain
visible; current values cannot fill earlier unknown history. A source correction,
history recovery, revert or restore stages the matching coefficient timeline
alongside its complete model checkpoint. Publication atomically selects both.
Pending, failed or abandoned staging leaves the previous model and history in use.
Reuse of an unchanged prefix still requires the current recovery/correction
proofs; delayed work cannot cross source epochs or override newer selections.

**History tools → Check saved learning** is an independent optional
read-only audit. It fixes a durable saved model and exact committed journal
boundary, replays from the supported seed, compares the complete checkpoint and
compares every recorded coefficient change and its quality/evidence semantics
through that same boundary. The target may lag the journal head or live in-memory
model. Results identify the checked journal entry and time, completion time and
source snapshot age, with model and coefficient-history agreement reported
separately. Result applicability is reported independently: a retained matching
transaction proof confirms the selected interpretation, a known source change
makes the earlier result outdated, and a pruned proof leaves applicability
unconfirmed. Compaction alone does not establish a changed interpretation.
Status reads use source metadata and retained checkpoint lookups, not full replay
or history hashing. A match proves reproducibility under the supported inputs and
algorithm, not physical accuracy. A mismatch never repairs the saved model or
recorded timeline automatically. Cold full verification remains proportional to
retained learning history, outside ordinary chart requests and control work.

Model agreement uses the exact canonical checkpoint comparison; it has no
numeric tolerance or additional field exclusions. A mismatch can retain matching
coefficient history while another part of the complete model differs. Per-stream
diagnostics report difference counts, finite maximum numeric deltas and at most
eight schema paths, with dynamic field names redacted. They do not publish saved
or reconstructed household values. Results also identify the replay's Node/V8
versions, platform and CPU architecture. CPU or runtime math differences can be
revealed by exact replay, but this does not establish the cause of a mismatch,
make it successful or exempt it from the F2 reconstruction requirement. Preserve
the source model and journal while investigating; verification never silently
repairs them. The local disposable verification database may retain a complete
comparison checkpoint and must receive the same privacy protection as source data.
Minor numeric-only differences may be classified as consistent with rounding.
This is diagnostic wording, not proof of the cause: the exact full-model result
remains a mismatch. Coefficient-history agreement is reported independently.

Only one verification job runs per instance. Administrators can start, pause,
resume, cancel or discard local verification work on a master or slave;
authenticated chart viewers can inspect status and results. Accepted work outlives
an open page. Requests retain their unique identities across uncertain replies
and are rechecked rather than silently duplicated. The strict action API accepts
only `action` and `requestId`; no chart-preparation or enablement fields exist.

Disposable verification progress, checkpoints, receipts and results live under
`<data directory>/temporary-model-verification/temporary-verification.sqlite`,
with an explanatory README in that owned directory. They live outside `/tmp`,
remain private, and are not essential backups or mirroring inputs. Complete
rolling progress is saved every five minutes of computation and on orderly
pause/shutdown; retain the two latest progress points. A single expensive ordered
entry may exceed this save interval. Restart may resume an interrupted running
job, while explicit pause remains paused. A new verification starts from the seed;
rolling points only resume that same identified run.

Every resumable run binds database identity, input stream, supported algorithm,
learning epoch, selected history, correction revisions and verified journal
prefix, together with its exact Node/V8 versions, platform and CPU architecture.
A runtime change requires discarding the disposable progress and starting a new
seed replay; saved prefixes cannot mix numerical environments. Source correction publication, recovery, revert, restore, divergent source
history or replica replacement that cannot preserve this exact interpretation
supersedes the run; it cannot silently switch to another target. Ordinary forward
learning outside an intact fixed target is not itself a changed interpretation.
Slave verification reads verified local publications in bounded leases and never
retains a main-database read transaction for the whole calculation. No verifier
write changes the source database or confers controller authority.

**Cancel verification** stops the job while retaining its temporary progress and
results for inspection. **Discard temporary verification data** is available only
when its worker is stopped, including a paused worker; it closes remaining handles
before removing the owned temporary data. The main journal, recorded coefficient
history, current model and backups remain intact. Corrupt or incompatible temporary
state is not migrated or trusted. Failures and superseded jobs remain terminal
until an explicit new action; there is no automatic retry loop.

The original coefficient-history change retained journaled layout 30 and the
numerical learning algorithm. The current coverage-evidence format uses layout
31 as described above; numerical learning is unchanged. Incompatible development databases are rejected
before mutation; the runtime adds no upgrade ladder, permanent historical backfill
or old-format reader. Any specifically owner-approved, data-preserving preparation
of an existing installation is an external controlled operation under the exact
foundation exception, not a startup conversion or new supported historical format.

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
Coefficient charts read the recorded timeline reconstructed and atomically
published with the current corrected fireplace revision and the configuration
recorded with each journal entry. They describe reconstructed model history, not
a complete account of every model instance used by past decisions.

If no subsequent learning window consumed a load, removal needs no coefficient
rebuild. Otherwise a worker replays the corrected history while the existing model
continues serving control. Planning uses the corrected fireplace source immediately;
the temporary reserve observer is recalculated using the active coefficients.
The worker catches up new journal entries and must match both source revision and
journal head before the engine atomically publishes its complete checkpoint and
completion status. Newer corrections supersede stale workers. Pending work survives
restart. A failed worker retains the previous model and reports failure; restarting
the service or recording another correction retries it.

## Recovery source corrections

Current-format history recovery uses the same gap merge and ordered model replay
for paired computers and SQLite backups. Each operation records immutable
contribution ownership and source fingerprints. Records that were already local
are not owned by the recovery, and retrying a donor does not duplicate its evidence.
The recovery list includes interrupted operations with accepted contributions.

The recorder can extend a fresh source span without saving another observation.
A frozen donor continuation of the exact same original observation and span
start is additional evidence when its source clock, availability endpoint and report
count advance consistently over every overlapping local prefix. Recovery keeps
the complete donor span as a separately owned contribution; it neither rewrites
the original prefix nor divides an overlapping interval. Positive fresh report
spans are distinct from zero-sample admission boundaries, unavailable transitions
and contradictory observations, which retain the existing conflict rules. Retained
or cached reports and acquisition-only or audit-only inputs cannot establish this
positive fresh continuation.
Required journal references may then resolve to that admitted continuation, so
an intact usable donor window can replace a missing local window.

Coverage readers order actual source intervals by their starts, retaining ID
precedence for contrary transitions at the same start. Equivalent fresh spans
of the same original observation contribute one continuous evidence stream;
the most complete genuine source/availability continuation remains usable even if
its branch has fewer reports. Original report counts are never summed or
rewritten. A later local continuation or post-gap recording retains its original
ownership and cannot be masked by a higher-ID historical recovery row.
Original receipt and deferred-admission clocks remain separate. As-of readers
retain their current endpoint admission rules: a later compact endpoint cannot
hide an independently preserved known endpoint or renew an earlier source clock.

This corrects current evidence capture and recovery reference admission. Existing
committed numerical inputs and the ordered learning update are unchanged; replay
does not re-query these mutable coverage spans to reinterpret saved inputs.
The current algorithm identifier, journal/schema and same-version checkpoints
remain unchanged. No prior algorithm or payload decoder is introduced.

Revert and restore are explicit, reviewed source-selection revisions. Revert
excludes an operation's contributions and dependent learning; it never deletes
original observations, events or journal payloads. Later local recordings and
other accepted recoveries remain selected. Restore reapplies the retained source
where current evidence permits; local evidence acquired in the meantime wins
conflicts. Rejected fingerprints prevent a different snapshot from silently
reintroducing the same source. Logical provenance remains stable across local
record IDs and compact journal projections.

A worker stages exclusions and the affected journal suffix. It reuses a validated
sparse checkpoint and immutable prefix before the earliest affected input, then
replays the current algorithm over the suffix and catches up new learning. These
caches survive transaction compaction; recovery and reversal do not copy the
database or revisit unrelated older measurements. Cache reuse proves that source
selection and corrections leave the prefix unchanged. An early correction or a
missing usable cache can require replay from the supported seed; all required
inputs remain retained. See [SQLite learning recovery](sqlite-journal.md#learning-recovery-and-reversal).
Publication checks
the source selection, fireplace and sensor revisions, authority and journal head,
then atomically selects the new history, epoch, checkpoint and immutable decision.
A concurrent local observation that changes restoration conflicts requires a new
review. Until publication, control and charts retain the prior selection; a failed
revision leaves that selection intact. Published prior epochs and decisions remain
available as evidence. Abandoned unpublished projections may be discarded.

Accepted saves may finish after the restoration worker verifies its snapshot.
Inside the publication transaction, a bounded check can refresh that proof only
across changes which the same verification rules establish cannot change older
conflicts. It checks at most 64 appended observations and 64 coverage rows,
128 stream or cursor entries per set, and 256 KiB each for the proof and current
evidence. It retains original clocks and checks pending receipts becoming eligible
with time. Unknown, relevant or larger changes return to background checking;
they are never truncated or accepted from an unchecked version token. Full
conflict scans remain outside the final writer transaction.

Physical observations can be shared by multiple saved input histories. A revision
is refused if another input's selected journal depends on evidence it would
exclude; changing only the current model would leave that other history incorrect.
Keep the recovery active or use separate databases for those input histories.
Recovery does not silently translate or repair another input's saved journal.

Derived cycle savings and recovery-error claims become unknown when their inputs
or frozen model could depend on rejected learning. Original outcomes, observations
and frozen forecasts remain recorded. Recovery corrections never replay equipment
commands, revert configuration, grant control authority or erase restoration duties.
They correct the retained interpretation, not the physical actions already taken.

## Version discipline

The Home learning algorithm is `committed-house-v17-time-evidence-admission`, with
thermal model version 4. Production starts from a fresh database and an explicit
initial seed. There is no compatibility migration for development databases.

The journal saves the resolved learning configuration, including the relative
ROOM preheat increase, shared recovery-hold duration, source assumptions and
selected-slab priors. The actual ROOM increase respects the native setting limit;
recorded heat delivery remains separate from the requested action. Action evidence
is matched to the hydraulic treatment used throughout charging, reduction and
recovery. Changes to equipment or treatment assumptions invalidate the relevant
action evidence; source/rating and slab changes also clear thermal validation.

One hydronic coefficient acts on routed space-heating compressor heat plus AUX
heat. Compressor thermal and electrical estimates remain separate. Domestic
hot-water production contributes zero to the space-heating thermal input by
explicit simplifying assumption. The optional slab has a persistent latent
state, fixed material capacity, room exchange and ground exchange. Configuring it
allocates selected material from the seeded reserve unless a separate remaining
capacity is supplied. Ending the override does not reset stored heat or remove its
forecast uncertainty. No slab coefficient is fitted automatically.

Fitting requires independent input evidence. Genuine temperature endpoints,
complete source-report coverage and causal thermal warmup are preserved in replay.
Repeated held readings do not add independent fitting targets; the original heat
input windows continue to integrate between reports. Warmup is at least 48 hours
(four reserve time constants, capped at 288 hours). The bounded episode cache
retains that prefix; unsupported initial storage cannot establish fit acceptance.
The recent sample cache and retained episode count remain bounded, with up to two
additional hours of input windows for a delayed genuine endpoint. These are
checkpoint fitting caches, not duplicate source journals.

Configured sensor membership and weights do not change when a reading is missing.
Held values retain their genuine source and receipt clocks, lineage and recorded
report-coverage contract. Required reporting gaps and acquisition failures exclude
those intervals even if telemetry later recovers. A reconnection can end a
transport-only gap only when the genuine reading remains valid and its saved route
matches; it never creates a new temperature observation. Configuration and
reporting-policy changes are recorded at their effective time. One-room estimates
are control-only: no inferred temperature enters the learning journal as an observed
endpoint, trains the thermal/reference learner or supplies validation outcomes.
Journal admission and both learners check explicit estimate provenance as well
as quality flags. An incomplete contributing-room report remains a thermal
barrier even when a numeric endpoint survives beside that coverage failure.
The comfort checkpoint contains one aggregate reference and its bounded continuous
learning state, including supported duration, latest evidence and intervention
settling. Ordered updates preserve the same result across restart and replay.

Sensor changes and reversals are compact immutable journal events. A sensor change
masks only the changed sensor during its settling period and prevents thermal
intervals crossing the boundary. Existing coefficients, validation, completed
episodes and comfort references remain available for gradual recalibration.
Outdoor changes keep unrelated indoor measurements. Current live and committed
outdoor selection uses FMI with Open-Meteo fallback, excluding noisy H66 reports. These source and continuous-reference semantics form the current algorithm;
old development learning checkpoints require a deliberate fresh start, not an
old-algorithm interpreter or automatic migration. Corrected replay uses the same pure
eligibility projection as live learning. It may recover preserved measurements
behind a reversed settling period, but cannot erase actual reporting gaps or
replace original frozen forecasts. Rebuilds pin correction revisions and the
journal head, catch up in the background, and atomically publish a verified
checkpoint while control remains available. Pending rebuilds survive restart.

Changes to numerical interpretation, training selection, corrections, seeds or
fitting rules require an explicit learning algorithm identifier change and replay
tests. Configuration changes are recorded with their digest and snapshot. SQLite
schema versioning is separate from learning algorithm versioning. A journal whose
algorithm is unsupported must be reported as such, never silently reinterpreted.
Historical CSV imports retain their source meaning and timestamps.

Source events are stored once, input projections are derived and rolling state
remains bounded. Do not add repeated full histories, per-minute model snapshots or
comprehensive decision-input archives without an agreed scope and storage budget.
Retrospective firewood benefit remains a read-only estimate under the corrected
model; it is separate from a forecast saved before execution or measured savings.

## Garage control and original history

Garage has no learned heat model or automatic savings planner. Its manual
mode, normal target and warm-up advisory are current device-bound state. The
heat-pump controller and protection sender retain their local
target/protection state independently. Neither a model reset nor a copied
database authorizes commands or manufactures protection reserve. Original
measurements and generic historical journal/events remain unchanged; there is
no old Garage algorithm interpreter or coefficient replay. Home's
reconstruction guarantee above is unchanged.
