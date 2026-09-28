# Garage cooling and room-target simulation audit

The current audit harness tests `committed-garage-v7-room-reference` against an independent
simulated garage. It checks short cooling forecasts, deterministic learning,
conservative opportunity selection and separation of thermal evidence from
measured electricity. These are software experiments, not installed garage
measurements, Mitsubishi metering verification, pipe-safety validation or realized
savings.

The short-forecast table below records the earlier
`committed-garage-v6-source-clocks` run. Those explicit native-OFF learner fixtures
remain unchanged. The current target-control results use
`committed-garage-v7-room-reference`, `garage-savings-strategy-v1` and
`garage-room-target-v1`; they are recorded separately below. Price automation
changes a room target while native power remains ON. It does not manufacture
native-OFF learning evidence. Current policy is documented in
[Garage model](garage-model.md#one-opportunity-at-a-time).

## Independent plant and evidence

`test/helpers/garage-plant.js` imports no garage predictor. Its equations contain
rear/front air, two slow masses, inter-location exchange, weather-dependent heat
delivery, output lag and a modulating thermostat. It also supports door openings,
charger heat, gaps and noisy or quantized sensors. The predictor deliberately has
only two OFF cooling coefficients and no latent mass. This exposes structural
mismatch instead of testing the model against itself.

Training uses preceding observations, with whole OFF/recovery episodes assigned
to training or validation. Held-out trajectories freeze the model and initial
state. Normal heating cannot fit cooling; repeated readings cannot add targets.
Door or charger disturbances, including compact interruption flags between
reports, exclude an interval from clean fitting and validation. Journal replay
uses the same update function.

The frozen forecast audit uses 1h and 2h OFF branches followed by 24h of normal
heating. Future actual power, temperatures, fan and defrost never enter the
forecast. Outdoor forecasts are perfect in this controlled experiment, so field
weather errors remain additional. Historical training deliberately includes
2/4/8h OFF periods. These durations describe the experiment; they are not
operating limits. Actual opportunities must pass the independent pipe forecast
with its uncertainty margins, including useful-heat return delay.

## Reproducible short-forecast results

The test fixture uses 21 days, seed 731 and the nominal independent plant. Signed
errors are forecast minus simulation at the OFF endpoint.

| Sensor interval | OFF | Rear error | Front error | Whole-cycle electricity error |
| --- | ---: | ---: | ---: | ---: |
| 1 minute | 1h | −0.002°C | +0.047°C | +1.90 kWh |
| 1 minute | 2h | +0.006°C | +0.049°C | +2.03 kWh |
| 15 minutes | 1h | +0.001°C | +0.050°C | +1.92 kWh |
| 15 minutes | 2h | +0.013°C | +0.054°C | +2.05 kWh |

Short cooling predictions agree closely across these sampling intervals, with
checkpoints under 12 KB. Total electricity is substantially less accurate. The
calculation includes observed normal electrical power plus a fixed extra recovery
allowance of 125% of avoided electricity, spread over three hours. For the
15-minute fixture its 1h/2h extra allowance is 0.306/0.612 kWh; the independent
plant uses 0.154/0.284 kWh extra. The declared allowance is conservative in this
fixture, but is not a universal bound. `electricalReady` remains false in both
21-day runs despite measured normal power and good thermal validation.

The broader CLI audit also exercises 21 combinations of plant behavior, weather,
disturbances and sensor quality. This finite plant family provides descriptive
evidence, not a field confidence interval. Long 6h and 30h audit branches check
that the full recovery allowance is accounted over a proportionate time window;
finite forecast errors remain visible rather than being treated as validation.

The independent plant's remaining core/slab deficits are retained in the audit
output. Neither a warm local sensor nor the illustrative three-hour ON envelope
establishes complete physical recovery or measured savings.

## Current target-control decisions and causal audit

The frozen planning audit trains against the independent plant and compares one
contiguous lower-target opportunity with the owner's unchanged normal target.
Native power remains ON in both branches. The independent thermostat may reduce
compressor demand to zero; the simulated bill still includes a declared **0.04 kW
standby allowance**, kept separate from compressor heat. This is a fixture
assumption, not installed standby metering, and differs from the planner's
conservative powered-idle allowance. The original native-OFF forecast and learning
fixtures retain their previous thermostat, electrical and thermal behavior.

The current 43-day training / 15-minute sampling run produced these results for
an exceptional four-hour 400 ct/kWh peak followed by 7 ct/kWh. These prices are
stress inputs, not representative or forecast household tariffs. The comparison
includes 24 additional hours of recovery after the planning horizon.

| Strategy | Lower-target duration | Simulated bill difference | Lowest front air | Remaining core / slab deficit |
| --- | ---: | ---: | ---: | ---: |
| Gentle | 2.5h | €6.73 | 5.15°C | 0.033 / 0.030°C |
| Balanced | 3.25h | €8.74 | 4.91°C | 0.046 / 0.043°C |
| More savings | 4h | €10.77 | 4.69°C | 0.060 / 0.057°C |

Every selected reduction retains nonzero simulated electricity. Flat, mild and
40 ct/kWh ordinary-peak cases admit no reduction in this fixture, including the
highest savings preference: powered-idle, recovery and uncertainty costs can
reject an opportunity that the previous full-OFF calculation admitted. Preference
unit tests independently exercise different monetary admission thresholds.

The causal audit starts from untouched priors, with opportunities 56 hours apart.
Pipe reserve starts unknown and is earned from synthetic temperatures; protection
reports arrive each minute while learning uses five-minute reports. Lower-target
and subsequent recovery intervals are marked disturbed for the unchanged learner.
In the current 42-day, seed-731 run, reductions totalled **58.5 hours and 2.34 kWh**.
Native OFF hours, completed OFF validation episodes and validated OFF duration
all remained **zero**; thermal readiness remained false. Thus target opportunities
can use conservative extrapolation without claiming they learned an OFF curve.
Boolean compressor activity does not change that boundary or create electricity
qualification. The model checkpoint was 2,799 bytes in this finite run.

Both planning audits declare a **10-minute simulated heating-response delay**,
not an installed heat-pump bound. They retain protection's independent no-heat
trajectory and its uncertainty margins. Price/weather coverage and protection
limit each opportunity; there is no invented initial trial or total-duration
ceiling. Predictions, simulated cost differences and remaining slow-mass deficits
are separate outputs. Neither warm air nor these software results establishes
pipe safety, complete physical recovery, installed memory qualification or
household savings. Focused planning, causal-audit and standby-separation tests
passed for this revised caller; actual native-OFF learning tests also continue to
pass without changing the learned model equations.

Avoided-power uncertainty is priced at the opportunity spread. Only optimistic
whole-episode recovery error adds a separate deduction at the recovery tariff.
Conservative recovery overprediction cannot become a second peak-price penalty
that permanently suppresses later opportunities.

## Running the checks

```sh
node --test test/garage-model.test.js test/garage-sparse-learning.test.js test/garage-planning-evidence.test.js test/garage-trial-bootstrap.test.js test/garage-simulation.test.js
node scripts/garage-simulation-audit.js --json /tmp/garage-model-audit.json
node scripts/garage-planning-simulation.js --json /tmp/garage-planning-audit.json
node scripts/garage-planning-simulation.js --bootstrap --json /tmp/garage-bootstrap-audit.json
```

The focused tests specify the 21-day forecast and 43-day planning options above;
the broader model CLI defaults to 42-day scenarios. Its output is exploratory and
may expose worse errors for other plant/weather combinations. Adapter authority,
recovery continuity and installed pipe protection have separate tests; these
simulations cannot substitute for them. See [model assumptions](garage-model.md)
and [reference-pipe protection](garage-protection-defaults.md).
