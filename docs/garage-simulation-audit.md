# Garage simple OFF simulation audit

The current audit harness tests `committed-garage-v7-room-reference` against an independent
simulated garage. It checks short cooling forecasts, deterministic learning,
conservative opportunity selection and separation of thermal evidence from
measured electricity. These are software experiments, not installed garage
measurements, Mitsubishi metering verification, pipe-safety validation or realized
savings.

The recorded results below were produced with `committed-garage-v6-source-clocks`.
The current harness explicitly supplies the independent plant's room setting;
it no longer seeds normal warmth from a separate configured baseline. The
recorded planning results also predate the current `garage-savings-strategy-v1`
selection policy. The two-rate cooling equations are unchanged, but these
results do not establish the behavior of the current strategy-dependent selection.
Current policy is documented in [Garage model](garage-model.md#one-opportunity-at-a-time);
rerun the planning commands below for results under that policy.

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

## Conservative decisions and causal bootstrap

The frozen planning audit trains against the independent plant and evaluates flat,
mild, ordinary, exceptional and repeated-peak tariffs. It compares one contiguous
OFF opportunity against unchanged native heating, without preheating or a second
shutdown. The audited policy used a default €0.50 minimum saving after recovery
and uncertainty allowances; removing duration ceilings did not remove that
economic threshold. The current Balanced strategy retains the €0.50 threshold and
also prefers a shorter window retaining at least 80% of the best benefit.
Exceptional tariffs are stress inputs, not representative or forecast prices.

Bootstrap starts with untouched priors. Only the planner's own choices provide
OFF observations, with opportunities 56h apart. Pipe reserve starts unknown and
is earned from live synthetic temperatures; protection reports arrive each
minute while learning uses five-minute reports. Both frozen and bootstrap
comparisons declare a **10-minute simulated restoration delay**, not an installed
heat-pump bound. Activity-only experiments keep normal electricity assumption-based
while independently gathering temperature evidence.

The current policy imposes no initial one-hour trial ceiling, two-hour extension
ceiling or maximum total pause. One hour remains the planned minimum. Tests must
allow opportunities longer than previously validated evidence while checking the
larger uncertainty margins and pipe reserve. The audit's finite price and weather
coverage limits each simulated opportunity naturally. Predictions, actual plant
cost differences and remaining slow-mass deficits are separate outputs; none is
a household savings claim. The short-forecast results above characterize the
unchanged two-rate thermal equations and do not establish accuracy for longer
pauses.

Avoided-power uncertainty is priced at the opportunity spread. Only optimistic
whole-episode recovery error adds a separate deduction at the recovery tariff.
Conservative recovery overprediction cannot become a second peak-price penalty
that permanently suppresses all later opportunities.

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
