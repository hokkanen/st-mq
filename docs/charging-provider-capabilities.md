# Charging provider capabilities

Checked against the public provider contracts on 2026-09-15. The two charger
objects have the same fields. An unavailable automatic vehicle value uses its
saved manual fallback; a missing charger connection or current allowance does
not gain a manual switch.

| Information | Easee charger | TeslaMate vehicle |
| --- | --- | --- |
| Usable battery capacity, kWh | Unavailable | Unavailable |
| Vehicle SoC | Unavailable | `battery_level` |
| Vehicle charge target | Unavailable | `charge_limit_soc` |
| Connected vehicle | Pilot and operating mode | `plugged_in`, with household location and charger assignment |
| Charging current estimate | Charger ceiling and separately identified Equalizer allowance | Requested current capped by vehicle maximum |
| AC voltage | Equalizer phase-to-neutral property voltage | `charger_voltage` |
| Charging phases | Three-phase installation assumption | Three-phase installation assumption |
| Measured charging power | Total power | `charger_power` |
| Native start | Delayed, daily or weekly schedule | `scheduled_charging_start_time` |
| Native stop | Daily or weekly stop | Unavailable |
| Automatic schedule control | Native one-off starts, chained for split periods | Unavailable |

Easee's observations contain electrical limits and charger state; they do not
provide vehicle battery capacity, percentage or charge target. A timestamped
vehicle MQTT source can supplement those fields independently. Equalizer current
remains under external control. See the [observation contract](https://developer.easee.com/docs/charger-observation-ids)
and [operating-mode and phase definitions](https://developer.easee.com/docs/enumerations).

TeslaMate's MQTT topics provide individual values without measurement timestamps.
ST-MQ preserves each packet's receipt time and retained-message status. Neither
`usable_battery_level` (a percentage) nor charging-session energy is usable battery
capacity. `time_to_full_charge` is an estimate, not a configured stop time. See
the [TeslaMate MQTT contract](https://docs.teslamate.org/docs/integrations/mqtt/).

Native schedule stops and estimated completion times remain distinct. Easee's
delayed schedule has only a start. ST-MQ's owned occurrence takes precedence over
a newly interpreted local clock time. Reading a complex native recurrence for
display alone does not establish a manual action. The first observation is a
baseline; later observed changes follow the readiness-cycle handover rules even
when disconnected. Native delayed schedules are installed one at a time: later
planned pauses require a working application/cloud connection, and the final
release has no stop. Accepted schedule state and confirmed physical pause are
reported separately. See [Easee scheduling state](https://developer.easee.com/reference/getchargersschedules)
and [delayed schedule](https://developer.easee.com/reference/postchargersschedulesdelayed).

Neither integration supplies a guaranteed overnight available-power forecast.
Equalizer remains Charger 1's external limiter; its live allowance is distinct
from the configured charger ceiling and actual draw. Three phases are assumed,
with automatic voltage required. See [planning and assumptions](charging.md#planning-and-equalizer).

Measured-power credit updates the remaining energy estimate only from fresh,
attributable measurement intervals; receipt-only TeslaMate scalar power does
not become a measured-energy counter. Neither this credit nor an estimated
completion time replaces the vehicle's SoC reading or charge target.
