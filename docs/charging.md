# Charging

Both chargers use the same charger model, settings, planner and dashboard card.
Capabilities describe what each connected integration can do. Charger 1 uses
Easee's native delayed-start schedule; Charger 2 receives vehicle observations
from TeslaMate and currently has no command adapter. Its scheduling controls are
visible but disabled. Heating mode and charging permission are independent.

## Garage dashboard and preferences

The first equipment cards in **Garage → Equipment & temperatures** show connection,
current charge, minimum charge, grid energy to the minimum and the next relevant
event. While charging, the event shows measured power and estimated progress;
while waiting, it distinguishes a confirmed native start from a proposed start.
Settings, source information and manual override details are inside each card's
**Settings & details** fold. Shared installation assumptions have their own fold.

Preferences are saved in the application database, independently for each
charger, and survive restart/configuration reload. They are not new deployment
configuration entries. First-use values are:

| Preference | Charger 1 | Charger 2 |
| --- | --- | --- |
| ST-MQ scheduling | OFF | Unavailable |
| Manual minimum fallback | 80% | 80% |
| Local ready-by preference | 06:00 | 06:00, scheduling disabled |
| Manual usable-capacity fallback | 74 kWh | 57 kWh |
| Manual SoC fallback / initial entry | 40% | 40% |
| Charging efficiency | 90% | 90% |

Ready-by is always an ST-MQ preference, never inferred from a vehicle schedule.
The shared timezone initially is Europe/Helsinki. Battery capacity is kWh;
charging power is kW; current is A per phase. The grid-energy estimate includes
charging losses: `capacity × max(0, target − SoC) / 100 / efficiency`.

## Automatic readings and fallbacks

A valid automatic usable capacity or vehicle charge target takes precedence over
its saved manual fallback. Neither current provider reports usable battery
capacity. TeslaMate supplies SoC and the vehicle charge target; Easee supplies
neither. The additional vehicle MQTT feed can supply these missing properties.
No capacity is guessed from vehicle range, session energy or model name. See the
[verified provider capability matrix](charging-provider-capabilities.md).

SoC normally uses available vehicle telemetry. **Use manual charge** selects a
temporary override until the next concrete ready-by deadline and remembers the
number as this charger's fallback. Its absolute expiry survives restart and does
not move when ready-by is edited later. Automatic readings continue to update
underneath the override. Returning to automatic readings ends the override
immediately. If automatic SoC is unavailable, the remembered manual fallback is
used and explicitly labeled; first use is 40%. This follows the shared-charger
requirements rather than the original handout's missing-SoC assumption of zero.

Connection at this property, charging current and native schedules are automatic
only. A plugged-in vehicle away from Home is not this property's charging load.
Uncertain automatic charger attribution reserves possible load without attaching
an unconfirmed vehicle's SoC or target to another charger. Existing explicit
charger assignment takes precedence over automatic attribution. Attribution's
active current perturbation is suppressed while ST-MQ scheduling is enabled or
an owned restriction still needs handover.

Easee provides current charger/Equalizer allowance and separate fixed electrical
ceilings. TeslaMate provides selected current separately from actual charging
current/power. Zero measured power while waiting does not remove future demand.
A TeslaMate scheduled start is available; a scheduled stop is not. Estimated
minimum completion is never displayed or executed as a scheduled stop.

## Additional vehicle MQTT

The default Charger 1 subscription is `stmq/garage/charger1/vehicle`, QoS 1.
Either charger can use an optional distinct topic with its own expected identities.
A future publisher should send retained JSON, for example:

```json
{
  "vehicleId": "charger1-vehicle",
  "sourceId": "vehicle-telemetry",
  "readingId": "example-reading-42",
  "soc": 63,
  "usableCapacityKwh": 74,
  "chargeLimitSoc": 80,
  "measuredAt": "2026-09-15T17:20:00+03:00",
  "sequence": 42
}
```

Capacity and charge limit are optional. `measuredAt` is the original measurement
time: an ISO timestamp with offset, UTC milliseconds, or `null` for an unknown
clock. Receipt time never substitutes for it. Optional `sequence` must increase
across publisher restarts if used for ordering. `readingId` identifies a
measurement, not a transmission. Invalid values, mismatched identities, duplicate
IDs and provably older measurements are rejected. Retained replay cannot renew
an accepted measurement's original timestamp. Old valid vehicle MQTT readings
remain usable with their dates preserved.

Changing a topic or source clears that route's prior automatic reading. Changing
the vehicle identity also clears its temporary manual override. TeslaMate scalar
topics have separate receipt clocks and no source timestamps; their metadata is
kept separate. WiCAN firmware, broker persistence and device setup remain for the
later hardware installation.

## Shared planning and external load balancing

ST-MQ searches continuous start-only charging scenarios using actual price
intervals, each charger's required energy/readiness time, charging efficiency,
forecast household demand and per-phase installation limits. It can choose a start
before a cheap period if competing load makes that period too constrained.
Schedules are not repeatedly paused to chase prices. Reaching the minimum or
ready-by never causes an automatic stop.

The property main-fuse value starts unset. Enter the real installation limit in
the shared settings. Verified provider limits also constrain planning. Equalizer's
instantaneous available current is not a fuse rating or an overnight prediction.
The planner uses fixed charger/cable/circuit ceilings and forecast property demand
for future headroom, while Equalizer continues managing real-time current.

Recorded electricity intervals are intersected before both chargers are removed
from household demand. Recent matching local hours inform the forecast. Where
charger-free history is unavailable, the shared non-charging allowance is used.
A phase count without phase identity conservatively reserves current on each
possible phase without inventing three-phase power. Missing electrical telemetry
produces a visible unavailable forecast and relinquishes automatic delay.

The planner accepts an array of interchangeable chargers and plans their starts
jointly. Earlier deadlines and larger remaining requirements take priority when
shared capacity cannot meet every target. Read-only/manual/released chargers are
accounted for as external demand. A manual minimum alone is not evidence that a
vehicle will stop there, so competing-load reservations continue beyond it.

Future adapters may declare scheduling and current-control capabilities. The pure
planner can propose coordinated current allocations according to remaining energy
and time, only for controllable chargers without an external limiter. At most one
charger can use an external limiter; it receives the remaining capacity and never
a current-limit proposal. Current proposals are forecasts for a future executor;
the present Easee/TeslaMate integrations do not dispatch them. Native schedule
ownership and command confirmation must be supplied by a future command adapter.

## Manual charger priority and ownership

Easee schedules are reread before replacement and confirmed afterward. A simple
manual app window temporarily yields control until its current/next concrete end,
then requires another read before handback. It can resume without unplugging.
Repeating windows are temporary for one occurrence while ST-MQ is enabled; turn
ST-MQ OFF for permanent recurring app control. Multiple periods, ambiguous ends,
and unbounded manual stop/disable instructions remain yielded until explicit
resumption. Immediate charging has priority for the connected session.

Manual charger actions and manual SoC are independent. Changing one does not
cancel the other. Once released, ST-MQ does not delay that session again because
of a brief zero-power reading, updated SoC or passed deadline. An overdue deadline
does not silently move to tomorrow. Turning OFF relinquishes only a confirmed
ST-MQ restriction; an unconfirmed handover stays visible.

Easee delayed starts use local clock times. ST-MQ retains the absolute occurrence
and validates its representability; ambiguous daylight-saving times yield instead
of installing a different start. Details are in [Easee adapter notes](charging-easee.md).
Tests use synthetic providers and time. Native behavior on the installed charger
and WiCAN hardware remain equipment checks for the later setup.

## Internal model and API

`charging.settings` holds shared installation/time preferences and a `chargers`
map. `charging.chargers` is an array of common objects, each with capabilities,
settings, normalized `values`, source metadata, grid-energy requirement, plan,
forecast and independent control state. Adding a command integration does not
require a second dashboard or charger-specific planner branch. Runtime adapters
attach by charger ID and can supply normalization and their native controller.

Authenticated mutations use the existing primary-controller authority gate:

| POST endpoint | JSON body |
| --- | --- |
| `/api/charging/settings` | Partial shared settings; nested `installation` and `chargers` patches merge |
| `/api/charging/chargers/:id/settings` | Partial preferences for that charger |
| `/api/charging/chargers/:id/soc` | `{ "soc": 40 }` or `{ "action": "automatic" }` |
| `/api/charging/chargers/:id/resume` | `{}` |

Mutations return full application status. Unknown IDs/fields and invalid values
are rejected. Enabling scheduling on an unsupported integration is rejected by
the server as well as disabled in the UI. Both chargers support saved fallbacks
and independent manual SoC overrides.

Read-only replicas show the saved primary decision and readings at the original
publication boundary, using the same card structure. They do not replan or issue
commands, and copied ownership is not presented as a live connection.
