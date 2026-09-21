# Simple garage pause model

The current algorithm is `committed-garage-v5-protection-limited`, with planning preference
`garage-protection-limited-opportunities-v2`. Its purpose is occasional worthwhile OFF opportunities
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
missing. A normal reference is learned from both locations during sustained
accepted native baseline operation: eight hours available plus a stable two-hour
trend, with no pause, recovery, door or charger disturbance. Native baseline can
be verified or explicitly owner-assumed; those sources remain distinct. A sensor
boundary or changed baseline has a documented new seed/context; source changes
interrupt continuity. Native reported 16°C does not overwrite the external 10°C
assumption or measured local temperatures.

The ON trajectory approaches the observed normal references with a fixed
three-hour time constant. This is illustrative continuation, not modeled delivered
heat and not permission to declare real recovery. The runtime uses the actual
external observations and pipe reserves for that decision.

## Inputs and assumptions

- Qualifying charger heat is fixed at 7.5% of charger electricity. An 11 kW input
  therefore gives a displayed 0.825 kW heat assumption. No coefficient translates
  that number into future room warming. Future charger heat receives no safety
  credit; current charging suppresses new economic starts.
- Door state affects evidence and admission. Below 2°C outside, any open configured
  door blocks a start; unknown door/outdoor also blocks. Openings during a pause
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
or artificial planning-horizon cutoff. It compares avoided cost with
recovery cost and uncertainty, choosing the largest net saving; equivalent
choices prefer shorter and earlier pauses. Defaults require more than €0.50,
one hour minimum planned OFF, three hours normal operation and one start per
Finnish day. Temperature forecasts, the independent pipe reserve, uncertainty,
remaining economics and available forecast coverage determine the pause endpoint.
All positive legacy aggressiveness settings use those same explicit limits; zero disables economic pauses. Flat prices preserve normal
heating. Safety restoration always overrides minimum OFF dwell.

Each window contains one OFF interval. Before a future opportunity, ordinary
native heating remains available; it never raises the setting. Actual conditions
are checked again when the opportunity arrives. An active interval may shorten
or end early but never extend its original endpoint. Renewal must have positive
remaining economics and current protection permission. The Pill has no fixed total
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
rules. Version 5 removes the old duration-related learning timeout and starts a
fresh learning seed; v4 remains archival at `ccf0070`, without reinterpretation of
its journal records. Protection and existing recovery obligations survive.
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
