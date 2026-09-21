# Charging provider capabilities

Checked against the public provider contracts on 2026-09-15. The two charger
objects have the same fields. An unidentified car on the generic Easee uses
manual values. Once its vehicle is identified, an unavailable automatic field uses its
saved manual fallback; a missing charger connection or current allowance does
not gain a manual switch.

| Information | Easee charger | TeslaMate vehicle |
| --- | --- | --- |
| Usable battery capacity, kWh | Unavailable | Unavailable |
| Vehicle SoC | Unavailable | `battery_level` |
| Vehicle charge target | Unavailable | `charge_limit_soc` |
| Connected vehicle | Pilot and operating mode | `plugged_in`, gated by household location |
| Charging current estimate | Charger ceiling and separately identified Equalizer allowance | Requested current capped by vehicle maximum |
| AC voltage | Equalizer phase-to-neutral property voltage | `charger_voltage`, or the shared property voltage |
| Charging phases | Three-phase installation assumption | Three-phase installation assumption |
| Measured charging power | Total power | `charger_power` |
| Native start | Delayed, daily or weekly schedule | `scheduled_charging_start_time` |
| Native stop | Daily or weekly stop | Unavailable |
| Automatic schedule control | Native one-off starts, chained for split periods | Unavailable |

Easee's observations contain electrical limits and charger state; they do not
provide vehicle battery capacity, percentage or charge target. A timestamped
vehicle MQTT source can supplement those fields after its vehicle is matched to
the current plug-in session. Equalizer current
remains under external control. See the [observation contract](https://developer.easee.com/docs/charger-observation-ids)
and [operating-mode and phase definitions](https://developer.easee.com/docs/enumerations).

TeslaMate's MQTT topics provide individual values without measurement timestamps.
ST-MQ preserves each packet's receipt time and retained-message status. Neither
`usable_battery_level` (a percentage) nor charging-session energy is usable battery
capacity. `time_to_full_charge` is an estimate, not a configured stop time. See
the [TeslaMate MQTT contract](https://docs.teslamate.org/docs/integrations/mqtt/).

The configured TeslaMate subscription represents the Tesla independently of the
charger. It supplies Charger 2 unless Tesla is positively identified at Easee,
when its battery inputs are used by Charger 1 and the second session is hidden.
Explicit `easee` assignment remains supported. Tesla's energy is not counted
again as Charger 2 when assigned to Easee.
MQTT subscription/reception health is separate from whether the vehicle is
awake, charging, or producing sufficient evidence for energy recording.

The [BMW CarData feed](bmw-cardata.md) supplies measured SoC, vehicle target,
usable capacity, plug status, charging status and a source-timestamped home-location
result. It does not supply an electricity-consumption stream. Its battery values
are used only after timestamped plug/charging evidence matches the current Easee
connection. The installed BMW need not expose charging power or a plug-event ID.
The last-session AC current/voltage descriptors are not used as live charging power.
The Tesla probe's negative result means only that Tesla charges elsewhere; it
never identifies a BMW or replaces visitor inputs.

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
with automatic voltage required. Coherent allowance/property readings establish
an effective supply budget. Household history then forecasts future consumption;
an instantaneous low allowance is not held unchanged across the night. See
[planning and assumptions](charging.md#planning-and-equalizer).

Charge progress uses the existing recorder's grid-energy intervals, including
its pending tail, rather than a separate power integrator. Delivered energy,
fixed 92.5% efficiency and usable capacity produce a separate estimated SoC and remaining
grid energy. Missing intervals receive no invented credit. TeslaMate's scalar
power remains receipt-timed telemetry; a charging-session counter does not
become a battery-capacity measurement. The original vehicle SoC, target and
timestamps remain distinct from derived estimates.
