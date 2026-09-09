# Learning, heating cycles and the chart

The controller compares complete **preheat → reduction → recovery** cycles with
normal heating and feasible shorter reductions. The reference is fixed before
execution. Cheap electricity during reduction alone does not establish a saving;
recovery, comfort and comparable heating service matter too. Offline and synthetic
checks do not establish savings on the installed equipment.

## What learns

The model has six thermal coefficients: heat loss, compressor response, solar
response, auxiliary response, heat exchange and building memory time. Compressor
and auxiliary gains remain separate. At most four coefficients are fitted; the two
memory constants remain structural priors until independent state evidence can
identify them. Heating enters the slow hydronic state before warming the room.
That state is an effective temperature memory, not measured floor temperature or
stored kWh. Effective heating response is not measured capacity or COP.

The dashboard's **House model** card summarizes the learning state and reported
counts of usable observations and accepted model updates. These counts describe
current evidence; missing values remain unknown and no completion percentage is
inferred. **Explore learning** separates **Learning outcomes · Calculated**, **Model
inputs** and **Model coefficients** into closed sections.
Current coefficients include their value, unit, explanation and provenance:
fitted in the accepted model, retained while awaiting evidence, initial estimate
or fixed building assumption. They use the existing learning state; this display
adds no database records or historical coefficient reconstruction. Earlier chart
intervals never receive today's coefficient values.

Observed thermal drivers are outdoor temperature, archived solar radiation,
space-heating compressor duty and space-heating auxiliary power. Indoor temperature
is the measured state and prediction target. Requested phase, ROOM boost and comfort
target describe control context; they do not create a direct heat credit. The eight
**Model inputs · Calculated** axes include the indoor endpoint and these seven
input/context values exactly as saved in the learning journal.

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

In the dashboard, **Home & heating** summarizes native settings. Its **Equipment
details** fold contains the **Husdata H66** series and readbacks, **Test heating
commands** and **Test H66 controls**. A tariff request remains unverified without
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

The legacy DHWR command pair is `heaton60`, then `heaton15`, with a ten-minute
pulse. The planner includes a nominal pulse-electricity allowance, but the thermal
model does not invent extra delivered heat for the request. The coupled action
cannot identify independent ROOM and DHWR effects. Tank service remains outside
the space-heating benefit assessment.

The native periodic high-temperature/14-day hygiene cycle is retained. The owner
accepted that a temporary compressor-only strategy may delay the availability of
auxiliary heat during its control window. These writes must not be described as
proving that every native hygiene cycle completes on schedule. The software does
not rewrite the native hygiene schedule or claim a software-verified hygiene result.

## Reading the power chart

**Power** shows the property estimate as a line, auxiliary power as a red fill
and charger power as a fill drawn over it. Both fills start at zero: they overlap
and are not stacked. They must not be added to the property line, which already
includes household loads. Auxiliary power expires after five minutes without an
updated observation, rather than extending indefinitely.

Yellow background means the compressor was reported running toward the house;
blue means it was running toward DHW. Missing/stale routing leaves a gap. Tariff reduction
is crosshatched and describes a reduction request, not proof of a stopped
compressor. Brown DHWR shows ten-minute requests and starts hidden. Other series
start visible, while explicit saved legend choices remain in effect.

Solar history is a forecast archived at its valid time. Its dashed continuation
is the currently available future forecast. Neither is a solar observation.

## Timing benefit under the chart

The lower corner compares recorded heat-pump and EV energy at its actual times
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
