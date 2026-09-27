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
thermal**. Initial `hydronicCPerKwh` is `0.75/9.40 ≈ 0.0798`; this is a prior,
not a measurement. A shared
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

Each dashboard includes its learning summary alongside the heating and pause controls.
Home shows current heat-pump, tariff and circulation status first, followed by
**Temporary heating override** and **Away & pause**.
**Heating strategy & comfort** holds
the normal-temperature reference, occupied drop/rise limits, savings preference
and ROOM increase; its closed summary shows the configured room limits. Permanent
preferences still use configuration and **Apply configuration**. **Home heat model**
follows these controls, with the reconstruction explanation under **Learning outcomes →
Validation & evidence → Reconstructing the model**. Home reports
counts of usable observations and accepted model updates. These counts describe
current evidence; missing values remain unknown and no completion percentage is
inferred. The **Home heat model** and **Garage heat model** summaries each open learning details.
Both explain the model's role before the nested sections: the model estimates a
response, planning combines that response with prices and comfort or protection
requirements, and control sends the allowed commands. Links lead back to each
zone's heating strategy and current decision. The three closed sections are:

- **Learning outcomes · Estimates & checks**: results and validation evidence
  used to assess forecasts. Calculated savings use a modeled alternative, so even
  a qualified electricity measurement does not make the comparison metered savings.
- **Model inputs · Recorded & estimated**: source observations and derived inputs
  used for fitting, validation and forecasts. Home lists input definitions and
  units, with values in the chart; Garage shows current readings and identifies
  its historical electricity average separately.
- **Model coefficients · Learned & assumed**: current responses and assumptions
  that turn inputs into predictions. Initial estimates, accepted or retained fits,
  observed averages and fixed assumptions keep their own provenance.

Both use the same expandable rows: the name, value or unit, and provenance stay visible;
explanations and supporting evidence open underneath. Inputs and coefficients are grouped by
their role. **Validation & evidence** keeps detailed checks alongside the outcomes without
equating Home's conditional temperature, equipment-response and frozen-forecast checks with
Garage's cooling-and-recovery episode validation. Status refreshes preserve open explanations,
keyboard focus and the sensor-change forms within Home's temperature inputs.
Current coefficients include their value, unit, explanation and provenance:
fitted in the accepted model, retained while awaiting evidence, initial estimate
or fixed building assumption. The current-value display uses the existing learning
state. Four **Model coefficients · Calculated** chart choices show historical heat
loss, combined hydronic response, solar response and fireplace response. Fixed
building, source and slab assumptions have separate informational rows.

Coefficient charts replay the immutable learning journal in memory with the matching
algorithm, saved configuration, initial seed and current corrected fireplace revision. Replay preserves journal order,
including late episodes, and uses earlier entries to establish the model at the
selected range's start. Each coefficient is a stepped line with initial, fitted or
retained status in its tooltip. Unsupported or incomplete replay prefixes leave
gaps; an explicit saved seed can establish a new supported start. The selected live
learner and imported history are replayed separately, and simulation stays separate.
Earlier chart intervals never receive today's coefficient values. Replay uses the
saved configuration and matching learning algorithm; treatment-specific evidence
keeps ROOM-only observations separate from confirmed floor charging.

Chart requests use a read-only database connection and never save replay checkpoints,
coefficient rows or new snapshots. A bounded memory cache reuses derived timelines
and resumes replay as new entries arrive; advancing the clock alone does not repeat
learning. The first request can take longer because it replays earlier learning.
The **View** menu groups compatible comparisons with their relevant temperature
context and labeled activity rows. Saved temperatures and references, thermal
inputs, electrical inputs, activity fractions and coefficients keep their own
units and meanings. Both Garage cooling coefficients share one ordered replay
and retain independent coefficient timelines; selecting another coefficient
does not repeat the same learning. **Series explorer** can isolate every
supported saved input or coefficient by its label or signal identifier. The
shared electricity-price controls remain available across views. Observed
temperature history stays distinct from the original normalized inputs used
for learning.

Observed thermal drivers are outdoor temperature, archived solar radiation,
the estimated combined hydronic heat, derived from space-heating compressor duty
and space-heating auxiliary power. The original source inputs remain visible. The configured
average of Upstairs, Bedroom and Downstairs is the live indoor state and prediction
target, with fixed membership and equal weights by default. Missing contributing
readings leave gaps; imported CSV learning retains its original Upstairs input.
The model also learns a comfort reference for each participating room and checks
each room before permitting occupied heating reduction. The same configured
maximum drop and rise apply to every room relative to its own learned normal
temperature; a room without its own learned reference falls back to the overall
reference. **Overall comfort reference** and expandable room references in
Heating configuration expose this distinction. There are no separately configured
room allowances. See
[indoor temperatures](temperature-sensors.md) for averaging, room limits and sensor
changes, recorded inside the **Average indoor** model-input details.
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

Three kinds of evidence remain distinct:

1. **Conditional thermal validation** supplies observed heat input and checks
   temperature trajectories.
2. **Equipment-response validation** checks compressor duty under requested modes
   on distinct completed episodes. This check uses recorded room/weather context.
3. **Advance cycle validation** compares frozen predictions with subsequent
   temperature and attributable space-heating energy. It never substitutes actual
   future compressor duty into an advance forecast.

Economic dispatch requires all three checks, within a duration supported by at
least three training/held-out response and advance forecast episodes. Counterfactual
savings still remain estimates. See [the audit and design decisions](learning-model-audit.md).

The normal indoor reference comes from occupied, normally heated periods. Actual
fractional compressor runtime contributes evidence; a brief run cannot count as
an entire quarter-hour of heating. The reference is held through preheat, reduction
and recovery. Away removes the usual occupied drop constraint but retains a return
requirement inside the known forecast horizon.

After initial establishment from 24 hours of normal heating, the reference can
follow sustained household thermostat changes both down and up, including floor
circulation settings that the heat pump cannot report. Each later qualifying
normal period lasts at least eight hours with a stable final six-hour plateau.
Only nonoverlapping plateau time counts: at least 24 hours of evidence spanning
48 hours must support a consistent candidate temperature before adaptation starts.
Normal periods may be separated by controller preheat, reduction or recovery;
those phases hold the reference fixed and add no evidence. The reference moves
at most 0.2°C per newly evidenced 24 hours, with the first catch-up adjustment
capped at 0.2°C. Polling the same data again cannot move it. Missing or invalid
observations, away periods and meaningful fireplace influence clear pending
adaptation evidence; a 48-hour gap between qualifying periods also expires it.
Passive summer warmth and ongoing cooling cannot establish a new reference.

## Model reconstruction

The model can be reconstructed exactly at a committed journal boundary when its
complete learning journal, saved seed and configuration, selected fireplace and
sensor-correction revisions, and matching algorithm and software are retained.
Replay uses the same ordered updates as live learning. It restores the model
checkpoint, including coefficients, estimated building and slab state, comfort
references and learning evidence. Selecting corrected source events instead
produces a corrected model; it need not match the model used before that correction.

Keep a consistent backup of the full SQLite database and the corresponding
software version. A temperature or telemetry CSV export alone is insufficient.
Discarded raw polls and missing history cannot be recreated. Exact replay of every
past control decision is outside this scope: transient provider inputs and complete
controller snapshots are not archived. Recorded commands and outcomes remain
useful evidence, but replay cannot prove physical receipt of a command, recreate
an unrecorded outcome or make estimated savings into measured savings. See the
[reconstruction contract](reconstruction-and-versioning.md) for the exact scope.

## Planning and recovery

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
Occupied-room maximum drop and rise both default to **1.5 °C** around their normal
references; savings preference never changes these hard limits.
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

Home's **Heating strategy & comfort** separates the decision policy from the
**Home heat model**. **Savings strategy** offers **Gentle**, **Balanced** (default)
and **More savings**. These choices change the economic hurdle and continuous
comfort cost, including duration within an allowed band. They do not relax hard
occupied-room upper/lower bounds. The planner checks each participating room
conservatively; a warm floor downstairs does not prove that an occupied bedroom
can coast safely. This is a conservative room-offset proxy, not an identified
zonal model: each room follows the projected change in the house average while
retaining its current offset, plus its recent trend for at most the first hour.
The common temperature allowance applies to each room, and individual live
readings also guard active control. Configuration changes use **Apply
configuration**. No strategy promises an annual savings percentage.

A new cycle's conservative benefit must exceed the strategy's minimum of 50,
30 or 10 cents respectively, plus 30, 17.5 or 5 cents per weighted hot/cold
°C²-hour, 2 cents per extra active hour and 2 cents to start. Continuation excludes
the already committed start hurdle. Among admitted choices, the mildest retaining
at least 60%, 80% or 100% of the best positive conservative benefit is selected.
Gentle can still start a sufficiently worthwhile cycle. Use **Pause price
control** to suspend economic control. Garage shares the same named strategies,
with its own economic threshold and preference for shorter OFF windows; see
[Garage selection](garage-model.md#one-opportunity-at-a-time).

These decision rules consume the heat model's thermal predictions, uncertainty
and action evidence. They are not fitted model coefficients: choosing another
strategy does not alter the learning process or create missing evidence.

Selection, dispatch and continuation share paired stress scenarios for action and
reference: heat response and loss ±15%, initial reserve/slab ±0.5 °C, compressor
duty ±0.08, source electrical input within its operating-point allowance, and AUX
exposure ±50%. A residual 5-cent uncertainty floor remains. These cases are not
statistical confidence bounds. Forward temperature bounds begin with conditional
trajectory error and add engineering allowances for the source estimate, unknown
action, missing solar, fireplace response and optional slab. The separately
calculated duty-response error does not make those bounds calibrated probabilities;
frozen forecasts still need independent later-outcome checks. The bounded search checks the best 16 nominal
candidates independently of the preference; it does not establish a global optimum.
Equipment duty ratios and AUX exposure calibration remain separate adaptive
quantities. Saved nominal compressor kW and recovery multipliers remain reporting
diagnostics; they do not replace the fixed source electrical-input map.

Each floor ON command carries a **device-local 15-minute lease**, normally renewed
every **5 minutes** while preheat remains authorized; each lease is capped at the planned end. A controller crash or lost
network therefore lets the Shelly turn its override off without a later server
command. Commissioned OFF wiring returns authority to the room thermostats; stored
heat still releases afterward. Device readback and lease/timer verification remain
separate from MQTT acknowledgement. Relay readback does not measure valve movement,
water flow or delivered heat. Local expiry releases only the valve overrides:
H66 ROOM has no device-side lease and relies on durable application restoration
and retries after communication returns. The two groups are one treatment for learning,
not two independently fitted thermal stores.

With little evidence, automatic action requires enabled learning trials, usable
recorded temperature/equipment evidence and remaining allowance. Initial trials
last at most half an hour. A no-heat cooling scenario and rated-power recovery
scenario must fit comfort and cost allowances. Preheat trials also test full compressor and permitted rated AUX heat during charging, followed by native demand until the delayed room peak is covered. Individual warm-room limits and uncertain valve states can block a trial even when its cooling limit passes. These are stress estimates, not
guarantees that fallback costs cannot exceed the allowance. Disabled trials cannot
be bypassed by an unvalidated economic action. Trials pause for six hours after
completion or 24 hours after an incomplete attempt; new automatic cycles also wait
24 hours after an incomplete attempt. Occasional bounded trials can
extend a tested duration; small preheat trials require thermal and reduction-response
evidence. Unexecuted promises are not counted as learning episodes.

Recovery restores normal ROOM and tariff operation while applying one shared
**60-minute hold** (`controller.recovery_hold_minutes`). Until its fixed deadline,
DHW start stays at the lower of 40 °C and its normal setting, the stop register
stays at 50 °C, new automatic DHWR pulses are suppressed and AUX is restricted.
The stop register may govern AUX operation only; this is not an established 50 °C
compressor cutoff. The hour is an initial engineering choice, not a learned
recovery duration.

Cold-room protection releases AUX permission early without restoring the DHW
settings or restarting circulation. It considers the aggregate and individual
participating rooms, using `recovery_comfort_margin_c` (default 0.5 °C) and a
30-minute falling-trend projection where available. The AUX fallback remains
latched for the cycle. Native AUX permission applies to the pump as a whole,
not exclusively to space heating. `recovery_compressor_only: false` disables
the AUX restriction while retaining the timed hot-water hold.

At the original deadline, normal DHW and operating-mode settings restore and
scheduled DHWR eligibility resumes even if thermal recovery assessment continues.
Resuming eligibility does not force a circulation pulse. The deadline does not
restart on each controller update. Restoration obligations survive interruption;
loss of control can require earlier full restoration. Separate transports do not
guarantee atomic compressor switching.

For hot water before the deadline, use **Pause price control**, which selects
Normal heating and restores the captured native DHW settings. Start a timed
circulation run if needed. The Normal heating button alone changes tariff/manual
heating selection; it does not guarantee restoration of an automatic DHW hold.
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

In the dashboard, the **Home** upper summary opens **Heating configuration**.
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

**Heat control** actions retain their temporary scope. Starting a price-control
pause selects Normal heating; subsequent Normal, Reduction or Preheat actions are
held until the pause ends or the owner selects Resume now. Outside Pause, they
revert on the next controller update, normally within one minute, with a
one-minute restoration deadline. **Preheat** requests the configured increase
above the current native ROOM baseline and the pooled floor-valve override, with
normal tariff operation. It does not stack temperature boosts or start continuous
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

Normal active operation may send heating/H66 commands only with live input and
the required fresh controls. Monitoring and shadow do not automatically actuate
equipment. Explicit manual tests are separate authorization: a timed test captures
the current baseline, writes the selected register, checks readback and restores
the baseline after expiry. Failed readback and pending restoration are visible;
broker acknowledgement alone is not device confirmation. Restarts retain restore
obligations. An independently changed panel value is preserved instead of being
silently overwritten with an old baseline.

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
recovery hold; eligibility resumes at the hold deadline. An explicit manual
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

The **Energy cost comparisons** fold compares recorded heat-pump and EV energy at its actual times
with the **same recorded daily energy** spread uniformly over that entire Finnish
calendar day. It uses duration-weighted all-in prices and actual 23/24/25-hour
days, including clock changes. Positive means cheaper timing; negative means
dearer timing. This mathematical comparison is not causal controller savings.

Original observations are integrated before chart decimation. Valid three-phase
charger acquisitions can supply older EV estimates; a dedicated heat-pump power
series is required for the heat-pump comparison. Power is held for at most 30
minutes between observations. Missing intervals are excluded and coverage is
shown. A day without complete all-in prices is unavailable. Today's incomplete
energy, partial history and telemetry gaps produce provisional results, not a
zero estimate for the missing period.

## Primary documentation

- [Husdata C60 register list](https://online.husdata.se/h-docs/C60.pdf).
- [Husdata MQTT specification](https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/).
- [Danfoss DHP-H installation instructions, VMBMA702](https://assets.danfoss.com/documents/latest/29671/AN000086466221en-010701.pdf), system 1 routing in §8.2 and integral control in §15.7.
