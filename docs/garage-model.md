# Simple garage pause model

The current algorithm is `committed-garage-v7-room-reference`, with planning strategy
`garage-savings-strategy-v1`. Its purpose is occasional worthwhile OFF opportunities
under independent pipe protection. It has no preheat, hidden core, learned pump
heat response, door heat coefficient or multi-pause optimizer.

## Two cooling rates

For each external location independently, an OFF step is

```text
T_next = T_outside + (T_now - T_outside) * exp(-cooling_per_hour * hours)
```

Rear and front priors are 0.03/h and 0.04/h, bounded to 0.001–0.3/h and
0.001–0.4/h respectively. These are effective local cooling rates, not exact
building insulation or heat loss in watts. A duration-weighted bounded regression
uses sufficient statistics with time-based forgetting. ON readings do not train
OFF loss. Door openings/outages, charging, native transitions, invalid/gapped
sensors and held-out intervals cannot supply clean fit evidence. Local plunges
still update actual air and protection immediately.

Only observed rear/front temperatures form the state. Missing front remains
missing. Initial normal-warmth estimates use the effective room setting, including
the lower Garage rear target used with external sensing rather than its native
17°C setting. Without a chosen setting, an unambiguous fresh pump setting may
supply the reference; otherwise it remains unavailable. There is no separate
baseline temperature or default 10°C. The room choice is durable device-bound
intent without expiry. Native settings remain pump readbacks; the lower external
room choice is remembered separately because native 17°C cannot identify it.
Unrelated pump adjustments preserve that choice and its model reference. Room
changes and observations are recorded as source events for deterministic replay.

A normal reference is learned from both locations after at least eight
uninterrupted hours of eligible normal heating and two qualified observation
hours with a settled rear temperature, without pause, recovery, door or charger
disturbance. The rear settling check uses a two-hour smoothing time scale. The native baseline
must be accepted by the current control checks or independently verified. A sensor
boundary or changed baseline has a documented new seed/context; source changes
interrupt continuity. Initial estimates remain at the room setting until two
qualified hours establish distinct observed rear and front means. Changing the
room setting clears normal-temperature and electrical evidence and validation,
while retaining learned OFF cooling rates and their prediction-error evidence.
Returning to an earlier setting starts fresh normal-reference learning; there is
no separate cache for each setting. Reapplying the same setting preserves that
evidence. The saved room
target, native thermostat readback and measured local temperatures remain
distinct; an external temperature offset does not verify a low-heat baseline.

The ON trajectory approaches the observed normal references with a fixed
three-hour time constant. This is illustrative continuation, not modeled delivered
heat and not permission to declare real recovery. The runtime uses the actual
external observations and pipe reserves for that decision.

## Inputs and assumptions

- Qualifying charger heat is fixed at 7.5% of charger electricity. An 11 kW input
  therefore gives a displayed 0.825 kW heat assumption. No coefficient translates
  that number into future room warming. Future charger heat receives no safety
  credit. Current, unknown and forecast charging do not gate pause admission or
  alter the planned window; actual warmth is reflected in the measured temperatures.
- Door state affects evidence and admission. Below 2°C outside, any open or unknown
  configured door blocks a start. At 2°C or above, both pass the door admission rule.
  Unknown outdoor temperature still blocks a start. Door changes during a pause
  invoke fresh protection assessment. No air exchange is inferred from area alone.
- Native electrical power is a qualified observed mean after enough normal data,
  otherwise explicitly assumed 0.5 kW. Activity/frequency stays dimensionless.
  Native electrical input is never described as delivered heat or COP.
- Recovery repays 1.25 times the estimated avoided electricity, priced over at
  least three hours of normal operation, extended to at least 1.25 times the
  OFF duration so the assumed additional recovery power stays no higher than the
  normal-power estimate. No thermostat boost implements this
  allowance. Missing future prices use the highest nonnegative known price.

`predictGarageStep` ignores actual supplied power by default. Elapsed accounting
may use `conditional:true` for qualified electrical input, without changing its
air dynamics. `forecastGarage` rebuilds an allowlist of decision-time inputs;
future power, fan or defrost observations cannot leak into prediction.

## Evidence and uncertainty

Complete OFF/recovery experiments have deterministic whole-episode training or
validation roles. The held-out model is frozen at the start and receives no future
air correction or power input. Native-ON recovery must be observed for at least
three hours and at least 1.25 times the observed OFF duration, with substantial
local rebound. Two completed training experiments
and a later successful held-out experiment establish validated OFF evidence; failed
validation retracts that evidence. The observed duration describes forecast
validation coverage, never a maximum permitted pause. An active OFF period has no
fixed learning timeout; its complete duration remains eligible for assessment.
The bounded history retains at most 24 episode summaries. Thermal and electrical qualification are separate.

Once the normal reference is established, worthwhile opportunities may use the
initial cooling estimates with their explicit uncertainty margins. Neither initial
learning nor later validation imposes a fixed duration ceiling. Failed/incomplete
evidence has a six-hour retry cooldown, and the runtime's actual recovery and
daily limits remain binding. Initial and validated opportunities use the same
minimum net saving; there is no discount that hides uncertainty to force learning.

Independent lower-temperature margins use a rear/front floor, held-out OFF and
whole-episode errors and increasing uncertainty beyond validated duration. The
pipe forecast must have weather coverage through the entire useful-heat return
delay. Every step checks for reserve exhaustion, including within-step crossings.
The model never resets or lends reserve between the two locations.

Electricity uncertainty is in kWh: normal-power error times proposed OFF hours is
priced at the price spread. Any optimistic full-cycle energy error (actual above
predicted) adds an allowance at the recovery price. Overestimated recovery does
not become another peak-priced penalty; the fixed recovery allowance already
charges it. Uncertainty never turns an unavailable measurement into zero.

## One opportunity at a time

The planner enumerates contiguous windows within the available price/weather
coverage, at 15-minute steps by default. There is no fixed maximum OFF duration
or artificial planning-horizon cutoff. For each safe candidate it calculates
conservative net benefit as avoided electricity cost minus recovery electricity
cost and the uncertainty allowance. The named **Savings strategy** sets two
rules for a new pause:

| Strategy | Required net benefit | Benefit retained |
| --- | --- | --- |
| Gentle | More than 1.5 × `minSavingsEur` | At least 60% of the best qualifying opportunity |
| Balanced | More than `minSavingsEur` | At least 80% |
| More savings | More than 0.5 × `minSavingsEur` | Greatest qualifying benefit |

The planner chooses the shortest qualifying window retaining the required
benefit. Equal durations prefer greater benefit, then an earlier start.
`minSavingsEur` is the configured baseline at Balanced; with the default €0.50,
the effective thresholds are €0.75, €0.50 and €0.25 respectively. Gentle still
allows valuable pauses. Use **Pause price control** to suspend economic control.

For example, if a two-hour pause offers €0.90 and a four-hour pause €1.00, both
qualify at the default baseline. Gentle and Balanced choose two hours; More
savings chooses four. These thresholds and retention fractions are explicit
decision policy, not learned optima or predicted annual saving percentages.
Changing strategy leaves the thermal learner, uncertainty and protection intact.

Defaults independently require one hour minimum planned OFF, three hours normal
operation and one start per Finnish day. Temperature forecasts, the independent
pipe reserve, uncertainty, remaining economics and available forecast coverage
determine the pause endpoint. Preference never relaxes these protection or recovery
requirements. Flat prices preserve normal heating. Safety restoration always
overrides minimum OFF dwell.

Each window contains one OFF interval. Before a future opportunity, ordinary
native heating remains available; it never raises the setting. The runtime keeps
the selected future start and endpoint in memory and revalidates that exact
window, so repeated updates do not continually slide or resize the pending pause.
Changed settings, manual control, Pause price control, recovery, a start blocker,
or invalid economics/protection discard the pending choice; selection resumes
when eligible. If an update reaches the start late, the remaining interval must
still meet the configured minimum OFF time and effective new-start benefit
threshold. Its endpoint cannot be extended to compensate for the late start.
Restart replans from current evidence; a pending choice is not saved authority
to turn heating off. An active interval may shorten
or end early but never extend its original endpoint. Continuation chooses the
greatest positive remaining net benefit compared with restoring heating now,
including recovery debt already accumulated. It does not reapply the new-start
benefit hurdle or the shortest-window retention rule at every update. Renewal
also requires current protection permission. The Pill has no fixed total
episode-duration ceiling. Its short renewable permission still expires locally
if ST-MQ or communication fails; maintaining a long pause does not require repeated
pump starts or a growing device-side history. Recovery blocks every
subsequent pause until the original event is resolved.

Counterfactual accounting freezes the model at event start. Dedicated qualified
recorded electricity is preferred; otherwise the fixed prediction and recovery
allowance are explicit. Metered recovery is not charged twice. Completion needs
both observed locations within 0.25°C of the frozen reference, the recovery energy
allowance accounted, sustained normal availability and recovered local pipe
reserves. Reporting gaps with restored warmth can close as incomplete, without
savings. There is no fabricated slow-core recovery or measured thermal kWh.

Protection and recovery obligations are separate from replayable learning.
`garage-thermal-reserve-v1` retains its copper-pipe assumptions and permission
rules. Learning version 7 adds room-setting-based initial references and journaled
reference changes to independent source-clock support and complete-cycle metering
qualification. The separate `garage-savings-strategy-v1` identifier describes
pause-selection semantics without changing learned cooling coefficients.
Incompatible development models, settings and episodes
are rejected; initialize a fresh development database explicitly. Current-version
restart preserves pipe reserve and unresolved physical restoration.
See [reconstruction/versioning](reconstruction-and-versioning.md),
[protection](garage-protection-defaults.md) and [simulation evidence](garage-simulation-audit.md).

If changed weather makes the frozen pre-pause temperatures unreachable, recovery
can close as **incomplete**, with no savings claim, after continuous fresh accepted
native ON with both actual locations and both certain pipe references above the
protection margin. That continuous interval must cover the longest of eight hours,
the configured minimum ON time, the originally planned recovery-pricing period,
and the recovery allowance for the actual OFF duration (at least three hours and
1.25 times OFF hours). Longer pauses therefore retain their full recovery obligation. Closing and a normal-reference reset are committed atomically.
The reset clears reference/electricity observers and their previous input, retires
active validation as incomplete, and retains learned cooling rates. The same
context event replays deterministically; new normal-temperature evidence must
qualify before another economic pause. Brief charging disturbances, changed
baseline/source and unqualified electricity never fabricate completed savings.

## Independent source clocks and electrical coverage

A fresh cached front report does not dirty a clean episode. Learning waits until
both available source reports advance, then weights each location by its own
time span. Front prediction uses a bounded history of observed ambient/native
segments on the front interval; missing support, stale/invalid clocks, source
rollback and genuine disturbances exclude qualification. Rear-only observations
still support rear learning without fabricating a front probe. Current replay and
checkpoint continuation retain the same joined observations and support history.

Electrical validation covers the complete OFF/recovery interval. Missing OFF
power is unknown, measured zero is valid coverage, and measured standby power is
included. Thermal validation remains available without electrical metering;
assumed-zero economics does not become observed full-cycle validation.

## Dashboard explanations

Garage learning uses the Home heat-model structure: outcomes and validation,
model inputs, and coefficients. Heating strategy & protection holds planning
rules, pipe reserves and the current decision; each fold links to the other.
The model introduction explains how cooling estimates feed planning and how
heating control applies the resulting off permission and restoration.
Every Garage entry includes
an expandable calculation or eligibility explanation. Cooling, recovery,
electricity, observed validation duration and the reference-pipe heat balance
show their equations and assumptions separately. Initial normal-temperature
references remain explicitly estimated until settled observations establish them.
Fitted cooling rates still require separate episode validation; the planner's
temperature margins grow beyond validated durations. The illustrative normal
warming curve does not establish actual recovery or refill pipe reserves.
Model reconstruction requires
the complete committed journal, initial seed, configuration and matching software;
it does not certify physical command delivery or measured savings.
