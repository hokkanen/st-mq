# Garage learning, protection and planning

Garage uses `committed-garage-v3-event-doors`, separate from Home's learning algorithm,
checkpoint, sensors and heat-input accounting. Its current adapter boundary is an
explicit provisional client fixture. Software simulations do not establish the
installed adapter's protocol, native electricity accuracy, local restoration, pipe
protection or realized financial savings.

## Owner settings and protection policy

`garageSettings()` validates the three everyday settings: freezing protection,
normal native baseline context (initially 10°C), and savings aggressiveness. The
protection policy is separate from economic preference. Automatic operation is
initially disabled and the protection policy is initially **unapproved**. The
illustrative defaults need owner approval after reviewing the actual sensor
placement and installation; they are not a recommended pipe-safety specification.

Each external sensor drives an independent persisted reference temperature under
`garage-thermal-reserve-v1`. A water-filled copper pipe supplies the reference
heat capacity for protecting pipes and stored liquids. Defaults are 21 mm outside
diameter, assumed 1 mm wall, 20 W/m²·K nominal heat transfer and a fixed uncertainty
factor of 2. The factor doubles cooling and halves warming. Heat reserve is the
calculated sensible heat above an estimated reference temperature of 1°C, in
kJ per metre; at 6°C it is approximately 7.01 kJ/m. The 1°C margin is not an
air-temperature cutoff. No latent-heat allowance permits partial freezing.

The estimate follows the air/reference temperature difference continuously.
There is no assigned full allowance, warm dwell, recovery threshold or constant
repayment rate. Air above 1°C can still cool a warmer reference. A brief warm
report, the other location warming, changing aggressiveness, restoring native ON,
model refitting and reconnecting cannot reset the state. Missing history earns
no assumed warming, and unavailable evidence cannot authorize a pause. Absent or
unsupported initial history starts from fully frozen reference contents at the
supported −40°C air bound. Genuine warmth must repay this assumed thawing debt;
there is no elapsed-time shortcut. Ordinary gaps debit their elapsed cooling
without restarting that initial frozen state.
Forecast checks must detect exhaustion within a step even if later warmth
recovers the reserve. The [protection and sensitivity notes](garage-protection-defaults.md)
explain initialization, thermal assumptions and the limits of adjacent-air
estimates for actual pipes, fittings and containers.

Shelly uses a fixed 30-second status request cadence. `maxSensorAgeMs` is capped
at two minutes for automatic protection. Receipt of a retained
packet or heartbeat does not refresh a temperature. New reports with unchanged
values do count as new evidence. Both locations must be fresh for every automatic
pause even when historical/monitoring configuration permits rear-only data.
`frontRequired` additionally records the owner's front commissioning context;
removing a front sensor is not an automatic reaction to stale data.

Protection forecasts use independent lower-temperature trajectories and assume
both EVs can stop charging. Pause permission is revalidated each minute, capped
at three minutes from the older supporting temperature report and shortened when
the thermal reserve requires it. The runtime accounts for outstanding possible
device permission plus useful-heating delay, without an unconditional fifteen-minute
reserve. Neither building memory nor a pump internal sensor substitutes for
either external protection measurement. See [adapter timing](garage-adapter.md).

## Coupled thermal model

The estimated state has rear air temperature, slow rear-derived thermal memory,
and front-minus-rear difference. The rear derivative fits outdoor loss and one
qualified electrical or activity heat response when the inputs distinguish them.
The front-difference derivative fits at most one additional local-loss response.
Rear memory exchange, front relaxation and pump distribution remain fixed priors.
A fixed 18-hour rear-to-memory timescale is a structural prior, not
measured wall/floor temperature or stored kWh. Five-minute integration substeps
keep predictions bounded. No Home hydronic coefficients or heat path is reused.

Bounded ridge fits use duration-weighted sufficient statistics, separately for
normal, OFF and recovery operation. Forgetting follows hours of qualified evidence
in each regime: 48 OFF hours and 96 normal/recovery hours per half-life. Routine
ON reports therefore cannot erase a rare OFF experiment. A permanent ridge prior
and input-conditioning checks prevent steady input from falsely identifying loss
and heating separately. Inputs use degrees C, hours and qualified kW; activity is
separate dimensionless evidence, never silently converted to measured watts.
Coefficients have explicit finite bounds. Local front plunges exclude
front parameter fitting while still fully affecting the front state, prediction
and protection. They do not overwrite rear memory. Sustained unexpected rear
cooling gradually corrects the memory observer when the expected rebound fails.
Optional door disturbances can suppress ordinary fitting without inventing
unobserved door events. Configured MQTT contacts keep their confirmed state until
a source event or explicit availability failure; they have no fixed five-minute
age limit. Startup and recovery require a live status/availability confirmation,
which preserves the contact's original source timestamp. Samples carry compact
uninterrupted-closed evidence, so an opening or outage between temperature reports
cannot vanish when the final state is closed again. Such intervals cannot fit
thermal coefficients, baseline warmth or clean validation evidence. Unknown or
open configured contacts do not directly veto a pause; current independent
temperature protection still applies. Solar is deliberately excluded in this version until a
versioned model comparison shows held-out improvement.

Both EV identities and their power/activity units remain separate. Shared rear
responses and zero spatial responses remain explicit priors. Charging intervals
do not fit their unknown heat into insulation or pump coefficients, and do not
qualify clean OFF/recovery episodes. Additional EV coefficients require a future
versioned demonstration of held-out improvement. This is effective temperature response,
not vehicle charging efficiency or measured heat delivered by a car. Future plans
never start charging for garage heating and do not alter vehicle priorities.

The normal reference starts uninitialized at the configured baseline, without a
hard-coded near-pipe offset. It learns achieved rear temperature only with verified
native baseline, continuous availability for at least eight hours, a stable
two-hour smoothed rear trend, and no known EV/door disturbance. Qualification and
adaptation use elapsed hours rather than report count. Pauses/recovery interrupt
the settled-operation requirement; a fixed 48-hour exclusion no longer prevents
reference learning when several weekly opportunities occur. Once initialized,
cold departures exceeding 0.5°C cannot pull the
reference down. Baseline changes establish a recorded fresh model epoch; they do
not command a temperature boost. The current small outdoor slope remains an
explicit prior while intercept learning tracks comparable achieved observations.

## Validation and advance electricity

Ordinary operation keeps a daily held-out block. Each complete OFF and recovery
experiment instead belongs entirely to one deterministic training/validation
partition. The held-out model and forecast state are frozen at the start and then
run without temperature corrections or actual future heating. Preceding observed
ambient weather is used, so this tests plant response rather than weather-forecast
accuracy. Door/EV disturbances and input gaps cannot qualify clean episodes.

Thermal qualification requires two distinct completed training episodes and a
later successful held-out episode. Supported OFF duration is bounded by repeated
training and later validation duration. Later failed validation retracts obsolete
support. Recovery requires sustained native availability and substantial measured
rebound at both locations; a short pause cannot qualify itself by crossing a daily
partition or by generating many readings. At most 24 compact episode summaries
are retained alongside fixed-size fit statistics. Electrical qualification is
separate and requires metered native and full recovery-energy validation.
These gates cannot be replaced by a completion percentage.
Rear-only historical intervals can fit supported rear responses and update thermal
memory; they never invent front temperatures or front validation evidence. Source
timestamps, source quality/gaps and configuration remain in committed inputs.

Native availability permits native demand regulation, including idle; it does not
force electrical output. A separate bounded electrical response initially fits
baseline and cold-weather demand using the same thermostat envelope as prediction.
A deficit-response coefficient is released only after two clean training
recoveries and independent deficit variation; restart remains an explicit prior.
Thus the ordinary fitted cap is five coefficients, or six with supported recovery
response, plus the normal-reference intercept. Before sufficient electrical evidence, predictions retain the explicit
`prior-modeled-electricity` label. An activity-only thermal fit can be useful while
recorded-energy timing remains unavailable. Its separate normal-activity observer
learns dimensionless duty from actual activity reports; it does not infer duty
from unqualified electrical predictions or turn activity into measured kW.
Observed OFF standby electricity is
counted when qualified, without calling it delivered heat.

To obtain initial evidence, a worthwhile price opportunity can support a bounded
30-minute learning trial with initialized reference, both fresh sensors, no known
disturbance and independent protection margins. Two acceptable completed trials
can grow the trial duration gradually. Trials remain capped at one hour without
qualified electricity and initially two hours with it. Repeated qualified longer
episodes can extend that ceiling by at most 50%, up to eight hours; this prevents
a permanent two-hour learning ceiling. The permitted cooling depth also grows
gradually from 1°C toward 3°C while retaining independent protection margins.
Trials use one OFF period and require
observed recovery before another experiment. Below two hours of validated support,
economic candidates also use one OFF period, preventing many short pauses from
bypassing sparse-duration evidence. Mature multi-peak schedules retain heat debt
and cap accumulated OFF time until comparable local recovery.

For trials with unqualified electricity, an explicit exploration allowance caps
the uncertainty deduction at half the positive modeled timing benefit. The full
uncertainty remains disclosed separately; warmth cost, residual debt and physical
limits still apply. This permits useful short experiments without presenting them
as validated economic dispatch. Flat prices and zero aggressiveness still request
normal availability.

Planning margins derive from whole-episode errors and supported OFF duration,
continue growing beyond six hours and do not use a long recovery tail to make a
short OFF experiment appear representative of longer cooling. Electricity
uncertainty uses full episode energy errors or native kW error multiplied by OFF
hours, with explicit kWh units. See the [independent simulation audit](garage-simulation-audit.md).

`predictGarageStep` ignores supplied actual power/fan/defrost by default. The
explicit `conditional: true` option is for elapsed-interval assessment only.
`forecastGarage` reconstructs an allowlisted future input object: availability,
forecast outdoor temperature, restart context and EV plans known at decision
time. Actual future electrical/fan/defrost data cannot enter its dynamics. EV
plans require `knownAt <= decisionAt`; uncertainty discounts prospective warmth,
and protection grants none. Candidate and reference use the same EV assumptions.

## Economic schedules and bounded computation

`garage-warmth-cost-v1` maps aggressiveness to a stable euro cost per modeled
cooling degree-hour: `0.012 * ((100 - aggressiveness) / 50)^2`. Zero aggressiveness
always requests normal availability. The mapping never rescales to today's price
spread and does not promise an 80% savings quota.

The planner searches all contiguous available price/weather intervals, up to
48 hours in 15-minute default steps, with a fixed beam of at most 35 states.
Every candidate includes preparation (normal availability), any number of bounded
OFF periods, recovery/continuation and an explicit terminal heat-equivalent debt.
Native regulation is predicted through all phases; preparation never raises the
thermostat. Minimum ON/OFF dwell, two separate projected heat reserves and
restoration margins constrain candidates. Restoration remains the fallback if a
discretionary dwell would conflict with protection.

Candidate search uses a fixed set of warmth weights independent of the owner
slider. The final selection scores the same candidate set with the requested
weight, preserving monotonically relaxed cooling preference as aggressiveness
increases. Equivalent candidates prefer fewer transitions and less cooling.
Joint search can conserve warmth through a small early peak for a later larger
one and does not require complete recovery between every pair of peaks.

The pure timing comparison prices the candidate's same electricity quantity at
the normal reference's average price, then subtracts its scheduled cost. It
therefore gives exactly zero at constant prices. Permanent energy reduction is
not a timing reward. A separate model bill estimate includes quantity effects and
is labelled counterfactual/provisional. Terminal debt is an effective conversion
of positive rear/front/memory differences using bounded learned heat gain. It is
not measured thermal storage; its conservative fixed memory multiplier is an
explicit v1 assumption. Unknown continuation electricity is charged at least the
highest known outlook price, never assumed cheap. The timing score additionally
subtracts residual recovery liability and native-error/price-spread uncertainty.
A capacity-limited normal forecast leaves heating available rather than lowering
the reference to rationalize more OFF time.

For an existing host thermal episode, `referenceInitialState` retains the frozen
normal trajectory and full outstanding heat debt. New dispatch economics compare
against native-ON continuation from the same actual state and subtract only debt
added beyond that continuation; previously earned savings are not counted again.
This permits another device pause within the same host accounting episode while
retaining the original recovery obligation.

A continuing device pause retains its original endpoint. Renewal does not pay the
entry uncertainty/initial transition preference again, but must still retain
positive future continuation benefit, valid evidence and protection allowance.
Planner ticks authorize renewal; network or UI polling cannot sustain a stalled
planner. Runtime frozen episode accounting is separate from current refits.

A local 48-hour synthetic benchmark with ordinary 7/40 c/kWh tariffs took about
80–165 ms per complete search on the development host. This is development timing,
not a Raspberry Pi 5 guarantee. The model checkpoint is below 25 KB in tests and
contains no growing history. Journals and background replay supply reconstruction.

## Pure module API

All times below are numeric UTC milliseconds. Main exports are:

- `createGarageModel({ seedAt, baselineC })`,
  `updateGarageModel(model, observation, settings)` and
  `replayGarageModel(seed, entries)` return new deterministic model objects.
- Observations carry `at`, `rearC`, `frontC`, `rearAt`, `frontAt`, optional usability,
  retained/gap flags, `outdoorC`, `available`, `baselineVerified`, qualified
  `powerKw`/`powerQuality` or `activity`, `ev1Kw`/`ev2Kw` or activity flags,
  `managedPause`, `recovering` and optional local door disturbance context. Learning
  interval duration follows genuine rear source timestamps; front fitting also
  requires source endpoints within five minutes of the rear endpoints.
- `predictGarageStep(model, state, input, durationHours, { conditional })` returns
  `state`, `rearC`, `frontC`, `coreC`, `electricityKwh`, `uncertaintyKwh`,
  `electricityBasis` and each location's temperature uncertainty.
- `forecastGarage(model, { now, initial, steps, settings, knownEvPlans,
  protection })` accepts contiguous `{ start, end, outdoorC, available,
  priceCtPerKwh }` steps and returns `points`, final `state`, electricity, cost
  and uncertainty. Plans use `{ charger: 1 | 2, knownAt, start, end, powerKw |
  active, confidence, cancelled }`; newest applicable known revision wins.
- `createGarageExposure(settings)`, `updateGarageExposure(state, observation,
  settings)` and `assessGarageProtection(state, { now, observation, settings,
  forecast, restorationDelayMs })` preserve independent front/rear reference
  temperatures and assess their available heat reserves. The retained exposure
  API names do not imply degree-minute arithmetic.
- `planGarage({ now, model, exposure, observation, settings, prices, forecast,
  knownEvPlans, activeEpisode, referenceInitialState, restorationDelayMs })` returns `nextAction`
  (`available`, `pause`, `renew`), `pauseUntil`, complete phase-labelled `steps`,
  timing/model estimates, cooling burden, terminal debt, uncertainty and reasons.
  Price rows accept the existing `allInCentsPerKWh` alias. An active episode uses
  `authorizedEndAt` (or `pauseUntil`/`endpointAt`) and must represent a real active
  pause, not a recovery episode.
- `garageModelSummary` exposes honest evidence counters, independent held-out
  errors, coefficient units/provenance, normal reference and limitations for UI.

The persistent runtime records the explicit seed, algorithm and configuration for
ordered journal updates and corrections. The same update function rebuilds model
state. Unsupported versions are archival boundaries, not silently reinterpreted
journals. Protection state, frozen forecasts and observed behavior are independent of
correction-driven model replacement. Pure functions do not publish MQTT commands.

## Explicit historical reconstruction

`src/garage/history.js` provides a read-only streaming projection of completed
imported rear/outdoor observations. It preserves the existing later-import and
later-row scalar precedence, counts repeated source times once, excludes
simulation/live temperature records, and keeps original import/row/observation
provenance. Rear values never become a front sensor or an average. Legacy Home
`heat_on` commands and Home absence annotations are not garage native telemetry.

`garageHistoricalObservations(store, options)` yields normalized records and
`reconstructGarageHistory(store, options)` returns a bounded checkpoint, checksum
and explicit `garage:historical-context` summary. Defaults cap at 100,000 rear
samples; callers can select a UTC range, as-of receipt boundary and an explicit
cap up to one million. SQLite streaming and a fixed small signal map bound memory.
Unknown garage availability/power/front stay unknown. The slow observer follows
actual rear history without inventing native heating. Thermal/native heat gains
remain unidentifiable from old CSV columns, so this cannot unlock automatic OFF.

Imported charger-1 phase currents can establish activity only; qualified existing
charger-2 intervals can provide optional activity context. No watts are invented
from amperes or activity, no future readings fill earlier timestamps, and native
EV data can be excluded with `includeRecordedEvActivity: false`. Current source
time alone does not establish inactive status from an incomplete phase cohort.

Run explicit reconstruction without starting providers or writing the database:

```sh
node scripts/garage-replay.js --db /path/to/history.sqlite --input historical --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z
node scripts/garage-replay.js --db /path/to/history.sqlite --input providers
```

The second command replays the current committed garage journal using its saved
seed/configuration and selected sensor corrections. Other actual journal scopes
are `mqtt`, `offline`, and `simulated`. The CLI prints a compact evidence summary
and checksum, never raw household rows, device identifiers or private paths.
Historical observer context is not silently installed as today's live seed and
never mutates the current journal, protection reserve, episode, chart state or equipment.
