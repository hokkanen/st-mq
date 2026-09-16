# Learning, heating cycles and the chart

The controller compares complete **preheat → reduction → recovery** cycles with
normal heating and feasible shorter reductions. The reference is fixed before
execution. Cheap electricity during reduction alone does not establish a saving;
recovery, comfort and comparable heating service matter too. Offline and synthetic
checks do not establish savings on the installed equipment.

Firewood can be logged through **Home → Fireplace**, below the equipment fold. See
[fireplace logging](fireplace.md) for corrections, delayed heat and validation gates.

## What learns

The model has seven thermal coefficients: heat loss, compressor response, solar
response, auxiliary response, fireplace response, heat exchange and building memory time. Compressor
and auxiliary gains remain separate. At most five coefficients are fitted; the two
memory constants remain structural priors until independent state evidence can
identify them. Heating enters the slow hydronic state before warming the room.
That state is an effective temperature memory, not measured floor temperature or
stored kWh. Effective heating response is not measured capacity or COP.

Each dashboard **Heating configuration** includes its learning summary above the pause controls. Home reports
counts of usable observations and accepted model updates. These counts describe
current evidence; missing values remain unknown and no completion percentage is
inferred. The **Home learning** and **Garage learning** summaries each open learning details,
with separate closed sections for **Learning outcomes · Calculated**,
**Model inputs · Recorded & modeled** and **Model coefficients · Current values**.
Both use the same expandable rows: the name, value or unit, and provenance stay visible;
explanations and supporting evidence open underneath. Inputs and coefficients are grouped by
their role. **Validation & evidence** keeps detailed checks alongside the outcomes without
equating Home's conditional temperature, equipment-response and frozen-forecast checks with
Garage's cooling-and-recovery episode validation. Status refreshes preserve open explanations,
keyboard focus and the sensor-change forms within Home's temperature inputs.
Current coefficients include their value, unit, explanation and provenance:
fitted in the accepted model, retained while awaiting evidence, initial estimate
or fixed building assumption. The current-value display uses the existing learning
state. Five **Model coefficients · Calculated** chart choices show historical heat
loss, compressor response, solar response, auxiliary response and fireplace response. The two fixed
building assumptions remain informational values only.

Coefficient charts replay the immutable learning journal in memory with the matching
algorithm, saved configuration, initial seed and current corrected fireplace revision. Replay preserves journal order,
including late episodes, and uses earlier entries to establish the model at the
selected range's start. Each coefficient is a stepped line with initial, fitted or
retained status in its tooltip. Unsupported or incomplete replay prefixes leave
gaps; an explicit saved seed can establish a new supported start. The selected live
learner and imported history are replayed separately, and simulation stays separate.
Earlier chart intervals never receive today's coefficient values.

Chart requests use a read-only database connection and never save replay checkpoints,
coefficient rows or new snapshots. A bounded memory cache reuses derived timelines
and resumes replay as new entries arrive; advancing the clock alone does not repeat
learning. The first request can take longer because it replays earlier learning. The left-axis
menu starts with **Electricity**, followed by heating and control, weather, learning
and model views, then equipment diagnostics. Main temperature and electricity-price
choices are omitted from that menu because they already appear on the right axis.
Saved model-input temperatures remain selectable because they describe the inputs
used for learning.

Observed thermal drivers are outdoor temperature, archived solar radiation,
space-heating compressor duty and space-heating auxiliary power. The configured
average of Upstairs, Bedroom and Downstairs is the live indoor state and prediction
target, with fixed membership and equal weights by default. Missing contributing
readings leave gaps; imported CSV learning retains its original Upstairs input.
The model also learns a comfort reference for each participating room and checks
each room before permitting occupied heating reduction. See
[indoor temperatures](temperature-sensors.md) for averaging, room limits and sensor
changes, recorded inside the **Average indoor** model-input details.
Requested phase, ROOM boost and comfort target describe control context; they do
not create a direct heat credit. The eight
**Model inputs · Calculated** axes include the indoor endpoint and these seven
input/context values exactly as saved in the learning journal.
**Manually recorded firewood additions** markers and calculated **Fireplace release input** provide
two additional input views from the corrected source-event history. Fireplace
response evidence appears alongside the coefficient. Daily estimated firewood cost
and electricity savings are available under **Learning outcomes · Calculated**;
their paired normal-heating reference and separate electrical validation are
explained in [fireplace logging](fireplace.md#visibility-and-estimated-savings).

Only outdoor temperature and solar radiation are weather inputs. Current outdoor
source priority remains H66, FMI station, then Open-Meteo. Solar remains an archived
forecast from FMI with Open-Meteo backup, never a claimed radiation observation.
The forecast available at the start of a completed interval supplies its solar
input. Missing radiation remains unknown and adds uncertainty. No wind, cloud or
sun-angle pseudo-observations are invented.

Fitting scores every temperature along later trajectories, separated from training
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

## Planning and recovery

Each candidate prices preheat, reduction, recovery and remaining heat debt under
the same price/weather outlook. Electricity price belongs in this objective, not
in the thermal coefficients. Nominal compressor/runtime and auxiliary estimates
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

With little evidence, automatic action requires enabled learning trials, usable
recorded temperature/equipment evidence and remaining allowance. Initial trials
last at most half an hour. A no-heat cooling scenario and rated-power recovery
scenario must fit comfort and cost allowances. These are stress estimates, not
guarantees that fallback costs cannot exceed the allowance. Disabled trials cannot
be bypassed by an unvalidated economic action. Trials pause for six hours after
completion or 24 hours after an incomplete attempt; new automatic cycles also wait
24 hours after an incomplete attempt. Occasional bounded trials can
extend a tested duration; small preheat trials require thermal and reduction-response
evidence. Unexecuted promises are not counted as learning episodes.

Recovery defaults to compressor-only operation while restoring ROOM and DHW
settings. `recovery_compressor_only_hours` defaults to four hours. Falling below
target minus `recovery_comfort_margin_c` (default 0.5°C), a 30-minute trend towards
that boundary, lost native control, forced restoration or the time limit restores
the captured native mode. The fallback remains in effect for the rest of the cycle.
`recovery_compressor_only: false` selects immediate native recovery. Restore
obligations survive interruption and expire independently of planner ticks; separate
transports do not guarantee atomic compressor switching.

Completion requires comparable room temperature and the reserve reconstructed
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
**Adjust heat-pump parameters** and **All heat-pump readings**.
Starting a price-control pause selects Normal heating;
subsequent manual heating and parameter changes are held
until the pause ends or the owner selects Resume now. Previous settings are then
restored and the automatic schedule resumes if enabled. Outside Pause, these
manual changes revert on the next controller update, normally within one minute,
with a one-minute restoration deadline. Repeated edits preserve the original
baseline. **Max preheating** raises the selected ROOM setting by the configured
maximum boost, capped at the writable ROOM upper limit, requests normal tariff
operation and starts a configured circulation run. Repeated clicks use the same
unboosted ROOM setting, so the boost does not accumulate.
A tariff request remains unverified without
relay readback; stale H66 readings are not shown as current settings.

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
The internal `heaton60` intent is never published as a push-button command. `heaton15`
separately restores normal heating. Pending OFF is saved before ON is sent and
reconciled on restart, shutdown and restoration. See [device setup](dhwr-mqtt.md).
The planner includes a nominal pulse-electricity allowance, but the thermal
model does not invent extra delivered heat for the request. The coupled action
cannot identify independent ROOM and DHWR effects. Tank service remains outside
the space-heating benefit assessment.

The native periodic high-temperature/14-day hygiene cycle is retained. The owner
accepted that a temporary compressor-only strategy may delay the availability of
auxiliary heat during its control window. These writes must not be described as
proving that every native hygiene cycle completes on schedule. The software does
not rewrite the native hygiene schedule or claim a software-verified hygiene result.

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

Yellow background means the compressor was reported running toward the house;
blue means it was running toward DHW. Missing/stale routing leaves a gap. Tariff reduction
is crosshatched and describes a reduction request, not proof of a stopped
compressor. **DHWR** shows requests with their recorded durations in its own strip below the chart,
alongside **Pump mode** and **Fireplace**. These strips start visible. **Fireplace**
uses the same recorded additions and burn duration as the model, currently two hours;
overlapping periods merge, and corrections update the strip. This duration marks
the burn timescale, while masonry heat release continues afterward. Explicit saved
legend choices remain in effect.
Horizontal stripes in the activity strips and their matching legend swatches
distinguish them from the main plot. DHWR is red and Fireplace is dark yellow.

Solar history is a forecast archived at its valid time. Its dashed continuation
is the currently available future forecast. Neither is a solar observation.

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
