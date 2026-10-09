# TeslaMate vehicle feed

[Charging overview](../../charging.md) · [Identification](../identification.md)

TeslaMate supplies read-only vehicle evidence for either charger. It never creates
a household electricity contribution and receives no vehicle commands from this
integration. Connect TeslaMate to the HA broker when `mqtt.ha` is configured,
otherwise to primary `mqtt`. HA-hosted TeslaMate keeps its fixed HA endpoint
during paired handover; Ubuntu subscribes through its optional HA connection.
See [broker routing](../../configuration.md#primary-mqtt-and-ha-hosted-integrations). In the
`teslamate` section, configure `enabled`, `namespace`, `carId` and `homeGeofence`;
keep private installation identifiers in private configuration. Vehicle-specific
battery defaults belong in
`charging.vehicles.tesla.defaults`. See [configuration ownership](../../configuration.md).

## Setup and source health

Use TeslaMate's native `teslamate/<namespace>/cars/<carId>/` topics, omitting the
namespace segment when none is configured. All configured topics must describe
the same car. Home context compares its reported geofence to the configured home
geofence. Verify the broker subscription and current logger-health messages in
**Data & settings → Connections & configuration → Charging → Tesla**.

Transport, subscription, live logger health and individual field evidence are
separate. A sleeping healthy car is not an unhealthy feed. Reconnection needs a
new live healthy pulse; retained values alone cannot restore live availability.
The configured `teslamate.maxAgeMs` controls logger-health age (three minutes
by default). Most vehicle fields may remain held while
health is current; their original receipt times do not advance with polling.
Queued or failed database admission also makes the affected source unavailable.
The last committed values and their clocks remain visible as unavailable context.
A failed topic needs a fresh successfully saved live report for that topic;
another topic, a retained value or a duplicate delivery cannot restore its health.
Reconnection still requires a successful subscription and a new live health pulse.

## Accepted observations

| Native topic field | Use and limitation |
| --- | --- |
| `healthy` | Live logger-health evidence, independent of broker reachability |
| `battery_level`, `charge_limit_soc` | Vehicle charge and ceiling; usable battery capacity remains configured because this feed supplies none |
| `plugged_in`, `geofence` | Vehicle connection/home context, not physical-charger identity |
| `charging_state`, `state` | Charging and departure context, preserving independently received changes |
| `charger_actual_current`, `charger_power` | Actual vehicle current/power corroboration for the shared matcher |
| `charge_current_request`, `charge_current_request_max` | Requested current and currently available supply; a separate lower request may constrain delivery |
| `scheduled_charging_start_time` | Next start with an explicit timezone; not a complete recurring schedule |
| `charger_phases`, `charger_voltage` | Vehicle observations; never a substitute for measured charger wiring or household supply voltage |
| `charge_energy_added` | Accepted vehicle observation; physical charger metering still owns recorded home charging energy |

Native scalar publications have receipt-only time, with `measuredAt` unknown.
The adapter preserves that distinction and retained provenance. A delayed receipt
cannot be backdated into a prior physical charging event. Unknown or malformed
values remain unavailable; repeating a value cannot manufacture a new start,
plug event or independent evidence.

The exact current accepted fields and parser are in
[`src/charging/teslamate.js`](../../../src/charging/teslamate.js). MQTT setup uses
the existing [MQTT configuration](../../mqtt-topics.md); the upstream topic
reference is [TeslaMate MQTT](https://docs.teslamate.org/docs/integrations/mqtt/).

## Current requests and vehicle schedules

TeslaMate's `charge_current_request_max` describes currently available supply,
which can follow an EVSE pilot reduction or stop. A request equal to that maximum
does not establish a separate vehicle current limit. Only a valid request below
a known available maximum supplies that restriction, including a reported zero.
Equal, inconsistent or incomplete values leave the independent vehicle limit
unknown, while both raw observations retain their values and receipt clocks.
This prevents a 6 A identification setting or a stopped 5 A report from becoming
a permanent limit on later charging. Native charger/electrical ceilings and the
vehicle's own protections still apply. Field meanings follow the
[Tesla telemetry reference](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data).
A positive vehicle request below 6 A uses a valid 6 A pilot allowance while the
vehicle limits its own draw; planning estimates that lower delivery and reserves
the pilot allowance. Explicit zero and electrical limits still prevent starting.

The [planning contract](../planning.md#schedules-inside-the-vehicle) owns how the
reported next start restricts period selection. An absent next start does not
prove that all timers are disabled; unknown timers do not become invented
restrictions in the forecast.

## Charger assignment

The [identification contract](../identification.md#tesla-evidence) owns matching,
connection inference from independently received live charging, source consumption
and the 6 A comparison. With two connected vehicles, equal or missing current
evidence can leave assignment unresolved. The vehicle's reported phase count
cannot veto an otherwise unique match against measured charger wiring and power.

A matching current request is not measured draw. A battery value or at-home
geofence alone cannot identify a charger. A confirmed connection assignment
survives normal pauses within its scope; a changed source identity, physical
connection or conflicting positive evidence is handled explicitly.
