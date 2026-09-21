# Garage simple OFF simulation audit

The current audit tests `committed-garage-v4-simple-off` against an independent
simulated garage. It checks short cooling forecasts, deterministic learning,
conservative opportunity selection and separation of thermal evidence from
measured electricity. These are software experiments, not installed garage
measurements, Mitsubishi metering verification, pipe-safety validation or realized
savings.

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
2/4/8h OFF periods; this does not authorize those durations in operation. The
default configured maximum remains 2h.

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
checkpoints under 9 KB. Total electricity is substantially less accurate. The
calculation includes observed normal electrical power plus a fixed extra recovery
allowance of 125% of avoided electricity, spread over three hours. For the
15-minute fixture its 1h/2h extra allowance is 0.306/0.612 kWh; the independent
plant uses 0.154/0.284 kWh extra. The declared allowance is conservative in this
fixture, but is not a universal bound. `electricalReady` remains false in both
21-day runs despite measured normal power and good thermal validation.

Across the broader 21-scenario CLI audit, the worst 1h/2h endpoint error among
scenarios with OFF observations was 0.222°C; the untrained no-OFF prior reached
0.519°C and remained thermally unqualified. Checkpoints stayed below 18 KB. This
finite plant family is descriptive evidence, not a field confidence interval.

The independent plant's remaining core/slab deficits are retained in the audit
output. Neither a warm local sensor nor the illustrative three-hour ON envelope
establishes complete physical recovery or measured savings.

## Conservative decisions and causal bootstrap

The frozen planning audit uses 43 days of training and evaluates flat, mild,
ordinary, exceptional and repeated-peak tariffs. At the default minimum net saving
of €0.50 it skips the 7/12 and 7/40 c/kWh examples. A deliberately exceptional
7/400 c/kWh fixture selects one continuous 2h OFF window; it does not preheat or
schedule a second shutdown. These prices are stress inputs, not representative
or forecast tariffs. Positive legacy aggression values produce the same policy;
zero keeps normal availability.

The selected 43-day/15-minute fixture estimates €3.57 before its separate
uncertainty deduction; the independent 48h plant comparison produces €5.39.
These are distinct modeled counterfactuals, not an accuracy guarantee or household
saving. The remaining core/slab deficits after that window are approximately
0.025/0.023°C.

Bootstrap starts with untouched priors. Only the planner's own choices provide
OFF observations, with opportunities 56h apart. Pipe reserve starts unknown and
is earned from live synthetic temperatures; protection reports arrive each
minute while learning uses five-minute reports. Both the frozen and bootstrap
comparisons declare a **10-minute simulated restoration delay**, not an installed
heat-pump bound.

In the 42-day exceptional-price run, initial trials are 1h. Independent completed
episodes eventually support 1.25h, permitting 1.5h extension trials within the 2h
configured cap. The activity-only variant also gains thermal evidence while
retaining zero native electrical fitting samples and no electrical qualification.
Flat and ordinary tariffs produce no bootstrap experiments. Growth is deliberately
slow and can stall when recovery or estimated net saving is insufficient.

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
