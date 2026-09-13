# Garage learning, protection and planning

Garage uses `committed-garage-v1-coupled`, separate from Home's learning algorithm,
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

Each external sensor has its own persisted degree-minute index. For every known
interval the index gains the integral of `max(0, floorC - localTemperatureC)` over
minutes. Version `garage-exposure-v1` uses exact integration of the positive part
of a linear segment between temperatures. With the illustrative defaults, the
floor is 4°C, the hard minimum is 2°C and the budget is 120°C·minutes per location.
Reaching either the hard minimum or the independent budget forbids a pause.

Recovery requires continuous local temperature at least 6°C for 30 minutes before
credit starts, then subtracts 0.25°C·minutes per warm minute, never below zero. A
brief warm report, the other location warming, changing aggressiveness, restoring
native ON, model refitting and reconnecting do not reset this state. Missing
history accumulates a conservative index using at least the floor-to-hard-limit
rate, marks the history uncertain and earns no recovery. Uncertainty clears only
after known continuous warm recovery has repaid that location's index. A gap index
is a conservative accounting bound, not a reconstructed temperature measurement.

`maxSensorAgeMs` defaults to two minutes and is an engineering setting which must
match the installed sensors' genuine reporting contract. Receipt of a retained
packet or heartbeat does not refresh a temperature. New reports with unchanged
values do count as new evidence. Both locations must be fresh for every automatic
pause even when historical/monitoring configuration permits rear-only data.
`frontRequired` additionally records the owner's front commissioning context;
removing a front sensor is not an automatic reaction to stale data.

Protection forecasts use independent lower-temperature trajectories and assume
both EVs can stop charging. The runtime adds remaining accepted local permission
and restoration/recovery delay. Neither the thermal memory nor a pump internal
sensor substitutes for either external protection measurement.

## Coupled thermal model

The estimated state has rear air temperature, slow rear-derived thermal memory,
and front-minus-rear difference. The rear derivative fits bounded coefficients
for outdoor loss, exchange with memory, qualified electrical heat response or a
separate activity response, and both EV inputs. The front-difference derivative
fits relaxation, additional local loss and effective differences in pump/EV heat
distribution. A fixed 18-hour rear-to-memory exchange is a structural prior, not
measured wall/floor temperature or stored kWh. Five-minute integration substeps
keep predictions bounded. No Home hydronic coefficients or heat path is reused.

Projected recursive ridge updates retain fixed-size coefficient/covariance arrays
and evidence counters. Inputs use degrees C, hours and qualified kW; activity is
separate dimensionless evidence, never silently converted to measured watts.
Coefficients have explicit finite bounds. Local front plunges strongly downweight
front parameter fitting while still fully affecting the front state, prediction
and protection. They do not overwrite rear memory. Sustained unexpected rear
cooling gradually corrects the memory observer when the expected rebound fails.
Optional door disturbances can suppress ordinary fitting without inventing
unobserved door events. Solar is deliberately excluded in this version until a
versioned model comparison shows held-out improvement.

Both EV identities and their power/activity units remain separate. Their initial
power and activity heat coefficients are shared. Per-charger and spatial response
is released only after each charger has at least 24 independently active intervals
with the other known inactive and no door disturbance. Coincident charging alone
cannot identify separate effects. This is effective garage temperature response,
not vehicle charging efficiency or measured heat delivered by a car. Future plans
never start charging for garage heating and do not alter vehicle priorities.

The normal reference starts uninitialized at the configured baseline, without a
hard-coded near-pipe offset. It learns achieved rear temperature only with verified
native baseline, continuous availability for at least eight hours, stable rear
temperature, and no known EV/door disturbance. Twelve qualifying observations
initialize the reference. A pause or recovery excludes reference learning for at
least 48 hours. Once initialized, cold departures exceeding 0.5°C cannot pull the
reference down. Baseline changes establish a recorded fresh model epoch; they do
not command a temperature boost. The current small outdoor slope remains an
explicit prior while intercept learning tracks comparable achieved observations.

## Validation and advance electricity

The final six hours of every 24-hour block relative to the saved seed are withheld
from coefficient and normal-reference fitting. The model records one-step errors
before consuming outcomes, separately for rear, front, advance rear/front, native
electricity, and OFF-only rear/front. Observed interval inputs may support
conditional thermal validation; advance prediction uses preceding information.
These are temporally held-out one-step diagnostics, not a claim of independent
multi-day forecast calibration. Sensor observer updates continue during validation.

Automatic economic planning requires an initialized reference, at least 24 rear
and 12 front fitted intervals, six fitted OFF intervals, six held-out observations
at both locations, three held-out OFF observations at both locations, and bounded
advance/OFF errors. These gates cannot be replaced by a completion percentage.
Rear-only historical intervals can fit supported rear responses and update thermal
memory; they never invent front temperatures or front validation evidence. Source
timestamps, source quality/gaps and configuration remain in committed inputs.

Native availability permits native demand regulation, including idle; it does not
force electrical output. A separate bounded electrical response fits measured
power against cold-weather demand, rear-reference deficit and observed restart
context. Before sufficient electrical evidence, predictions retain the explicit
`prior-modeled-electricity` label. An activity-only thermal fit can be useful while
recorded-energy timing remains unavailable. Observed OFF standby electricity is
counted when qualified, without calling it delivered heat.

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
thermostat. Minimum ON/OFF dwell, two separate projected exposure histories and
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
  forecast, restorationDelayMs })` preserve independent front/rear indices.
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
journals. Exposure, frozen forecasts and observed behavior are independent of
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
never mutates the current journal, exposure, episode, chart state or equipment.
