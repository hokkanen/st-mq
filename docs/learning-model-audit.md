# Learning model audit and implementation decisions

This audit covers recording → committed evidence → thermal learning → equipment
response → planning → execution → cycle assessment → UI. The objective is useful
tariff control with honest evidence and reproducible learning, not the largest
possible number of fitted inputs. Synthetic tests establish software behavior;
they do not prove optimal settings or savings for the actual house.

## What changed and why

| Failure found | Implemented correction |
| --- | --- |
| A 15-minute window could inherit the controller's current phase even when a transition happened near its end. | Persist causal control-context events and split input windows at their actual boundaries. Never backfill unknown history from current settings. |
| Separately averaging compressor and reversing-valve state discarded mixed heating/DHW windows. | Intersect timelines first, then integrate total and destination-specific compressor/AUX activity. |
| Extending a coverage span could change the earlier sample reconstructed from it; delayed receipt could retrospectively fill an outage. | Read stable span prefixes and require continuity of source validity and receipt availability. Keep real communication gaps. |
| Endpoint error concealed large excursions that returned to the starting temperature. Missing data discarded preceding errors. | Score complete trajectories in °C, including short complete episodes and usable fragments before barriers. |
| Sample counts could qualify coefficients whose effect was absent or confounded. | Test observed-input sensitivity and independent variation before fitting. Keep unsupported coefficients fixed. |
| Reduction imposed an artificial compressor-capacity ceiling. Preheat received extra heat merely because it was requested. | Separate observed thermal input from estimated equipment response. A reduction can run the compressor fully. No direct preheat heat credit. |
| The slow state could not charge before the room warmed. | Put hydronic heat into a slow node with conservation-weighted exchange; keep the unobserved topology/memory constants explicit priors. |
| A thermal fit could authorize a long economic action without tested control response. | Require separate conditional thermal, equipment-response and frozen advance-cycle checks; limit durations and boosts to repeated evidence. |
| Sparse weekly cycles could never fit three held-out episodes into a short rolling tail. | Preserve complete episode samples and reserve the latest three episodes chronologically once enough exist, with an embargo. |
| A queued plan could start using stale benefit calculations. | Re-evaluate the promised schedule against current evidence, settings, prices and weather before dispatch. |
| Multiplying every reduction by every preheat duration/boost could block the control loop for seconds. | Evaluate the reduction grid first, then expand a bounded set of promising preheat choices while retaining trial opportunities. This remains an approximate search. |
| Trial admission and continuation used different safety criteria; coupled pulses and acknowledgement latency could prevent useful trial exposure. | Reuse the bounded trial stress check while active; account for pulse slack and actual observed exposure when growing support. |
| Completed interval power was charged into the following interval and price. | Integrate the current completed sample, split on price/action/input boundaries, and start the cycle at acknowledged execution time. |
| DHW compressor/AUX costs contaminated space-heating calibration and profit. | Keep attributed space-heating energy and recovery AUX separate; show covered total costs independently. Whole-cycle profit remains unavailable without a DHW service model. |
| A newer model's reserve could make an older cycle appear recovered. | Maintain an observer with the frozen cycle model. Missing thermal input invalidates its reserve claim. |
| Failed attempts disappeared from completed-only benefit means. | Show all-attempt outcomes, incomplete counts, covered costs and missing hours alongside the completed subset. |
| Recovery immediately enabled native AUX; manual setting changes could then be overwritten. | Default to bounded compressor-only recovery with a latched comfort/control fallback. Persist external-change revisions and respect them during active cycles. |
| A plausible but corrupted checkpoint could be trusted merely because its cursor existed. | Check a state/configuration digest and journal-prefix identity, otherwise replay. This detects accidental corruption, not malicious alteration. |

## Inputs and fitted complexity

The current thermal model has **six coefficients**, with **zero to four fitted**
according to evidence. The usual first eligible pair is heat loss and compressor
response. Solar and auxiliary gains require independent observations. Exchange
rate and reserve time remain fixed structural priors. Compressor and auxiliary
effects are separate throughout.

Four quantities physically drive thermal prediction: outdoor temperature, archived
solar radiation, observed space-heating compressor duty and observed space-heating
auxiliary electrical power. Indoor temperature is the measured state/output; the
second temperature is latent. Requested phase, ROOM boost and comfort target are
three additional equipment/control-context values. Thus the drawer has **eight
model-input charts**, including the measured indoor endpoint. Neither eight charts
nor all recorded channels imply eight freely fitted coefficients.

Requested-mode compressor-response ratios are separate estimates, shrunk towards
unchanged normal demand using episode counts rather than quarter-hour row counts.
Electrical ratings, recovery multiplier, auxiliary-risk allowance and native
integral/hysteresis settings are also separate from thermal coefficients. Current
integral and supply shortfall inform only the observed mode and near-term forecast.
Electricity price determines the objective and action timing; it is not a thermal
regression input.

The removed `reducedHeatCPerHour` and `preheatCPerHourPerDegree` were poor thermal
degrees of freedom: observed duty already explains delivered compressor activity,
and simultaneous ROOM/DHWR requests cannot independently identify an extra heat
source. Their removal is a substantive simplification, not a renaming.

## Recording priorities and channel diagnostics

Recording retains equal normalized priorities. No model feedback or default-off
priority switch was added: useful automatic weighting would require a stable
definition of downstream error, uncertainty and competing recording uses. Garage
and diagnostic channels remain valuable recordings even when the thermal model
does not fit them. The recorder does not import the learner or its coefficients.

The model exposes coefficient eligibility, observed variation and perturbation
sensitivity. These answer whether current evidence can distinguish effects; they
are **not** channel-value percentages or promised accuracy improvements. A credible
channel-value score needs repeated chronological ablations with refitting. A
recording-precision benefit score additionally needs paired replay under actual
channel error bounds, assessed on temperature, runtime, recovery and cost. A local
derivative alone cannot estimate how much a better sensor or more storage would
improve decisions. Those unvalidated payoff scores are deliberately deferred.

## Reconstruction and original constraints

Reconstructing the model from the database remains a requirement. The immutable
learning journal records causal input segments, configuration snapshots, archived
forecast identity, context, episodes and an explicit seed where needed. The current
algorithm replays the same ordered operations after a restart or corrupt checkpoint.
The original recordings and context also remain available for future re-training.
Version `committed-house-v3` distinguishes the new interpretation; older journal
versions remain archival and are not silently interpreted as identical new-model
history. Imported CSV formats, timestamps, units, duplicate handling and provenance
remain unchanged.

Reconstruction itself does not reduce the best achievable model quality. Lossy
recording can: discarded excursions, source timing and unobserved equipment states
cannot be recovered by replay. The interval/joint-attribution fixes preserve useful
information already available in the database without changing channel priorities.
Old CSV files do not contain compressor destination, AUX or solar measurements;
the new code does not invent them to pass validation.

The earliest implementation fitted three coarse thermal terms and did not model
the present range of states and actuators. Its smaller search space was an advantage
under sparse data, but it lacked important mechanisms and could not establish
equipment response from requested tariff states. Later versions added eight thermal
terms; reducing unsupported freedom restores some of that discipline while keeping
separate compressor/AUX input and slow thermal memory. The user's reconstruction,
scarcity and separation constraints are sound. Their earlier implementation caused
specific defects; there is no evidence that removing the constraints would improve
actual out-of-sample performance.

## Remaining practical limits

The slow-state topology and constants still need house-specific validation.
Internal gains, open windows, changing emitter behavior, DHW demand, defrost and
weather forecast error can cause residual errors. Nominal electrical input is not
heat metering or COP. Correlated observations and repeated holdout use mean empirical
error envelopes are not statistical confidence probabilities. Frozen advance
checks help, but observational counterfactual references cannot prove causal savings.

The next model expansion should be driven by retained residuals and prospective
cycle evidence. Examples are a better identifiable slow-state model, measured
electrical/thermal calibration, and a DHW service model. It should first beat the
current simpler model on independent completed episodes, including bad outcomes,
before gaining control authority.

The independent 14-day simulator regression starts with the application's default
memory priors and supplies no hidden plant state. Fitting heat-loss and compressor
gains achieved about 0.079°C held-out trajectory MAE, compared with 1.165°C from the
unchanged prior and 0.438°C from persistence. This is one software benchmark, not
an accuracy guarantee for the installed house or evidence of economic savings.
