# Learning, heating cycles and the chart

The controller compares complete **preheat → reduction → recovery** cycles with
normal heating and feasible shorter reductions. The reference is fixed before
execution. Cheap electricity during reduction alone does not establish a saving;
recovery, comfort and comparable heating service matter too. Offline and synthetic
checks do not establish savings on the installed equipment.

Firewood can be logged using the **Fireplace** icon at the top right of **Home**. See
[fireplace logging](fireplace.md) for corrections, delayed heat and validation gates.

## What learns

The current model has **four learnable thermal responses**: heat loss, combined
compressor/AUX hydronic response, solar response and fireplace response. Heat loss
and hydronic response normally qualify first; solar and fireplace remain priors
until independently supported. Heat exchange and building memory time remain fixed
structural assumptions. Configured source performance and optional slab geometry,
heat allocation and ground exchange are additional **fixed assumptions**, not
hidden fitted coefficients. No automatic storage-response coefficient is fitted.

The combined response is `hydronicCPerKwh`, in °C per estimated **thermal** kWh.
Recorded compressor and reversing-valve timelines first determine space-heating
duty. A fixed manufacturer map converts that duty to heat, and space-heating AUX
heat is added. One learned response then acts on their sum through the slow
building/slab states. Electricity consumption, AUX state and DHW routing remain
separate. This avoids trying to identify two downstream effects of heat entering
the same water circuit when the sources often operate together.

For the standard **DHP-H 10**, the manufacturer gives 9.40 kW thermal and COP 4.24
at B0/W35, and 9.24 kW thermal and COP 3.51 at B0/W45 (0 °C incoming brine;
35/45 °C heating-water outlet). The fixed map is:

```text
Q(T) = 9.40 − 0.016 × (T − 35) kW thermal
P(T) = 9.40/4.24 + ((9.24/3.51 − 9.40/4.24)/10) × (T − 35) kW electrical
Space-heating input = routed compressor duty × Q(T) + routed AUX kW
```

At 40 °C water, 50% compressor duty and 3 kW average AUX give about **7.66 kW
thermal**. Initial `hydronicCPerKwh` is supplied by the shared calibrated
`controller.home_model` defaults; this is an estimate, not a measurement. A shared
coefficient is conditional on this source estimate: a wrong compressor-output map
can bias predictions during AUX operation.

35–45 °C is interpolation; only 30–35 and 45–50 °C use provisional extrapolation.
Automatic preheating requires a known supply temperature and a projected supply
inside 30–50 °C. For degraded observation/model display, missing supply uses the
35 °C reference; out-of-range supply retains its actual value and evaluates the
nearest 30/50 °C boundary with extra uncertainty. The two points
cannot identify a brine correction, so no fitted brine slope is invented. An
unconfirmed installed model, missing brine and departure from the reference increase
uncertainty. Missing live brine remains unknown; B0 is a manufacturer reference,
not an assumed measurement of the installed ground loop. The published electrical boundary includes circulation pumps: the model
must not add the same pumping load twice. Separate DHWR remains separately accounted.
These are performance estimates, not heat/electricity metering. See the
[manufacturer technical data, pages 107–108](https://assets.danfoss.com/documents/latest/29671/AN000086466221en-010701.pdf).
The combined parameter's expandable row explains the shared thermal response.
The **Installed heat-pump model** row holds the source equations, worked example,
manufacturer link and limitations, using the same calculation disclosure as other parameters.

Home includes its learning summary alongside the heating and pause controls.
It shows **Automatic / Paused**, followed by a compact status strip for
heat-pump compressor activity, price control and hot-water circulation. Pump mode
and confirmation appear as secondary text; selecting a value explains its source
and uncertainty. **Schedule & away** and **Manual heating override** follow as folds.
**Heating strategy & comfort** holds
the normal-temperature reference, occupied drop/rise limits, savings preference
and ROOM increase; its closed summary shows the configured average limits. Permanent
preferences still use configuration and **Apply reviewed configuration**. **Home heat model**
follows these controls, with the reconstruction explanation under **Learning outcomes →
Validation & evidence → Reconstructing the model**. Home reports
counts of usable observations and accepted model updates. These counts describe
current evidence; missing values remain unknown and no completion percentage is
inferred. The **Home heat model** summary opens learning details. Garage has manual
temperatures and independent local protection, with no learned heat model.
The Home model explains its role before the nested sections: it estimates a
response, planning combines that response with prices and comfort or protection
requirements, and control sends the allowed commands. Links lead back to Home's
heating strategy and current decision. The three closed sections are:

- **Learning outcomes · Estimates & checks**: results and validation evidence
  used to assess forecasts. Calculated savings use a modeled alternative, so even
  a qualified electricity measurement does not make the comparison metered savings.
- **Model inputs · Recorded & estimated**: source observations and derived inputs
  used for fitting, validation and forecasts. The rows list input definitions and
  units, with values in the chart.
- **Model coefficients · Learned & assumed**: current responses and assumptions
  that turn inputs into predictions. Initial estimates, accepted or retained fits,
  observed averages and fixed assumptions keep their own provenance.

**Heat balance, calibration & history → Initial model** explains the configured
starting thermal, internal-gain, weather/runtime and uncertainty estimates.
Starting estimates support bounded planning; loading them establishes no new local
observation or passed independent validation. Covered automatic, manual and
interrupted treatments can refine response estimates before later checks qualify
them. Response and advance checks must match the same hydraulic treatment.
**Heating strategy & comfort** keeps the learning-trial reservation calculation
with the monetary rules. Readiness, allowance, useful demand and permission are
separate; an active cycle can block a new trial without having spent the daily
allowance. Unknown allowance remains unavailable rather than appearing as zero.

These sections use expandable rows: the name, value or unit, and provenance stay visible;
explanations and supporting evidence open underneath. Inputs and coefficients are grouped by
their role. **Validation & evidence** keeps detailed checks alongside the outcomes without
equating conditional temperature, equipment-response and frozen-forecast checks with
cycle validation. Status refreshes preserve open explanations,
keyboard focus and the sensor-change forms within Home's temperature inputs.
Dense completed heating windows retain their complete input segments and original
clocks. Their journal append uses storage-worker admission, keeping large valid
windows off the controller's bounded write path without changing their stored
format, interpretation or reconstruction inputs.
Current coefficients include their value, unit, explanation and provenance:
fitted in the accepted model, retained while awaiting evidence, initial estimate
or fixed building assumption. The current-value display uses the existing learning
state. Four **Model coefficients · Calculated** chart choices show historical heat
loss, combined hydronic response, solar response and fireplace response. Fixed
building, background-heat, demand, initial action/forecast, source and slab
assumptions have separate informational rows. Background heat is configured in
°C/h, defaults to zero and remains fixed during local fitting; it is not a
measured household heat input. Initial response ratios and trajectory allowance
are fallbacks that observed treatment response and later trajectory checks can
replace independently.

Coefficient charts read the four histories recorded with committed learning in
the main database. Normal learning captures every coefficient change from its
ordered input updates, with initial, fitted or retained status and source
evidence. Selecting a coefficient view or individual series never starts journal
replay and requires no preparation or enablement setting. A separate optional
verification under History tools does not gate chart availability.

The selected learning algorithm, saved configuration, seed, firewood and
sensor-change revisions and recovered-history selection define each history.
Journal order is preserved, including late episodes. Each coefficient is a
stepped line with its original provenance in the tooltip; unsupported or missing
inputs remain gaps. The live learner, imported history and simulation retain
separate provenance. Earlier intervals never receive today's coefficient values;
ROOM-only observations remain separate from confirmed floor charging.

A source correction, recovery, revert or restore atomically selects the model and
its matching coefficient history. Until successful publication, charts keep the
prior selected interpretation. Unchanged prefixes remain reusable; a stale worker
cannot mix generations or publish against a newer selection. Coefficient history
is included in normal main-database backups, exports and mirroring. It uses compact
change points rather than additional per-minute model snapshots.
The **View** menu groups compatible comparisons with their relevant temperature
context and labeled activity rows. Saved temperatures and references, thermal
inputs, electrical inputs, activity fractions and coefficients keep their own
units and meanings. Home coefficients follow the selected recorded learning history. **Series explorer** can isolate every
supported saved input or coefficient by its label or signal identifier. The
shared electricity-price controls remain available across views. Observed
temperature history stays distinct from the original normalized inputs used
for learning.

Observed thermal drivers are outdoor temperature, archived solar radiation,
the estimated combined hydronic heat, derived from space-heating compressor duty
and space-heating auxiliary power. The original source inputs remain visible. The configured
average of Upstairs, Bedroom and Downstairs is the live indoor state and prediction
target, with fixed configured membership and weights. Missing contributing
readings leave measured gaps; imported CSV learning retains its original Upstairs input.
The model learns one normal-temperature reference directly from the fixed weighted
indoor average. Default weights are Bedroom 50%, Downstairs 25% and Upstairs 25%;
`controller.indoor_sensor_weights` can override them. Occupied maximum drop and rise,
forecast checks, discomfort costs and recovery use this same average. Individual
rooms remain visible but have no separate learned reference or veto. See
[indoor temperatures](temperature-sensors.md) for source evidence, the bounded
one-room control estimate and sensor changes in **Average indoor** input details.
Requested phase, ROOM boost and comfort target describe control context; they do
not create a direct heat credit. The **Model inputs · Calculated** axes retain the
indoor endpoint, original source inputs and control context exactly as saved in the
learning journal. Combined hydronic heat and actual pooled floor-valve mode have
separate views; unknown and partial valve confirmation remain distinct. These new
inputs are not retroactively filled into older records.
**Manually recorded firewood additions** markers and calculated **Fireplace release input** provide
two additional input views from the corrected source-event history. Fireplace
response evidence appears alongside the coefficient. Daily estimated firewood cost
and electricity savings are available under **Learning outcomes · Calculated**;
their paired normal-heating reference and separate electrical validation are
explained in [fireplace logging](fireplace.md#visibility-and-estimated-savings).

Only outdoor temperature and solar radiation are weather inputs. Current outdoor
source priority is FMI station, then Open-Meteo. Solar remains an archived
forecast from FMI with Open-Meteo backup, never a claimed radiation observation.
The forecast available at the start of a completed interval supplies its solar
input. Missing radiation remains unknown and adds uncertainty. No wind, cloud or
sun-angle pseudo-observations are invented.

Held readings are not independent new sensor observations. Genuine report lineage
limits which temperature changes supply new fitting evidence, while integrated
heat inputs retain their complete elapsed time. Fitting scores temperatures along later trajectories, separated from training
by a 12-hour embargo. It compares the candidate with the previous model and holding
the initial temperature. Missing intervals close and score preceding usable
fragments; complete short cycles receive their own checks. A dip followed by a
return to the initial temperature cannot score zero error. Coefficient eligibility
requires independent observed variation and sensitivity, not merely many rows.

Garage temperature freshness is enforced locally by the heat-pump controller.
Native BTHome receipt times distinguish new reports from cache reads. ST-MQ
does not renew Garage temperature leases or run its pipe model; see [Garage
control](garage.md).

Three kinds of evidence remain distinct:

1. **Conditional thermal validation** supplies observed heat input and checks
   temperature trajectories.
2. **Equipment-response validation** checks compressor duty under requested modes
   on distinct completed episodes. This check uses recorded room/weather context.
3. **Advance cycle validation** compares frozen predictions with subsequent
   temperature and attributable space-heating energy. It never substitutes actual
   future compressor duty into an advance forecast.

These three checks qualify learned accuracy; they are not prerequisites for
all operation. A fresh database starts with explicit initial thermal and native
response estimates. It may plan preheating, reduction and recovery when the
paired complete-cycle cost scenarios and current comfort/equipment limits permit.
The estimates never create passed trials, measured heat or validated forecasts.
Current configuration bounds every action; pending plans are rechecked before
execution. Missing preheat evidence does not prohibit a bounded preheat trial.

Before the learned reference exists, a measured occupied Normal average can
supply a separately labelled startup planning reference. Its scope includes the
equipment and sensor configuration. It remains fixed during an intervention and
does not train or replace the learned comfort reference. Configured comfort
limits apply from startup. Manual, Away and material fireplace periods cannot seed it.

The normal indoor reference starts after one supported hour of occupied Normal
heating and refines continuously with a 48-hour smoothing timescale and a 1°C
innovation bound. The reference remains provisional until 24 hours are supported by verified heating. Verified recent
space heating includes normal compressor-off cycles; weather-inferred demand is
provisional and used only when native evidence is unavailable. There is no rare
plateau requirement. Small source outages pause progress rather than erase it.

Controller preheat, reduction and recovery, Away and material logged fireplace
influence do not update the reference. Two Normal hours after an intervention let
its effects settle. Persistent household thermostat changes can move the reference
both down and up. Original report support and last adjustment have separate clocks;
repeated polling earns no learning. Missing-room estimates remain control-only and
never train the model/reference or fill history. Provisional reference quality
is disclosed without imposing a separate startup drop cap.
See the [reference policy](temperature-sensors.md#normal-temperature-reference).

## Model reconstruction

The model can be reconstructed exactly at a committed journal boundary when its
complete learning journal, saved seed and configuration, selected fireplace and
sensor-correction revisions, and matching algorithm and software are retained.
Replay uses the same ordered updates as live learning. It restores the model
checkpoint, including coefficients, estimated building and slab state, comfort
references and learning evidence. Selecting corrected source events instead
produces a corrected model; it need not match the model used before that correction.

**History tools → Check saved learning**
performs an independent seed replay and compares the complete result and all four
recorded coefficient timelines with a fixed durable model checkpoint and its
matching saved history. That boundary may lag the live in-memory model and latest
journal entry. The result names the checked journal boundary and time, reports
model agreement separately from history agreement, and shows source snapshot age.
A match establishes reproducibility, not physical accuracy or validation of later
learning. A mismatch is reported without replacing the controlling model or
silently repairing saved history. Exact model comparison has no numeric tolerance.
Its compact per-stream diagnostics show difference counts, up to eight schema
paths and optional maximum numeric deltas without exposing raw saved or replayed
values. The replay runtime and CPU architecture help investigate numerical
differences; they do not turn a mismatch into a match or relax the reconstruction
requirement. Preserve the source model and journal when investigating a mismatch.
The UI can identify minor numerical differences as consistent with rounding;
this diagnostic classification leaves the exact model comparison as a mismatch.
It does not change the independently reported coefficient-history result.

Verification runs locally on either role with pause/resume/cancel controls.
Temporary progress survives interruption in the application's data directory;
explicitly paused work stays paused after restart. A changed source interpretation
supersedes the run rather than resuming under different inputs. After the worker
stops, **Discard temporary verification data** removes its progress and results
without affecting the main database or coefficient charts. Verification is optional
and never runs because a chart was selected.

Keep a consistent backup of the full SQLite database and the corresponding
software version. A temperature or telemetry CSV export alone is insufficient.
Discarded raw polls and missing history cannot be recreated. Exact replay of every
past control decision is outside this scope: transient provider inputs and complete
controller snapshots are not archived. Recorded commands and outcomes remain
useful evidence, but replay cannot prove physical receipt of a command, recreate
an unrecorded outcome or make estimated savings into measured savings. See the
[reconstruction contract](reconstruction-and-versioning.md) for the exact scope.

## Planning and recovery

Home's heating-plan row opens the [Heating plan explorer](heating-plan-explorer.md).
It uses this same planner to explain limiting constraints and compare changes to
duration, comfort and preheat preferences on a fixed snapshot. Family can simulate;
admins can explicitly apply eligible preferences to one upcoming cycle. A higher
ceiling does not create evidence for a longer reduction. Simulations never train
the model; approved executions retain their context in the ordinary cycle and
learning records, subject to the same completion and validation checks.

Each candidate prices preheat, reduction, recovery and remaining heat debt under
the same price/weather outlook. Electricity price belongs in this objective, not
in the thermal coefficients. The fixed compressor performance map and nominal auxiliary estimates
remain estimates; property consumption minus charging is never heat-pump metering.
DHW is separately attributed where routing is known. Its demand and tank recovery
are not counterfactually modeled, so the space-heating comparison cannot claim
whole-cycle savings.

Tariff reduction changes native demand; it does not stop the compressor or reduce
its physical capacity. Observed native demand can imply full compressor duty during
reduction. Current integral and supply-target readings apply only to the currently
observed phase and a short projection. Unknown tariff response starts from unchanged
normal demand with explicit uncertainty. Episode evidence can subsequently change
that response. A stored pending schedule is re-evaluated before it starts.
Native demand trends use advancing native report clocks within the same treatment
and unchanged water target. A commanded target step, changed native operating
state or repeated controller poll supplies no new derivative; current point
readings and all comfort checks remain available. Each derivative can project
only through its original endpoint plus the measured report span; polling does
not renew that endpoint. Beyond it, native demand is unknown and the model uses
its demand prior. Native integral, water shortfall and their AUX risk apply only
to the observed phase, including in the separate Normal counterfactual. Short
water-temperature transitions after DHW cannot become an hour of asserted AUX
demand. Conservative preheat stress checks and observed AUX remain independent.

Preheating requests one configured **ROOM increase above the saved normal setting**,
default **+5 °C** (`controller.preheat_room_boost_c`), and one pooled override across
configured floor channels. The request stays within the verified native upper
bound; repeated commands use the saved baseline and never stack increases.
ROOM is a native demand setting, not a room-air target. Thermostat-limited loops need
fresh override evidence; baseline and permanently open paths do not establish
successful charging of newly opened circuits. Normal DHWR continues on its own
schedule during preheat. The space-heating model assumes **zero room heat from
the DHW tank, hot-water use and recirculation losses**. This simplification does
not mean that physical losses are zero. Hot-water service and whole-house savings
remain outside the space-heating benefit claim. The future
supply estimate adds 3 °C per degree of ROOM increase to the current supply. This
is a fixed planning assumption, not a learned heating curve or a native forecast;
projected temperatures outside the provisional source-map range reject preheat.
Occupied indoor-average maximum drop and rise both default to **1.5 °C** around
the single normal reference; savings preference never changes these hard limits.
An automatic cycle keeps its original treatment identity through reduction and
recovery, separately from actual valve mode after the override closes.

The selected slab exists in both valve modes. Its modeled temperature persists
when relays turn off, and heat allocation changes without inventing new heat or
capacity. Initial selected capacity is carved out of the effective reserve budget.
Ground exchange uses a separate configured slow boundary and a passive
slab-to-ground path. The envelope coefficient then describes above-ground loss; no baseline ground loss is subtracted.
Material kWh/K describes sensible capacity at uniform temperature, not how much
can be charged during a short period or how much electricity a cycle saves.
Room-only observations cannot identify all these fixed quantities at once. Public
defaults leave the explicit slab disabled until its physical priors are configured.
Automatic floor-preheat candidates require a configured slab within the reserve
capacity budget; a deliberate manual override uses commissioned device authority
without pretending its thermal behavior is already validated.
The single SONOFF 4CH PRO R3 covers the four ground-floor circuits through its
versioned MQTT lease adapter. Activation requires configured identity, physical
commissioning, fresh correlated GPIO feedback and current control authority.
Individual manual masks remain separate from pooled treatment evidence; GPIO
readback does not prove relay-contact operation, valve movement or water flow. See
[Home floor preheating](floor-preheat.md) for the circuit mapping and required
control behavior.

Home's **Heating strategy & comfort** separates the decision policy from the
**Home heat model**. **Savings strategy** offers **Gentle**, **Balanced**
and **More savings** (default), retaining at least 60%, 80% or 100% of the best
eligible positive conservative saving. These choices change only that retention
percentage; monetary preferences remain independent. They do not relax hard
occupied-average upper/lower bounds for ordinary automation. An explicitly
reviewed manual cycle may override those policy limits without changing defaults;
see the [manual planner](heating-plan-explorer.md#use-a-scenario-for-one-cycle).
The dashboard status includes model, reference and evidence metadata; raw fitting
samples and episode archives remain in learning/replay storage rather than every
status response. This does not remove observations or reconstruction inputs.

Cycle evidence is appended as immutable intervals with one shared provenance
group per sample. A compact header holds current totals and execution state;
the original model, plan and forecast are saved once. Recovery comparison advances
incrementally, and final assessments stream the complete evidence in bounded
pages through the live learning worker. A longer cycle retains all evidence
without repeatedly rewriting or replaying its earlier intervals. The configured
recovery timeout starts when the executed reduction ends. If preheat is cancelled before
reduction starts, no reduction is recorded or displayed. The later native
recovery execution keeps its own clock; dispatch latency cannot become a short
reduction period.

The planner uses the same weighted indoor
average for prediction, limits and discomfort in every path, including bounded
trials and recovery. Individual rooms have no automatic veto. An admitted
one-room estimate adds its uncertainty to control and forecasts, and cannot start
a new learning trial. Configuration changes use **Apply
configuration**. No strategy promises an annual savings percentage.

Forecast validation is scoped to the executed treatment and its observed preheat
setting, preheat duration and reduction duration. Pure reductions do not validate
coupled preheating. Frozen predictions retain their originating algorithm;
observations from an earlier predictor remain useful for physical response and
measured energy, but its forecast errors do not certify or recalibrate a newer
predictor. Observed response ratios may exceed two when real compressor runtime
contradicts a small Normal-demand estimate; physical duty remains bounded to
zero through one.

A new cycle's conservative benefit must exceed the configured minimum saving,
plus the temperature deviation, cycle start and duration penalties. All four
default to zero, independently of strategy; the temperature penalty measures
extra hot/cold °C²-hours of the weighted indoor average compared with Normal.
These defaults are explicitly overridable through the monetary policy fields in
[configuration](configuration.md#heating-strategies-and-limits), including zero;
configured comfort limits and physical stress checks still apply. Continuation excludes
a positive minimum saving and the cycle start penalty. A reviewed negative minimum
remains applicable, along with temperature deviation and duration penalties.
Among admitted choices, the mildest retaining
at least 60%, 80% or 100% of the best positive conservative benefit is selected,
ordered by configured temperature deviation penalty then combined preheat and
reduction duration. With a zero temperature penalty, duration decides. For an
explicitly reviewed manual minimum below zero that admits estimated extra cost, the retention
threshold is `best - (1 - retained_fraction) × abs(best)`, which also handles a
negative best benefit.
Gentle can still start a sufficiently worthwhile cycle. Use **Paused** to suspend economic control. Garage uses permanent manual targets instead; see [Garage heating](garage.md).

These decision rules consume the heat model's thermal predictions, uncertainty
and action evidence. They are not fitted model coefficients: choosing another
strategy does not alter the learning process or create missing evidence.

During Home **Away**, native heat-pump protection supplies temperature protection.
The application adds no absolute indoor minimum, for either economic plans or
learning trials. Occupied average-temperature limits resume at the configured
return time; trial screening includes the recovery period around that return.
Equipment readiness, bounded trial costs and restoration remain required.
Lower service during Away is not counted as evidence of occupied-operation savings.

## Accepted schedules and continuation

An accepted Home cycle is durable intent. Missing information retains its schedule
and last valid estimates; it does not select Normal, recovery or cancellation.
This applies to automatic savings cycles, learning trials and explicitly approved
one-cycle scenarios, including restart, model reconstruction and command failures.
A retained estimate keeps its original source clocks and remains an assumption,
never a new observation or a learning sample. Native device readiness, equipment
identity, current control authority and restoration duties still govern commands.
A blocked command is distinct from a cancelled plan.
In particular, waiting for the original heating-command identity after restart
or handover preserves Automatic permission and the accepted cycle. It does not
grant permission to command an unavailable or replacement device. Missing live
identity is neither a saved Pause nor a confirmed equipment change.

The original forecast and cycle definition remain immutable. The execution
schedule and up to sixteen recent adjustments describe the current remaining
intent; committed execution intervals retain the complete actual phase history.
Once recovery starts, a real reduction's executed end follows that committed
recovery boundary. Later duration-limit checks cannot lengthen ended treatment.
Reconciliation preserves the original plan and recovery deadlines and records an
adjustment; cancelled preheat retains its zero-length reduction.
Missing temperature, energy or routing evidence can leave an outcome unassessed
without ending control. A long observation gap is recorded as missing coverage,
not extrapolated measured consumption. Recovery assessment and its timeout never
extend native setting restrictions.

| Condition | Controller consequence |
| --- | --- |
| No accepted schedule and insufficient inputs | No new economic action; ordinary service and owned restoration remain available. |
| Search/worker/provider/model input unavailable | Retain the accepted schedule and its original deadlines. |
| Full remaining preheat would exceed its allowance | Search a shorter or differently placed remaining window; retain reduction. |
| Heat already delivered predicts exceeding the upper limit after removing preheat now | End the boost, retain reduction and use Normal during any scheduled gap. |
| Warmth during reduction | No upper-temperature veto on reduction. |
| Delivered cooling requires ending reduction to protect the configured lower bound | End reduction and recover. |
| Complete economic comparison favors ending treatment | End treatment, including restoration and recovery in both alternatives. |
| Economic comparison absent or equal | Keep the accepted schedule. |
| Updated trial exposure exceeds its reservation/cap | Report exposure; this alone does not establish that cancellation saves money. |
| Command pending, busy, unsent or unconfirmed | Retain intent and reconcile execution/readback through the existing executor. |
| Explicit manual instruction, revoked authority, confirmed native conflict or equipment fault | Respect its scope and preserve unresolved restoration duties. |
| Restart/reconnection | Reconcile the original equipment and execute the currently due feasible phase. Never replay missed heating or extend deadlines. |
| Fixed phase/recovery-hold deadline | Advance the schedule and restore owned settings independently of assessment availability. |

The live preheat stop uses the central delayed-peak prediction after removing the
boost now, including stored building/slab heat and the intended reduction. It
adds no command-delay allowance, uncertainty padding or hypothetical remaining
preheat. The lower-limit stop similarly tests removal of reduction now. Unknown
projection coverage cannot become a new temperature veto.

The single background planning worker searches new cycles and compares remaining
cycles; it has no command authority. Once accepted, the reduction window is
retained. A bounded remaining-window search can stop optional preheat, shorten it,
move it nearer reduction or choose an earlier cheaper window. It includes the
incumbent, existing duration grid and bounded price-boundary endpoints; it is not
a proof of a global optimum. Already executed preheat counts against the total
configured duration, including across pauses and restart. Floor windows obtain
separate leases through confirmed release/acquisition; no native lease is extended
by changing its original meaning.

Comparisons run every fifteen minutes or after meaningful changed numerical
sources, thermal state or policy, at most once per minute. Results must match
current owner, schedule, model, configuration, sources and thermal state and be no
older than two minutes. A stale, failed or empty result preserves intent. A
Normal-heating gap remains part of the cycle and does not start recovery.

Economic cancellation compares the best remaining feasible cycle with ending
now, from the same current state and future horizon, including auxiliary energy,
restoration, recovery and remaining heat debt. Sunk costs are common to both paths.
No new-cycle start penalty or positive minimum-saving hurdle is charged again.
An explicitly authorized negative minimum and the originally accepted extra cost
of a paid learning experiment retain their intended service value; a comparison
must improve on that accepted tradeoff rather than repeatedly reject its known
initial cost. Missing inputs grant no new economic cancellation verdict.


New-cycle selection and admission share paired stress scenarios for action and
reference: heat response and loss ±15%, initial reserve/slab ±0.5 °C, compressor
duty ±0.08, source electrical input within its operating-point allowance, and AUX
exposure ±50%. A minimum savings uncertainty deduction is configurable and defaults
to zero. It is a floor on the stress-case deduction, rather than an amount
added on top of it. These cases are not
statistical confidence bounds. Forward temperature bounds begin with conditional
trajectory error and add engineering allowances for the source estimate, unknown
action, missing solar, fireplace response and optional slab. The separately
calculated duty-response error does not make those bounds calibrated probabilities;
frozen forecasts still need independent later-outcome checks. The bounded search
retains large price windows alongside shorter peaks and recovery-price contrasts,
and explores different preheat/reduction combinations. It checks up to 16 nominal
reduction-only candidates and 16 coupled preheat candidates independently of the
preference, so either family can win the full-cycle comparison. It does not
establish a global optimum.
Equipment duty ratios and AUX exposure calibration remain separate adaptive
quantities. Saved nominal compressor kW and recovery multipliers remain reporting
diagnostics; they do not replace the fixed source electrical-input map.

The floor integration must provide a **device-local 15-minute lease**, renewed
every **5 minutes** while the heating cycle remains authorized and capped at the
planned end. It must release the override after a controller crash or lost
connection without depending on a later host command. This capability is a
requirement for the planned device, not verified behavior. Commissioned OFF
wiring must return authority to the room thermostats; stored heat can still
release afterward. Device readback and lease/timer verification remain separate
from command acknowledgement. Relay readback does not measure valve movement,
water flow or delivered heat. Local expiry can release only the valve overrides:
H66 ROOM has no device-side lease and relies on durable application restoration
and retries after communication returns. All four ground-floor circuits form one
treatment and one selected-slab state for learning.
Cycle assessment accepts a confirmed OFF release at or after the effective
preheat deadline while the heat pump is still acknowledging its next phase.
An early release, unknown or partial floor state, or different treatment remains
unassessed; the original phase and readback evidence is retained.

Initial or learned estimates support ordinary economic action before new trials
exist. Additional learning experiments require usable temperature/equipment
evidence, enabled trials and remaining allowance. Configured floor equipment
also needs a known output mode, including for reduction-only trials; an explicit
physical floor model requires an ON/OFF mode. Unknown and partial output remains
recorded and cannot admit a new learning trial whose complete stored-heat
assessment would be unavailable. A previously admitted trial retains its intent
and last valid planning assumptions when observation feeds become unavailable. An installation without floor equipment gains
no additional observation prerequisite. The controller
seeks four useful trial opportunities per Finnish day by default, prioritizing
learning before that target. This is an objective, not a promise to act through a
blocked condition. Configured reduction ceilings also bound initial trials;
there is no fixed half-hour bootstrap ceiling. A bounded summary of the last
48 hours of committed Normal space-heating coverage supplies typical runs and
demand, excluding DHW, gaps, interventions and meaningful fireplace heat. Forecast
indoor/outdoor temperature differences adjust the expected demand. The shortest
admissible window must expose a representative run; without three complete
recorded cycles, the unvalidated Normal forecast must supply at least 15 minutes
of expected compressor operation. Starting during an observed space-heating run
can use a shorter window. A window without useful demand is skipped, not counted
as learning. Successful checked coverage is extended when a longer useful trial
fits the limits.

A no-heat cooling scenario must fit comfort allowances. Trial costs compare the
complete action cycle with Normal under paired physical scenarios and reduction
response ranging from unchanged demand to complete suppression. Screening uses
the maximum additional space-heating cost, including recovery and priced remaining
heat debt, rather than charging the entire rated-power recovery as extra spending.
Native AUX restrictions and included circulation are respected. A nominal zero
does not remove scenario uncertainty, but alternatives consuming nothing in every
scenario have no arbitrary minimum charge. Preheat trials also test full compressor and permitted rated AUX heat during charging, followed by native demand until the delayed room peak is covered. Weighted-average upper limits and uncertain valve states can block a trial even when its cooling limit passes. These are stress estimates, not
guarantees that fallback costs cannot exceed the allowance.

During an active trial, the initial exposure estimate is a reservation, not the
per-cycle spending cap. The cycle retains that original forecast and keeps its
current reservation and last complete-cycle exposure estimate separately. The
estimate combines the recorded attributable space-heating cost difference so far
with the remaining action and Normal forecasts. Three physical scenarios carry
their own observed and counterfactual stored-heat states; remaining heat debt does
not disappear when a new forecast starts. Estimated compressor input shares the
Normal source uncertainty, while recorded AUX output stays fixed. Negative-price
income forgone is accumulated separately across the recorded and remaining parts.
Only the final full-cycle cost difference is clipped at zero; earlier gains and
costs keep their signs, and DHW/DHWR service is excluded.

The reservation is the highest complete-cycle estimate seen, including the
original displaced-saving reservation. Only an increase above that reservation
needs additional per-cycle and daily allowance. Decreases give no refund, and
returning to an earlier estimate cannot repeatedly spend the same allowance.
Three bounded RAM cursors update from new recorded intervals; missing cursors
rebuild through the existing paged cycle worker, without a second evidence archive
or a whole-cycle traversal on each control tick. Unknown or stale cost, routing,
price or stored-heat evidence retains the accepted schedule; it does not authorize
a new trial or a new economic cancellation.
The reservation and daily ledger commit
together, including at initial cycle recording. An automatic trial spanning
midnight remains funded by its Finnish start day. An explicitly edited reviewed
one-cycle budget remains separate from the automatic daily ledger; unchanged
reviewed budgets retain automatic admission restrictions. Unknown exposure cannot
authorize a new trial; an existing trial retains its accepted schedule. These are conservative estimated exposure reservations, not measured
additional electricity bills. Known exposure above the funded reservation is
tracked separately, without repeatedly charging forecast oscillations. Automatic
unfunded exposure reduces the start-day allowance for later trials; a separately
reviewed budget does not consume the automatic ledger. An overrun alone never
proves that ending the current cycle costs less. Comfort, native protection and
restoration checks still apply independently.

Disabling learning
trials disables additional experimentation; ordinary economic plans still use
the initial or learned model. The daily target prioritizes informative learning
and is not a cap: cheap useful opportunities may continue within the allowance.
Completed recovery permits a new independent cycle without a fixed six-hour wait.
Incomplete attempts impose no fixed learning cooldown; actual adapter restoration
and current readiness remain separate requirements.
Preheat trials are eligible from startup through the configured preheat ceiling;
there is no separate initial-duration cap. Selection prioritizes treatment types
with less response evidence, then predicted thermal/compressor contrast and cost.
Unexecuted promises are not counted as learning episodes.

Starting response estimates are replaced by equally weighted covered-episode
estimates as observations arrive; fixed seed weight does not preserve an
optimistic reduction effect against observed unchanged demand. Independent
validation remains separate from this immediate adaptation.

Immediate response adaptation uses all covered treatments, including closed
manual and interrupted episodes, without labelling recently seen temperatures as
an independent holdout. A new preheat does not disappear from learning because
earlier reduction episodes filled a global validation quota. Independent response
checks use the thermal fitter's chronological training/validation split. Existing
checks remain applicable when the response estimate is unchanged; a changed
estimate adapts immediately and does not borrow the earlier check.
DHW-diverted intervals remain in the thermal history; their zero space-heating
input cannot demonstrate suppression caused by a reduction request.

Normal AUX forecasting uses recent recorded Normal space-heating AUX use when
available, alongside native-threshold and recovery-risk estimates. Missing
Normal AUX evidence creates no assumed continuous consumption or savings credit.
The observed Normal mean is not multiplied again by recovery-risk calibration.

Trial cost screening also includes the income that may be lost by reducing
scenario consumption during negative all-in prices. Negative prices cannot make
that exposure disappear from the trial allowance. Daily attempts, completions,
comparable space-heating assessments and accepted model updates remain separate;
compressor runtime across an attempt includes recovery and does not prove how
much heating was displaced. Daily counts come from recorded actual cycles and
survive restart. Initial-model and continuous-learning interpretation uses the current versioned learning journal.

Recovery restores normal ROOM and tariff operation while applying one shared
**60-minute hold** (`controller.recovery_hold_minutes`). Until its fixed deadline,
DHW start stays at the lower of 45 °C and its normal setting, the stop register
stays at 50 °C, new automatic DHWR pulses are suppressed and AUX is restricted.
The stop register may govern AUX operation only; this is not an established 50 °C
compressor cutoff. The hour is an initial engineering choice, not a learned
recovery duration.

Cold-average protection releases AUX permission early without restoring the DHW
settings or restarting circulation. Recovery uses its explicit configured
`recovery_comfort_margin_c` preference (default 0.5 °C) and a thirty-minute
falling-trend projection where available; this controls AUX permission during
recovery and never cancels reduction or an entire cycle. The planner includes
this service preference in recovery costs. Unavailable temperature evidence
retains the last AUX decision. The AUX fallback remains latched for the cycle. Native AUX permission applies to the pump as a whole,
not exclusively to space heating. `recovery_compressor_only: false` disables
the AUX restriction while retaining the timed hot-water hold.

At the original deadline, normal DHW and operating-mode settings restore and
scheduled DHWR eligibility resumes even if thermal recovery assessment continues.
Resuming eligibility does not force a circulation pulse. The deadline does not
restart on each controller update. Restoration obligations survive interruption;
loss of control can require earlier full restoration. Separate transports do not
guarantee atomic compressor switching.

For hot water before the deadline, use **Paused**, which selects
Normal heating and restores the captured native DHW settings. Start a timed
circulation run if needed. **Normal heating** in Manual heating override also
restores the owned tariff, DHW and auxiliary settings through the same phase path.
App native-parameter edits require pausing an active cycle. A setting changed
directly on the heat pump is respected rather than overwritten by the hold.

Completion requires comparable room temperature, native reserve and selected slab state when configured, reconstructed
under the **frozen cycle model**, held for one hour. A newly fitted warmer reserve
cannot make an older cycle complete. Missing thermal evidence prevents a reserve
claim. Gaps/timeouts produce incomplete attempts, which remain visible with their
covered costs and missing-data counts.

## Historical learning values

The chart and **Learning outcomes · Calculated** use the same assessments. Means cover the latest
30 completed cycles with attributable space-heating evidence. A separate overview
includes all of the latest 100 attempts, including incomplete and active cycles.
A missing result is unavailable, not zero.

| Chart choice | Meaning |
| --- | --- |
| Assessed space-heating benefit, €/cycle | Modeled reference space-heating cost minus attributable execution cost including recovery. DHW service excluded; not a whole-cycle savings claim. |
| Benefit with auxiliary recovery, €/cycle | The same estimate for completed cycles with observed space-heating AUX during recovery. DHW-only AUX and unknown routing do not qualify. |
| Space-heating recovery prediction error, €/cycle | Original recovery forecast error over the observed recovery period. A changed schedule does not count as an error of the abandoned forecast. |
| Normal indoor temperature, °C | Learned normal occupied heating reference, independent of temporary ROOM boosts. |

Values retain assessment time, cycle count, basis and model version. Later model
updates do not rewrite earlier chart points. Model input axes read saved journal
intervals, preserve nulls and transitions, and do not rerun today's model on history.

## H66 readbacks and commands

In the dashboard, expand **Home** for **Heating control** and equipment details.
Under **Sensors & Equipment**, the **Ground-source heat pump** overview contains
**Adjust heat-pump parameters**, followed by the **All heat-pump readings** fold.
Readings are grouped into heating, ground loop, hot water, equipment states,
settings and runtime counters. Each has a reported value and a short description;
select a value for freshness, receipt time and any requested or original setting.
**Adjust heat-pump parameters** changes the pump's native ROOM, hot-water start,
hot-water stop or operating mode until deliberately changed again. These device
settings come from fresh pump readback, have no dashboard expiry, and remain the
baseline for later automatic heating adjustments. Restarting reads the pump; it
does not replay an old dashboard value or restore a previous native setting.
Controller configuration remains separate from these native device settings.

All four native settings share one confirmation path: up to ten seconds for
dispatch, then thirty seconds after the actual MQTT write for committed matching
readback. Temporary changes remain bounded by their original expiry. A timeout
does not trigger another write. A later fresh matching report settles the same
request, clears its timeout and preserves its original request and dispatch clocks.
Known unsent requests cannot be confirmed by an unrelated matching report.

**Manual heating override** actions share the automatic phase equipment behavior.
Starting Pause releases automatic heating and Normal/Reduced reassessment windows.
An explicit Preheat lease started in Automatic keeps its original deadline when
Automatic is paused; Normal or Reduced can end it sooner. Preheat selected during
a Pause also ends when that Pause ends. Normal and Reduced selected during Pause
stay until another selection, Automatic, or the optional resume time. In Automatic they are
reassessed on the next update. Manual buttons stay disabled while a heating
transition is running, including follow-up work after an accepted action.
Preheat always has a fixed original deadline from
`controller.floor_preheat.lease_seconds` (900 seconds by default), and restores
ROOM at that deadline even if floor release needs retries. Preheat requests the
configured increase
above the current native ROOM baseline, with normal tariff operation. When
configured, enabled and commissioned, the floor adapter adds its pooled treatment
under the [floor lease contract](floor-preheat.md). Otherwise the action is ROOM-only.
Before starting a new manual or automatic Preheat, ST-MQ confirms Normal from the
tariff relay and requires a new, committed ROOM publication received after that
confirmation. Broker acknowledgement alone does not finish the relay transition;
waiting for relay feedback and ROOM shares the original ninety-second preparation
budget and Preheat deadline. It retains the preceding normal and observed reduced ROOM values
through tariff release and restart. If they differed, a report still equal to
the reduced value cannot become the new normal baseline, including a delayed
report arriving after an accepted normal report. When the two recorded values
are equal, only that same normal value is accepted until an explicit native edit
establishes another value. A different normal
value, including a user's changed setting, can become the baseline; an explicit
native edit confirmed during Normal can also deliberately select the former
reduced value. Unknown reduction evidence keeps Preheat blocked. Register 0233
is an offset and is not substituted for the ROOM observed during reduction.

Preparation shows **Waiting for normal ROOM setting** and lasts at most ninety
seconds, within the original Preheat deadline. Floor overrides and the ROOM
increase start only after verification. Timeout, reconnect, changed equipment or
lost control cancels the request. Later evidence cannot restart a cancelled manual
request. An automatic plan whose normal ROOM baseline changed must be reassessed.
The accepted baseline is captured once, checked again before dispatch and restored
when Preheat ends; updates cannot stack boosts or extend the original deadline.
The current optional `tariffRoom` state is equipment-bound context, not permission
to write or a configured default. Genuinely absent context starts unknown and is
established only by current live evidence; startup does not infer it from history.
Preheat does not stack temperature boosts or start continuous
DHWR. A deliberate native ROOM edit supersedes an active manual preheat boost;
changing a different native parameter leaves the boost's restoration duty intact.
Automatic heating cycles must finish restoring before ordinary parameter edits
can proceed. Unconfirmed native edits are not replayed or rolled back; the live
pump reading establishes their actual result.
A tariff request is verified from fresh configured relay readback received after
the request. Native Shelly control uses Switch.Set followed by Switch.GetStatus;
the command acknowledgement alone is insufficient. Missing, stale or mismatching
readback needs attention. Stale H66 readings are not shown as current settings.
H66 0233 is the configured temperature reduction offset for the EVU input, not
an active-tariff indicator or a room-temperature target. Equality with ROOM 0203
or ambient temperature is therefore not a valid verification check.

The integration uses the documented Thermia/Danfoss C60 register profile. For a
standard DHP-H installation, the reversing valve routes the inline auxiliary
heater and condenser to either space heating or the hot-water tank. This permits
attribution when fresh compressor, auxiliary and routing readbacks overlap. It
does not establish that a nonstandard installation has identical hydraulic paths.

| Register | Role |
| --- | --- |
| `3104` | Combined auxiliary output percentage. It is not a set of individual stage relays. |
| `1A01` / `1A07` | Compressor running / reversing-valve destination, 0 space heating and 1 domestic hot water. Routing alone does not mean the compressor is running. |
| `2201` | Actual operation mode readback and supported mode control. Shown categorically in the chart, not as a numeric power curve. |
| `0203` | ROOM setting used for bounded preheating, then restored. |
| `0212` | DHW start setting, temporarily changed during the selected strategy and restored. |
| `0208` | DHW stop setting, including the requested 50 °C reduction setting, then restored. It is **not a physical compressor DHW temperature cap** and does not redefine the native hygiene cycle. |
| `8105` | Current heating integral. It is not a writable A1/A2 configuration register. |
| `6C63` / `6C66` | Cumulative auxiliary runtime counters. They cannot reconstruct the time or destination of past auxiliary episodes. |

The configured auxiliary rating converts `3104` into estimated kW. With a
verified 9 kW installation, nominal thirds represent 3, 6 and 9 kW. The DHP-H 10
model name alone does not establish the electrical heater rating; other electrical
versions differ. Outputs within two percentage points of a nominal third are
mapped to the corresponding nominal power; other values use proportional power.
This mapping remains an estimate, not separately observed relay stages or metering.

The configured A2 default is **−990**, with auxiliary hysteresis **30 °C**. A1
and compressor hysteresis are nullable configuration values until supplied.
Absolute versus A1-relative A2 semantics are explicit configuration. These are
assumptions used in prediction, not settings read from `8105` and not new writes
to the pump's installer menu.

Home Automatic may send heating/H66 commands only with live input and
the required fresh controls. Home Pause monitors and learns without automatic
heating commands. Garage has independent manual modes; charging and Caravan have separate automation choices. Explicit manual tests are separate authorization: a timed test captures
the current baseline, writes the selected register, checks readback and restores
the baseline after expiry. Failed readback and pending restoration are visible;
broker acknowledgement alone is not device confirmation. Restarts retain restore
obligations. An independently changed panel value is preserved instead of being
silently overwritten with an old baseline.

The native-setting expiry timer starts restoration once. Missing setting
readback or an unconfirmed restore leaves the durable obligation pending;
the expired deadline does not repeatedly retry or rewrite that pending state.
Fresh telemetry, reconnect and ordinary reconciliation can resume restoration.
Available registers restore independently while unavailable registers retain
their obligations. Disconnection or waiting for evidence never extends the
original expiry or establishes successful restoration.

Heating intent waits asynchronously for the database writer. Native commands
follow the committed obligation and recheck connection, actual setting evidence
and the original expiry after waiting. A queued setting edit cannot overwrite a
newer panel setting or acquire permission from a replacement connection.
Native restoration still requires admitted, current readback; unavailable storage
or device evidence leaves that duty visibly pending.

Native heating and circulation relay commands can wait within their existing
readback timeout for queued MQTT observations to commit. The wait does not renew
the action deadline or grant authority: the relay identity, connection, current
permission and applicable circulation feedback are checked again before dispatch.
A failed observation save still blocks the command until fresh evidence from
that input commits. Timeout, disconnect and shutdown cancel an unsent command;
later storage recovery cannot send it. Native readback must itself commit before
the action is confirmed. Execution events retain allowlisted failure codes and
public explanations, never raw transport errors.
Gen1 relay feedback has no command correlation. Its confirmation boundary is
captured at dispatch, after queued observations commit; only a newly accepted
live state report can confirm the command. Reports received before dispatch
cannot confirm it merely because saving them was delayed.

While the authorized runtime remains running, timed circulation has a narrower
independent OFF path: an already committed,
device-bound OFF obligation keeps its original deadline even when post-ON
bookkeeping is waiting for storage. That path can only stop the original relay,
still subject to live authority, identity and native readiness. It grants no ON
permission and retains the durable duty until confirmed OFF and its clearing
commit. Storage delay cannot extend the run or make restoration appear complete.
If bookkeeping fails instead of waiting, ordinary expiry, restart reconciliation
and restorative shutdown may still dispatch OFF for that same already committed
duty. A failed save cannot create a new duty or authorize ON. Cancelled runtime
admissions, lost authority, changed identity and failed observation admission
remain fences. A confirmed OFF whose clearing save fails remains pending in
runtime and on disk; later storage recovery can commit that original confirmation
without repeating the command or changing its time. Tariff restoration likewise
retains its runtime obligation until its clearing transaction commits.

Runtime teardown fences new activations immediately. Its own restorative saves
may wait for storage for up to five seconds; a longer wait cancels that runtime's
pending admissions, retaining the last committed physical obligations. Demotion
cancels those admissions immediately. Neither path closes the shared database or
confirms a device restoration that did not finish. The next authorized runtime
must reconcile the retained duties with current equipment evidence.
Before teardown starts, applying configuration still waits for the authorized
runtime's restoration to commit; waiting does not apply the new settings.

Unreadable or malformed saved executor or native-setting state stops
initialization before any state replacement or command. Saved manual choices
require valid equipment ownership, explicit confirmation and valid scope
deadlines. Native-setting obligations retain their original baseline, requested
value and previous readback; incomplete state cannot establish an external edit.
A failed read is not evidence that there are no outstanding circulation-OFF or
native-setting restoration duties. Read-only reset inspection still reports
independent known duties when another current record is unreadable.

Plain H66 MQTT register publications do not contain a source measurement time.
For non-retained publications, receipt time is retained as an explicitly named
time basis for communication freshness. Retained, invalid and stale values do not
become fresh merely because the application restarted. A documented register
profile is distinct from verification of the installed pump and firmware.

DHWR uses MQTT switch ON and OFF and the configurable run duration
(`controller.dhwr_duration_minutes`, default 10), whether paused or not. Clicking
Start again starts a full new run; Stop ends it immediately. Restoring manual
heating or native parameters does not end that independent circulation run.
Internal/API actions are `circulation`, `normal` and `reduction`; obsolete timed
button commands are rejected. Tariff control uses the configured relay directly. Pending OFF is saved before ON is sent and
reconciled on restart, shutdown and restoration. See [device setup](dhwr-mqtt.md).
Normal DHWR service is independent of floor preheating and its ROOM lease. The
default schedule allows starts from 05:45 through 19:45 Finnish time, at least
52.5 minutes apart. An existing pulse finishes before automatic tariff reduction
starts. New automatic pulses stay suppressed through reduction and the bounded
recovery hold; eligibility resumes at the hold deadline. New automatic pulses
also wait for a pending price-plan calculation, so circulation cannot preempt
the reduction it is assessing. An explicit manual
circulation request retains its own complete timer.
The thermal model assigns zero room heat to tank and circulation losses. Tank
service remains outside the space-heating benefit assessment; pump electricity
alone cannot account for tank and circulation heat losses.

The software does not rewrite the native periodic high-temperature schedule.
Temporary compressor-only operation can delay AUX availability; readback of these
settings does not verify completion of the pump's separate hygiene cycle.

## Reading the power chart

**Power** shows the property estimate as a line, auxiliary power as the bottom red
fill and charger power stacked above it. The combined height is auxiliary plus
charger power; tooltips still show each component's own power. These components
must not be added to the property line, which already includes household loads.
The fills align their observation intervals and retain missing-data gaps.
If no auxiliary and charger readings overlap, charging remains visible from zero.
For a partially covered stack, hiding auxiliary shows the original charger history
through periods where the auxiliary baseline is unknown.
Auxiliary power expires after five minutes without an updated observation,
rather than extending indefinitely.

The **Home compressor** strip uses yellow for reported space heating, blue for
hot water, grey for reported stopped and hatched grey for running with unknown
routing. Missing compressor evidence remains blank. **Tariff reduction request**
describes a request, not proof of a stopped compressor. **Hot-water circulation
request** shows recorded requests and durations, while **Hot-water circulation
feedback** shows observed circulation separately (positive watts means on, zero
means off; unavailable feedback leaves gaps). They appear alongside **Pump mode**
and **Fireplace** in relevant views. **Fireplace**
uses the same recorded additions and burn duration as the model, currently two hours;
overlapping periods merge, and corrections update the strip. This duration marks
the burn timescale, while masonry heat release continues afterward. Explicit saved
legend choices remain in effect.
Horizontal stripes in the activity strips and their matching legend swatches
distinguish them from the main plot. Both circulation rows use red for requested
or observed activity; Fireplace is dark yellow. Every title expands to explain
all colours, patterns and missing intervals.

Solar history is the latest valid forecast estimate known at each historical
time, drawn as a solid line. The future forecast uses a dash-dot line. Neither
is a solar observation.

## Timing benefit under the chart

Comparison history is loaded while **Energy cost comparisons** is open. Closing
the panel cancels unfinished reads and defers polling work, while preserving its
dates, selections and existing cards. Reopening checks the latest source revisions
and refreshes when necessary.

The **Energy cost comparisons** fold compares recorded heat-pump and EV energy at its actual times
with the **same recorded daily energy** spread uniformly over that entire Finnish
calendar day. It uses duration-weighted all-in prices and actual 23/24/25-hour
days, including clock changes. Positive means cheaper timing; negative means
dearer timing. This mathematical comparison is not causal controller savings.

Original observations are integrated before chart decimation. Valid three-phase
charger acquisitions can supply older EV estimates. Home timing reconstructs
electricity from recorded compressor activity, verified auxiliary output and
dated nominal equipment powers; it is not a dedicated meter reading. Garage
requires qualified dedicated electrical intervals. Older EV power samples are held for at most 30
minutes between observations. Missing intervals are excluded and coverage is
shown. A day without complete all-in prices is unavailable. Today's incomplete
energy, partial history and telemetry gaps produce provisional results, not a
zero estimate for the missing period.

## Primary documentation

- [Husdata C60 register list](https://online.husdata.se/h-docs/C60.pdf).
- [Husdata MQTT specification](https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/).
- [Danfoss DHP-H installation instructions, VMBMA702](https://assets.danfoss.com/documents/latest/29671/AN000086466221en-010701.pdf), system 1 routing in §8.2 and integral control in §15.7.

Manual phase behavior and Pause duration follow the single current contract in
[Automation and manual heating](automation-and-manual-control.md). In particular,
Reduced applies the complete available automatic reduction actions, indefinite
Pause holds Normal/Reduced, and manual Preheat uses one fixed floor lease with
independent ROOM restoration and a 24-hour outcome report.

### Manual and paused learning

Pause suspends automatic commands, not recording or learning. Confirmed manual
Normal, Reduced and Preheat choices retain their original context and source
clocks. A distinct manual treatment gets a stable journal episode identity;
repeating the same request does not create another experiment. Ending or changing
the treatment publishes response-only evidence. Its observed input windows can
refine equipment response without claiming complete recovery, an advance forecast
or savings. Full tracked cycles retain their independent complete-cycle assessment.
Useful thermal observations during pauses and incomplete trials remain eligible;
only conclusions lacking their required evidence are unavailable.
