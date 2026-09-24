# Model reconstruction, corrections and software versions

This is the agreed engineering contract. Changes to it require the owner's explicit
agreement. The fireplace feature keeps the existing scope of reproducible learning;
it does not add a general archive for reproducing every historical control choice.

## What can be reconstructed

Given an intact committed learning journal, its saved configuration and initial
seed, the selected fireplace and sensor-correction revisions, and the matching
learning algorithm and software, replay must produce the same model checkpoint
at the same committed journal boundary. This includes learned coefficients,
estimated building and slab state, comfort references and learning evidence.
Live learning and reconstruction must use the same ordered entry function.
Checkpoints are replaceable caches with integrity digests and journal cursors;
they are not the only source of model history.

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

The Home learning algorithm is `committed-house-v12-passive-thermal`, with
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
reporting-policy changes are recorded at their effective time.

Sensor changes and reversals are compact immutable journal events. A sensor change
clears the affected measurement evidence; retained coefficients are starting
estimates until independently validated. Corrected replay uses the same pure
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

## Separate Garage learning

`committed-garage-v6-source-clocks` uses Garage's saved seed and current
`garage:<input>` journal. The same ordered update function drives live learning,
checkpoint continuation, source corrections and worker reconstruction. Front and
rear keep their original report clocks. Fresh held reports wait for a joined
interval; each location uses its own elapsed duration and matching observed
ambient/native support. Held reports never add thermal evidence. Frozen validation
uses those same source intervals. Whole-cycle electrical qualification requires
qualified measurements during both OFF and recovery, including measured zero.

Only this current algorithm and `garage-thermal-reserve-v1` state are accepted.
Retired settings, exposure shapes, algorithm seeds and frozen episodes are
rejected with explicit fresh-development-database guidance. There is no old-model
interpreter, exposure converter or archived-episode continuation. Read-only v0.7.5
CSV import remains the only historical software-format boundary and cannot
invent absent front/native/OFF evidence.

Current same-version restart and correction rebuilds retain the frozen episode,
pipe-energy state and actual physical restoration obligation. A corrupt derived
checkpoint can be reconstructed from a valid current journal; physical state is
never cleared as a checkpoint repair. Successful worker publication is atomic,
while a failed write retains the previous checkpoint and revokes Garage pause
permission. Home control remains independent of Garage learning failures.

Door inputs retain their original timestamps and separate live confirmation.
Opening, outage, invalid state or source restart interrupts the known-closed
interval even if it recovers before the next temperature report. Such intervals
do not train or qualify clean thermal validation. Door state does not replace
either independent near-pipe temperature or authorize extra thermal reserve.

Planning retains `garage-protection-limited-opportunities-v2`: contiguous published
price/weather coverage, growing uncertainty beyond measured evidence, short
renewable permission and a fixed original endpoint. Recovery electricity uses an
explicit 125% allowance over at least three hours and 1.25 times the OFF duration.
Completion requires actual temperatures, normal operation and both pipe reserves.
Changed-weather recovery can close as incomplete without savings after the
required continuous warm-native window; its reference reset is a current context
event that replays deterministically.

Permanent room targets remain owner intent rather than native readback. External
room-temperature override must clear before an ordinary power/setting command.
An explicit Normal selection can issue ordinary native ON from unmanaged OFF;
background release only restores an existing managed obligation. Periodic ON alone
cannot discharge possible queued OFF work. See [Garage adapter](garage-adapter.md)
for causal release/expiry/cancellation fences and firmware qualification.

The current thermal solver uses a passive envelope/ground partition and a
positivity-preserving second-order step bounded by every room, reserve and slab
row. Integrated energy uses the same averaged fluxes as state evolution. Model
version 4 and `committed-house-v12-passive-thermal` identify these semantics;
version 3 fits are not reused or converted.

`model.validation` describes the latest sufficiently supported current holdout,
including the retained incumbent when a replacement candidate is rejected.
Contradictory evidence revokes thermal, action and fireplace readiness while
retaining coefficients as an unvalidated fallback. `lastAcceptedValidation`
retains the historical successful check without granting current authority.
Insufficient data alone does not claim a failed check. Error envelopes count
actual sampled endpoints; unsupported shorter horizons inherit a later bound and
a conservative engineering floor, never invented subhour observations.
