# Learning, heating cycles and the chart

The controller compares complete **preheat → reduction → recovery** cycles with
the best feasible shorter-reduction alternative, including continuous normal
heating. That reference is fixed when the cycle is planned. The comparison includes the cost of restoring the house's
heat reserve. A low bill during a reduction is not, by itself, a successful cycle.
The software has offline and synthetic browser checks; these do not commission
the equipment, verify this installation's plumbing or establish actual savings.

## What learns

The adaptive model uses indoor and outdoor temperature, heating operation and
the available **solar radiation forecast**. It estimates heat loss, effective
heating response and a slow building-temperature memory. This memory is not a
measurement of floor temperature, floor heat capacity or stored kWh. Heating
response is not a measured compressor maximum output or a COP measurement.
ROOM/DHWR response is coupled in the model, so it cannot identify the separate
benefit of two actuators always operated together.

Only outdoor temperature and solar radiation are weather inputs. Temperature and
radiation forecasts use FMI first, with Open-Meteo ICON Seamless as backup. Solar
values retain their own provider when missing FMI radiation is filled by
Open-Meteo. Radiation is modeled global shortwave flux in W/m² on a horizontal
surface, including cloud effects. Open-Meteo radiation covers the preceding hour
and is aligned to that interval. Current outdoor temperature uses a fresh H66
sensor first, then a fresh FMI station reading, then an Open-Meteo model estimate.
Missing radiation remains
unknown and increases uncertainty; cloud cover, wind and sun angle are not
invented as substitute observations.

Initial bounded parameters allow the controller to start with uncertain evidence.
New temperature samples are processed chronologically, with invalid intervals
kept as barriers. Model fitting checks later one-hour temperature trajectories,
separated from the training period, against the previous model and holding the
last temperature. A rejected fit keeps the existing parameters. A successful
short temperature check does not validate electricity cost or an unobserved action.
Completed cycles update recovery estimates separately; incomplete cycles do not
strengthen that evidence.

The normal indoor reference comes from occupied, normally heated periods. It is
held during preheat, reduction and recovery, so extra temporary warmth does not
become a higher permanent comfort target. Away removes the normal occupied drop
constraint while retaining a return-temperature requirement inside the known
forecast horizon. The default preferred occupied drop is 1 °C.

## What the planner compares

Each candidate prices preheating, reduction, recovery and remaining heat debt
under the same weather and tariff outlook. Normal native operation is one
alternative; a shorter feasible reduction can be a cheaper comparison reference.
Compressor electricity, auxiliary electricity, circulation and DHWR energy are
counted with uncertainty. Electricity derived from nominal power and runtime
remains estimated. Whole-property consumption minus EV charging is not treated
as heat-pump electricity.
When auxiliary observation is unavailable, the component model retains an
uncertain auxiliary allowance instead of assuming auxiliary use was zero. That
allowance is not evidence that a resistor actually ran, and it cannot qualify a
cycle for the auxiliary-recovery metric.

With little evidence, reductions are shorter and economic uncertainty is larger.
Limited learning trials can accept a bounded estimated extra cost to collect
evidence; the daily and per-trial budgets are configuration values. Such trials
are not presented as predicted savings. Loss of usable temperature data, an
override, a fault or an incomplete outlook prevents a new optimistic cycle.
Recovery remains part of the cycle until temperature and reserve have recovered;
a timeout or an observation gap leaves an incomplete assessment.

## Four historical learning values

The Learning details section and the chart use the same assessments. Financial
averages use the latest 30 completed cycles; the auxiliary subset is drawn from
that window. A missing value is unavailable, not zero.

| Chart choice | Meaning |
| --- | --- |
| Profit after recovery, €/cycle | Mean estimated cost of the best feasible shorter-reduction alternative (including normal heating), fixed when planned, minus completed full-cycle cost. A negative value means the assessed cycles cost more. |
| Profit with auxiliary recovery, €/cycle | The same measure, restricted to completed cycles with observed **space-heating** auxiliary operation during recovery. DHW-only auxiliary use does not qualify. Pre-H66 or otherwise unknown attribution is excluded. |
| Recovery cost prediction error, €/cycle | Mean absolute difference between the original recovery prediction and the eventual recovery cost estimate. Lower is better; zero requires completed evidence. |
| Normal indoor temperature, °C | Learned occupied normal-heating reference, independent of a temporary ROOM boost. |

History records the value **when assessed**, its cycle count, basis and model
version. Later models do not replace earlier points with what they would predict
today. The last assessed learning value remains in effect until superseded;
there is no invented learning history before the first recorded assessment.

## H66 readbacks and commands

The integration uses the documented Thermia/Danfoss C60 register profile. For a
standard DHP-H installation, the reversing valve routes the inline auxiliary
heater and condenser to either space heating or the hot-water tank. This permits
attribution when fresh compressor, auxiliary and routing readbacks overlap. It
does not establish that a nonstandard installation has identical hydraulic paths.

| Register | Role |
| --- | --- |
| `3104` | Combined auxiliary output percentage. It is not a set of individual stage relays. |
| `1A01` / `1A07` | Compressor running / reversing-valve destination, 0 space heating and 1 domestic hot water. Routing alone does not mean the compressor is running. |
| `2201` | Actual operation mode readback and supported mode control. Shown categorically in the chart, not as a numeric power curve. |
| `0203` | ROOM setting used for bounded preheating, then restored. |
| `0212` | DHW start setting, temporarily changed during the selected strategy and restored. |
| `0208` | DHW stop setting, including the requested 50 °C reduction setting, then restored. It is **not a physical compressor DHW temperature cap** and does not redefine the native hygiene cycle. |
| `8105` | Current heating integral. It is not a writable A1/A2 configuration register. |
| `6C63` / `6C66` | Cumulative auxiliary runtime counters. They cannot reconstruct the time or destination of past auxiliary episodes. |

The configured auxiliary rating converts `3104` into estimated kW. With a
verified 9 kW installation, nominal thirds represent 3, 6 and 9 kW. The DHP-H 10
model name alone does not establish the electrical heater rating; other electrical
versions differ. Outputs within two percentage points of a nominal third are
mapped to the corresponding nominal power; other values use proportional power.
This mapping remains an estimate, not separately observed relay stages or metering.

The configured A2 default is **−990**, with auxiliary hysteresis **30 °C**. A1
and compressor hysteresis are nullable configuration values until supplied.
Absolute versus A1-relative A2 semantics are explicit configuration. These are
assumptions used in prediction, not settings read from `8105` and not new writes
to the pump's installer menu.

Normal active operation may send heating/H66 commands only with live input and
the required fresh controls. Monitoring and shadow do not automatically actuate
equipment. Explicit manual tests are separate authorization: a timed test captures
the current baseline, writes the selected register, checks readback and restores
the baseline after expiry. Failed readback and pending restoration are visible;
broker acknowledgement alone is not device confirmation. Restarts retain restore
obligations. An independently changed panel value is preserved instead of being
silently overwritten with an old baseline.

Plain H66 MQTT register publications do not contain a source measurement time.
For non-retained publications, receipt time is retained as an explicitly named
time basis for communication freshness. Retained, invalid and stale values do not
become fresh merely because the application restarted. A documented register
profile is distinct from verification of the installed pump and firmware.

The legacy DHWR command pair is `heaton60`, then `heaton15`, with a ten-minute
pulse. The model assumes circulation can contribute useful house heat while heat
is demanded, and includes reheating/pump costs. Actual plumbing and flow can make
that assumption inaccurate; the fitted response and cycle outcome remain estimates.

The native periodic high-temperature/14-day hygiene cycle is retained. The owner
accepted that a temporary compressor-only strategy may delay the availability of
auxiliary heat during its control window. These writes must not be described as
proving that every native hygiene cycle completes on schedule. The software does
not rewrite the native hygiene schedule or claim a software-verified hygiene result.

## Reading the power chart

**Power** shows the property estimate as a line, auxiliary power as a red fill
and charger power as a fill drawn over it. Both fills start at zero: they overlap
and are not stacked. They must not be added to the property line, which already
includes household loads. Auxiliary power expires after five minutes without an
updated observation, rather than extending indefinitely.

Yellow background means the compressor was reported running toward the house;
blue means it was running toward DHW. Missing/stale routing leaves a gap. Heat Off
is crosshatched and describes a reduction request, not proof of a stopped
compressor. Brown DHWR shows ten-minute requests and starts hidden. Other series
start visible, while explicit saved legend choices remain in effect.

Solar history is a forecast archived at its valid time. Its dashed continuation
is the currently available future forecast. Neither is a solar observation.

## Timing benefit under the chart

The lower corner compares recorded heat-pump and EV energy at its actual times
with the **same recorded daily energy** spread uniformly over that entire Finnish
calendar day. It uses duration-weighted all-in prices and actual 23/24/25-hour
days, including clock changes. Positive means cheaper timing; negative means
dearer timing. This mathematical comparison is not causal controller savings.

Original observations are integrated before chart decimation. Valid three-phase
charger acquisitions can supply older EV estimates; a dedicated heat-pump power
series is required for the heat-pump comparison. Power is held for at most 30
minutes between observations. Missing intervals are excluded and coverage is
shown. A day without complete all-in prices is unavailable. Today's incomplete
energy, partial history and telemetry gaps produce provisional results, not a
zero estimate for the missing period.

## Primary documentation

- [Husdata C60 register list](https://online.husdata.se/h-docs/C60.pdf).
- [Husdata MQTT specification](https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/).
- [Danfoss DHP-H installation instructions, VMBMA702](https://assets.danfoss.com/documents/latest/29671/AN000086466221en-010701.pdf), system 1 routing in §8.2 and integral control in §15.7.
