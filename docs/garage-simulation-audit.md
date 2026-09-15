# Garage simulation audit

This audit compares the previous coupled learner with `committed-garage-v2-sparse`
using an independent simulated garage. The main data rate is three useful OFF
opportunities per week. The sparse fit removes a large sampling-cadence failure
and predicts the simulated garage accurately with much less fitted complexity.
These are reproducible software experiments, not measurements of the installed
garage, verification of native metering, or evidence that a water pipe is safe.

The numerical planner results below record the original audit under the earlier
exposure policy. The current `garage-thermal-reserve-v1` policy changes pause
admission and restoration checks while preserving the learned garage equations.
Current runs can therefore choose different pauses; these historical totals are
not asserted as fresh results for the new protection model. The separate
[protection notes](garage-protection-defaults.md) describe its parameters and
validation requirements.

## Independent experiment

`test/helpers/garage-plant.js` does not import the garage predictor. Its physical
equations contain rear/front air, two different slow masses, inter-location
coupling, weather-dependent heat delivery, a heat-output lag, native thermostat
modulation, and different heat effects from the two vehicles. Integration uses
one-minute steps. The fitted model has one slow mass and fewer adjustable terms,
so the experiment includes structural mismatch rather than generating truth with
the function being tested.

The 21 scenarios contain 336,513 observed rows spanning 966 simulated days in
total. Main runs last 42 days, with an opportunity every 56 hours and durations
cycling through 2, 4 and 8 hours. Weekly and fortnightly cases run for 84 days.
Other cases vary sensor cadence (1/2/5/15 minutes), independent noise seeds,
quantization, doors with and without contacts, separate EV charging, observation
gaps, mass time constants, recovery strength, heat loss and cold weather. The
activity-only cases supply fractional duty or boolean activity with no electrical
observations. The `no-excitation`
scenario has no OFF opportunities; weather still varies, so its name does not
mean literally zero information in ordinary operation.

At the end of training, coefficients are frozen. Four independent branches run
1, 2, 4 or 8 hours OFF followed by 24 hours of native recovery. Forecasts start
from observed temperatures and the learner's estimated memory. Future measured
power, temperatures, activity, fan and defrost are never passed to them. The
experiment supplies perfect outdoor forecasts to isolate thermal and native
response errors; operational weather-forecast errors remain additional.

Comparators are the fitted sparse model, its fixed coefficient priors with the
same learned reference and initial state, a fitted single-node cooling model
with a fixed three-hour recovery time, and temperature persistence. The simple
comparators have no electrical predictions. Evaluation uses the complete
trajectory and endpoint errors, total electricity, and extra recovery electricity
relative to a parallel continuously available physical garage. Residual mass
debt is retained after the recovery window.

## Results

The prior implementation is the model and settings from Git revision
`e0b0c1155660729b2ffa01f82a03b752b1097741`. Signed errors below are forecast minus
physical simulation. Electricity is the 24-hour recovery window; OFF consumption
in the fixture is zero.

| Scenario | Previous 8h endpoint rear/front error °C | Sparse 8h endpoint rear/front error °C | Previous → sparse electricity error kWh |
| --- | ---: | ---: | ---: |
| Three weekly, 1-minute observations | +0.972 / +0.829 | +0.014 / −0.010 | +30.404 → −0.291 |
| Three weekly, 2-minute observations | −4.860 / −4.729 | +0.016 / −0.007 | −2.709 → −0.307 |
| Three weekly, 5-minute observations | +0.087 / +0.163 | +0.034 / +0.013 | +0.400 → −0.187 |
| Three weekly, 15-minute observations | +0.002 / −0.070 | +0.035 / +0.016 | −0.052 → −0.021 |
| Fortnightly opportunities | −0.593 / −1.353 | +0.060 / +0.054 | −0.670 → +0.205 |
| Slower, heavier masses | −0.013 / +0.152 | −0.247 / −0.265 | +1.610 → −0.129 |
| Faster, lighter masses | +0.191 / +0.010 | +0.306 / +0.279 | −0.067 → +0.158 |
| Coarse, noisier sensors | −0.024 / −0.370 | +0.094 / +0.068 | +1.766 → −0.314 |
| No OFF opportunities | −1.876 / −2.757 | +0.319 / +0.296 | −1.700 → −1.140 |

The previous one-minute case learned a heat response of approximately
0.05°C/kWh, while the two-minute case learned 3.85°C/kWh from the same physical
garage. The sparse version learns approximately 0.64–0.66°C/kWh at all four
cadences. A fixed per-observation forgetting factor and excessive freedom were
material defects, not merely a theoretical risk from counting coefficients.

Across the 18 cases with metering and deliberate OFF opportunities:

| OFF duration | Median absolute rear/front endpoint error °C | Worst rear/front endpoint error °C | Median absolute total recovery electricity error |
| --- | ---: | ---: | ---: |
| 1h | 0.033 / 0.033 | 0.060 / 0.078 | 1.9% |
| 2h | 0.016 / 0.028 | 0.044 / 0.067 | 1.8% |
| 4h | 0.029 / 0.025 | 0.095 / 0.082 | 1.7% |
| 8h | 0.034 / 0.027 | 0.306 / 0.279 | 1.0% |

Mean whole-trajectory temperature RMSE over these 72 branches is 0.047°C for
the sparse model, 0.485°C for the fixed priors, 0.155°C for the single-node
baseline, and 0.388°C for persistence. This is a descriptive average across
chosen scenarios, not a confidence interval or an estimate of field accuracy.

Total recovery energy includes ordinary maintenance heating. It is therefore
easier to predict accurately than the extra energy attributable to a pause.
For the nominal five-minute case, actual extra recovery is 0.60/1.15/2.10/3.69 kWh
after 1/2/4/8 hours OFF; errors are +0.02/+0.04/+0.11/+0.27 kWh. In the slower,
heavier-mass case, those errors increase to +0.08/+0.20/+0.50/+1.18 kWh, or
approximately 16–41% of the extra recovery. The four-hour case overestimates
recovery by approximately 29%. This is a real limitation of fixed memory despite
good air-temperature accuracy. The low total-energy percentages above must not
be described as 1–2% precision for pause-related recovery energy or savings.

The sparse model does not win every case against the larger learner: extra mass
flexibility helps the previous model in some long-horizon mass-mismatch cases.
Keeping memory fixed accepts that tradeoff while avoiding unstable estimation
from routine readings. The new readiness check supports four-hour economic
pauses in these runs; the eight-hour branches are deliberately longer stress
forecasts, not newly granted operating authority. Activity-only data qualifies
thermal learning but never electricity, and the no-OFF case remains unqualified.

## Planning and defaults

`scripts/garage-planning-simulation.js` trains on the independent plant, evaluates
flat prices, a 7/12 c/kWh mild peak, a 7/40 c/kWh ordinary peak and two ordinary
peaks, and compares aggressiveness 0/25/50/75/100. It executes each frozen plan on
the physical plant and compares it with a continuously available branch. Both
continue heating for another 24 hours at 7 c/kWh, and the output reports remaining
rear/front/core/slab debt explicitly. The reported bill differences are simulated
counterfactuals and include quantity effects; they are separate from the planner's
modeled timing benefit.

The midpoint already takes ordinary opportunities and both peaks. Flat prices
and aggressiveness zero leave heating available. The milder setting rejects
small opportunities that the midpoint accepts. These experiments support keeping
the default aggressiveness at 50 and the existing 0.012 warmth-cost scale; they
do not establish the handout's suggested 80% benefit target for actual household
history. Protection settings are assessed separately in the
[reference heat-reserve and pipe audit](garage-protection-defaults.md).

The final midpoint results were:

| Tariff | Total OFF in 24h plan | Modeled timing benefit | Simulated bill difference including 24h recovery | Minimum front air |
| --- | ---: | ---: | ---: | ---: |
| Flat 7 c/kWh | 0h | €0 | €0 | 5.92°C |
| Four-hour 12 c/kWh peak, otherwise 7 | 0.25h | €0.007 | €0.010 | 5.92°C |
| Four-hour 40 c/kWh peak, otherwise 7 | 4h | €0.684 | €0.939 | 4.69°C |
| Two three-hour 40 c/kWh peaks, otherwise 7 | 6h | €1.041 | €1.524 | 4.59°C |

After the extra recovery, the ordinary case still has 0.060°C core and 0.057°C
slab deficit relative to its continuously available branch; the two-peak case
has 0.100°C and 0.086°C respectively. Those differences are why the simulated
bill difference should not be interpreted as a fully settled, realized saving.

## Bootstrap and remaining limits

The `--bootstrap` mode starts from priors and streams only observations resulting
from the planner's own choices. It offers 18 ordinary price peaks over 42 days,
with a full recovery/continuation interval between decisions. Metered, fractional
activity and boolean activity variants are separate. No readiness flags, coefficient fits, OFF
episodes or recovery outcomes are inserted manually.
This mode exercises the planner and learner; it does not emulate adapter
acknowledgements, permission leases or the complete runtime restoration loop.

Under the thermal-reserve policy, the bootstrap supplies a protection report
every minute while keeping its original five-minute learning cadence. Extra
reports use an independent noise generator; learning reports and the planner's
causal input at those boundaries retain the original random sequence. Protection
starts with unknown thermal history and earns reserve through the first 40 hours
of observed normal heating. A five-minute learning interval is not relabelled as
continuous two-minute sensor coverage.

The frozen-plan comparison instead declares already-warm synthetic reference
objects, separate from installation initialization. Both modes explicitly supply
a **10-minute simulated useful-heating response allowance**, preserving the
earlier comparison's assumed delay. The report records that allowance and the
protection version. It is not a material-property calculation or an installed
restoration bound, and it can be changed through the script's function options.

This additional experiment exposed two control defects beyond model fitting:
an electrical uncertainty penalty could suppress every initial activity-only
trial, and a planner with a short validated duration could repeatedly split a
single peak into short pauses rather than gain evidence from a longer contiguous
trial. The implementation addresses both while retaining separate qualification
for electrical economics and the observed episode recovery requirement.

In the final metered run, the planner starts with 30-minute trials, increases to
45 minutes and then 1.25–2 hours, reaches two hours of validated economic support
around day 27, and subsequently tries 3–4 hours. By day 39 it supports three-hour
economic pauses. The run totals 39 OFF hours over 42 days. Larger trials still
require the independent temperature/protection checks; a hard two-hour trial ceiling
would otherwise have prevented further learning permanently.

Boolean activity reaches one hour of thermal support by day 39. It has zero
electrical fitting samples and never qualifies electrical economics. Fractional
activity produces only one 30-minute trial in this price/weather run and remains
unqualified. This limited result is retained rather than reducing uncertainty
until every scenario produces a desired learning outcome. Initial trials have an
explicit bounded exploration allowance; the full estimated uncertainty remains
reported, and taking a trial does not create electrical evidence.

The plant family is finite and shares broad heat-transfer structure with the
model. Unknown draughts, changed sensor placement, equipment faults, unsupported
native electrical data, forecast weather error and the installed garage's true
thermal mass can produce larger errors. The saved whole-episode errors and
duration gates therefore remain necessary after these tests pass. No trial is
authorized because a simulated copper pipe happened not to freeze.

## Reproduction and resource use

```sh
node --test test/garage-simulation.test.js
node scripts/garage-simulation-audit.js --json /tmp/garage-audit.json
node scripts/garage-planning-simulation.js --json /tmp/garage-planning.json
node scripts/garage-planning-simulation.js --bootstrap --json /tmp/garage-bootstrap.json
```

The complete JSON output includes each scenario's assumptions, seed, coefficients,
readiness, supported duration and all four forecast branches. A single case can
be selected with `--scenario three-weekly-5min`. `--model /path/model.js` evaluates
another matching model implementation without changing the checkout. To reproduce
the old baseline, extract its `src/garage/model.js` and `settings.js` from the Git
revision above into the same temporary ES-module directory, and pass that model
path to the current harness.

The 21-case sparse audit took about 87 seconds in the development environment
with other tests running. Model checkpoints were approximately 5–21 KB despite
up to 60,481 observations in a case. The focused simulation tests took about
25 seconds and check cadence stability, scarce evidence, electricity separation,
independent door/mass behavior, deterministic journal replay, repeatability and
the default planner behavior. Runtime is environment-dependent; these are not
Raspberry Pi measurements. Runtime fields are the only intentionally
nondeterministic fields in repeated audit output.
