# Learning model design and limits

This design covers recording → committed evidence → thermal learning → equipment
response → planning → execution → cycle assessment → UI. The objective is useful
tariff control with honest evidence and reproducible learning, not the largest
possible number of fitted inputs. Synthetic tests establish software behavior;
they do not prove optimal settings or savings for the actual house.

## Design rationale

| Risk | Design response |
| --- | --- |
| Separate compressor/AUX responses could be indistinguishable during correlated operation. | Convert source input to estimated thermal kWh and fit one downstream hydronic response; preserve source uncertainty and independent electricity accounting. |
| Restricted valves make ROOM-only evidence a poor guide to slab charging. | Record actual override mode and treatment identity; fixed slab states preserve stored heat through relay changes. |
| A controller crash could leave a remote floor override active. | Require a verified device-local lease before enabling floor control. The planned SONOFF interface is not implemented; activation remains blocked. |
| A 15-minute window could inherit the controller's current phase even when a transition happened near its end. | Persist causal control-context events and split input windows at their actual boundaries. Never backfill unknown history from current settings. |
| Separately averaging compressor and reversing-valve state discarded mixed heating/DHW windows. | Intersect timelines first, then integrate total and destination-specific compressor/AUX activity. |
| Extending a coverage span could change the earlier sample reconstructed from it; delayed receipt could retrospectively fill an outage. | Read stable span prefixes and require continuity of source validity and receipt availability. Keep real communication gaps. |
| Endpoint error concealed large excursions that returned to the starting temperature. Missing data discarded preceding errors. | Score complete trajectories in °C, including short complete episodes and usable fragments before barriers. |
| Sample counts could qualify coefficients whose effect was absent or confounded. | Test observed-input sensitivity and independent variation before fitting. Keep unsupported coefficients fixed. |
| Reduction imposed an artificial compressor-capacity ceiling. Preheat received extra heat merely because it was requested. | Separate observed thermal input from estimated equipment response. A reduction can run the compressor fully. No direct preheat heat credit. |
| The slow state could not charge before the room warmed. | Put hydronic heat into a slow node with conservation-weighted exchange; keep the unobserved topology/memory constants explicit priors. |
| A thermal fit could authorize a long economic action without tested control response. | Require separate conditional thermal, equipment-response and frozen advance-cycle checks; limit action durations to repeated treatment-specific evidence; preheat uses one configured ROOM increase, default +5 °C, above the saved normal setting. |
| Sparse weekly cycles could never fit three held-out episodes into a short rolling tail. | Preserve complete episode samples with causal thermal warmup, and reserve the latest three episodes chronologically once enough exist, with an embargo. |
| A queued plan could start using stale benefit calculations. | Re-evaluate the promised schedule against current evidence, settings, prices and weather before dispatch. |
| Multiplying every reduction by every preheat duration/boost could block the control loop for seconds. | Evaluate the reduction grid first, then expand a bounded set of promising preheat choices while retaining trial opportunities. This remains an approximate search. |
| Trial admission and continuation used different safety criteria; coupled pulses and acknowledgement latency could prevent useful trial exposure. | Reuse the bounded trial stress check while active; keep fixed ROOM/floor deadlines independent of normal DHWR, and use actual observed exposure when growing support. |
| Completed interval power was charged into the following interval and price. | Integrate the current completed sample, split on price/action/input boundaries, and start the cycle at acknowledged execution time. |
| DHW compressor/AUX costs contaminated space-heating calibration and profit. | Keep attributed space-heating energy and recovery AUX separate; show covered total costs independently. Whole-cycle profit remains unavailable without a DHW service model. |
| A newer model's reserve could make an older cycle appear recovered. | Maintain an observer with the frozen cycle model. Missing thermal input invalidates its reserve claim. |
| Failed attempts disappeared from completed-only benefit means. | Show all-attempt outcomes, incomplete counts, covered costs and missing hours alongside the completed subset. |
| Unbounded recovery restrictions can delay hot-water service; releasing all restrictions when rooms are cold can redirect capacity. | Use one 60-minute AUX/DHW/DHWR hold. A latched cold-average fallback releases AUX only; normal DHW settings and scheduled circulation resume at the original deadline, independently of thermal assessment completion. |
| Ending the valve override could prematurely reduce the floor uncertainty allowance. | Keep the explicit slab allowance at 0.15√h °C in every valve mode because stored heat and its uncertainty persist. |
| A plausible but corrupted checkpoint could be trusted merely because its cursor existed. | Check a state/configuration digest and journal-prefix identity, otherwise replay. This detects accidental corruption, not malicious alteration. |

## Inputs and fitted complexity

The current model has **four learnable thermal responses**: heat loss, combined
hydronic heat response, solar response and fireplace response. The usual first
eligible pair is heat loss and hydronic response. Exchange and memory are fixed
structural priors. Optional slab capacity, allocation, exchange and ground boundary
are also explicit fixed priors. There is no automatically fitted storage parameter.

The fixed DHP-H 10 performance map converts observed routed compressor duty to
estimated thermal kW; estimated space-heating AUX kW is then added. One
`hydronicCPerKwh` coefficient acts on that sum. Electrical costing remains separate.
The two manufacturer B0/W35 and B0/W45 points support water-temperature
interpolation, not a brine correction or a metered-heat claim. Extrapolation,
missing operating temperatures and an unconfirmed installed model add uncertainty.
The default is `0.75/9.4`, not a carryover of old fitted compressor/AUX evidence.
[Equations and limitations](learning-and-control.md#what-learns) also appear in the
combined parameter's UI fold.

Indoor temperature remains the observed output. Outdoor and solar inputs, original
compressor/AUX inputs, derived hydronic heat, valve mode, requested phase, ROOM
boost and comfort target are retained as distinct chart views. Firewood additions
and modeled delayed release remain separate. The number of chart choices is not
the number of fitted parameters. A sent valve command is not confirmed open flow.

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
Replay requires the saved configuration and matching algorithm version. Development
databases can be recreated for model changes; imported CSV formats, timestamps,
units, duplicate handling and provenance remain unchanged.

The four fitted-coefficient chart choices use the same per-entry learning operation
in a read-only replay. They derive steps and provenance in memory without recording
coefficient history or updating the controller checkpoint. Unsupported journal
segments are shown as gaps, and newer model states are never backfilled into older
dates. Initial estimates remain visibly distinct from fitted and retained values.

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
separate compressor/AUX observations, a shared thermal response and explicit slow memory. Reconstruction, limited evidence and separation of thermal response from
electrical accounting remain design constraints. Additional model freedom needs
independent evidence of improved predictive performance.

## Remaining practical limits

The slow-state topology and constants still need house-specific validation.
Comfort checks use only the same fixed indoor average as the model, with one
continuously learned normal reference. There are no fitted room models or individual
room vetoes. A one-room control estimate follows remaining-room movement from a
complete baseline with extra uncertainty; it cannot supply training or measured
validation outcomes. A separate runtime heat-reserve state can advance during
that estimate only through continuously covered actual equipment inputs; input
gaps select Normal. A cycle with missing measured indoor outcomes remains
unassessed even if its control recovery finishes. Automatic preheat requires observed and projected
source-map supply inside the provisional 30–50 °C range; B0 reference data do not
make a missing live brine reading known. The fixed future-supply assumption is
3 °C per degree of ROOM increase. Named savings strategies select among
admitted cycle choices; they do not predict or guarantee annual savings. Weighted indoor-average
limits default to ±1.5 °C. The common 60-minute recovery hold is a provisional
engineering setting, not a measured optimum. The model assigns zero room heat to
DHW tank, use and recirculation losses; whole-home savings and matched tank service
remain outside its claims.
Internal gains, open windows, changing emitter behavior, DHW demand, defrost and
weather forecast error can cause residual errors. Manufacturer source estimates and nominal electrical input are not
heat metering or observed COP. Correlated observations and repeated holdout use mean empirical
error envelopes are not statistical confidence probabilities. Frozen advance
checks help, but observational counterfactual references cannot prove causal savings.

The next model expansion should be driven by retained residuals and prospective
cycle evidence. Examples are a better identifiable slow-state model, measured
electrical/thermal calibration, and a DHW service model. It should first beat the
current simpler model on independent completed episodes, including bad outcomes,
before gaining control authority.

The regression suite checks trajectory fitting, evidence gates, configuration
resets and deterministic replay using synthetic plants. These establish software
behavior; no synthetic error score establishes accuracy or economic savings for
the installed house after its hydraulic configuration changes.
