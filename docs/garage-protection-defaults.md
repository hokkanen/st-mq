# Garage freezing protection and reference heat reserve

`garage-thermal-reserve-v1` protects pipes and stored liquids by tracking a
small water-filled copper pipe as the reference. Rear and front each have an
independent estimate driven by the adjacent air sensor. A brief cold-air plunge
spends part of the local reserve; later warming restores it gradually.

The reference is the described **bare 21 mm outside-diameter copper pipe with
stagnant water**. Its wall thickness is assumed to be 1 mm. Actual wall thickness,
local airflow and the response of the stored liquids have not been measured.
Using this reference does not establish that every container or fitting cools
more slowly, or that the pipe wall cannot begin freezing before the estimated
bulk temperature reaches zero.

## Parameters shown in Garage settings

| Parameter | Initial value | Meaning |
| --- | ---: | --- |
| Protection margin | 1°C | Estimated reference temperature where usable reserve reaches zero. |
| Reference pipe outside diameter | 21 mm | Sets the exposed surface and quantity of copper and water. |
| Reference pipe wall thickness | 1 mm | Assumed copper thickness; the water bore is calculated from it. |
| Heat transfer | 20 W/m²·K | Initial estimate of heat exchange with the adjacent air. |
| Safety factor | 2, fixed | Counts heat loss twice as fast and credits heat gain half as fast. |

Normal heating remains 10°C; aggressiveness remains 50. Automatic operation is
disabled and the protection policy is unapproved by default. The heat-transfer
coefficient and safety factor are engineering assumptions, not values learned
from the garage or an installed safety certificate.

The old air-temperature hard limit, fixed degree-minute allowance, recovery
temperature, recovery dwell and constant refill rate are removed. A new pause
requires known configured door states and outside temperature; an open door
blocks a new pause below 2°C. Door openings or outages during an existing pause
trigger ordinary temperature/reserve reassessment rather than unconditional
cancellation. Door disturbances also exclude affected intervals from ordinary
thermal fitting, baseline qualification and clean validation evidence.

## Continuous thermal calculation

Per metre, with the assumed 1 mm wall, the pipe contains approximately 0.284 kg
of water and 0.563 kg of copper. Their combined heat capacity is approximately
1,402 J/(m·K); exposed surface is 0.066 m²/m. The fixed material values are water
and copper density 1,000/8,960 kg/m³ and specific heat 4,180/385 J/(kg·K).

For each location, the reference temperature follows:

```text
C = waterMass × waterSpecificHeat + copperMass × copperSpecificHeat
G = heatTransfer × exposedSurface
effectiveG = G × 2 when cooling; G / 2 when warming
responseTime = C / effectiveG
d(referenceTemperature)/dt = (airTemperature − referenceTemperature) / responseTime
reserveKjPerMetre = C × max(referenceTemperature − marginC, 0) / 1000
```

These inputs derive approximately **8.85 minutes for cooling and 35.42 minutes
for warming**. They are not additional settings or times until freezing. The
asymmetry applies the uncertainty factor once; there is no second multiplier on
the calculated reserve. The ordinary lumped thermal relation and its limitations
are described in [MIT's heat-transfer notes](https://web.mit.edu/course/16/16.unified/www/FALL/thermodynamics/notes/node129.html).

At an estimated 6°C, usable reserve above the 1°C margin is approximately
**7.01 kJ/m**. The underlying estimate continues below the margin even though
displayed available reserve cannot be negative. No latent heat is granted as
permission to freeze part of the water. If the estimate enters a possible frozen
state, energy is retained as thawing debt: temperature remains at 0°C during the
phase change, and warming must repay that debt before positive reserve returns.
Below fully frozen zero, the calculation uses ice specific heat 2,090 J/(kg·K).

Cooling and warming use elapsed time, not report counts. Air above 1°C can still
spend reserve: a reference at 5°C continues cooling in 2°C air. Conversely,
recovery starts immediately when air is warmer than the reference. A brief warm
report credits only the heat transferred during that interval; it cannot reset
the reserve. Neither another location warming nor native ON replenishes it.

## Reporting and pause permission

Shelly status is requested every **30 seconds**, and protection is reassessed on
valid temperature evidence. Unchanged valid reports count; retained packets,
duplicates, invalid readings and unrelated device traffic do not refresh a probe.
A status response confirms the device's reported value, not necessarily a new
hardware conversion at that instant. Both required locations must be fresh for a
new pause or renewal. The maximum temperature age is **2 minutes**; protection
can restore earlier if the thermal reserve is insufficient. Missing outside
temperature does not establish that freezing is impossible.
Between reports, assessment may project further cooling but cannot credit warming
from cached readings. Forecasts begin at the decision time, so predicted recovery
cannot be interpolated backward into the time since the last genuine report.

The planner revalidates at its **1-minute** cadence. A requested Pill permission
is capped at **3 minutes from the older supporting temperature report**, and can
be shorter when the thermal reserve requires it. Evidence deadlines overlap;
they are not three sequential waits. UI polling, broker traffic and repeat
revalidation of old temperature evidence cannot extend that deadline.
Two minutes without a planner revalidation also revokes the host's permission.
The adapter's published renewal interval must permit the one-minute schedule.

Before an OFF request or renewal, the projected reserve must cover cooling until
the requested permission expires and the subsequent delay until heating becomes
useful near the reference. Runtime checks also cover already accepted permission
and requests that may have been accepted while acknowledgement is pending.
Reducing a host deadline does not by itself shorten an outstanding device lease.
The planner continues its cooling forecast through the restoration delay, with
no assumed EV heat and with the same growing forecast uncertainty margins.
There is no unconditional 15-minute reserve assembled from a maximum lease and
an unrelated restoration constant.

The useful-heating delay must be supplied by the adapter's qualified restoration
bound and installation evidence. Native ON, command acceptance and local warming
are separate events. A maximum communication interval is not guaranteed cold
exposure time: sustained cold can require immediate restoration.

For example, a uniform initial 4°C reference exposed continuously to −10°C air
reaches the 1°C margin after approximately **2 minutes 8 seconds** with these
assumptions. This does not permit a three-minute pause, and a sufficient
heating-response delay can make immediate restoration necessary. Cold outdoor air
entering a garage does not imply that both adjacent sensors immediately measure
the outdoor temperature.

The actual published Pill protocol and installed timing evidence are still
missing from this repository. These rules are implemented and tested at the
explicit `stmq-garage-fixture/v1` consumer boundary; they are not a claim that
deployed firmware has been configured to these intervals. See the
[adapter boundary](garage-adapter.md) and [Pill handoff](shelly-pill-handoff.md).

## Persistence, initialization and learning

The two reference temperatures are operational protection state, separate from
the learned garage model, its slow building-memory estimate and frozen episode
accounting. Changing economic preference, replacing a learned checkpoint,
reconnecting or restarting must not create fresh thermal reserve. Missing history
cannot be repaid by assuming warmth during the gap. Startup without usable
thermal history requires measured recovery before a pause can be authorized.

Without valid saved thermal history, initialization starts from the fully frozen
reference at **−40°C**, the lower supported air-temperature bound. This is a
conservative unknown-history state, not a claim that the garage or pipe was
actually that cold. One warm air reading cannot establish that the contents are
liquid and warm. Continuous genuine reports repay the initial sensible and
thawing debt at the same temperature-dependent warming rate as ordinary recovery.
At constant 4°C air the default reference needs approximately 10.9 hours to reach
the 1°C margin; at 6°C it needs 7.4 hours, and at 10°C about 4.6 hours. These are
calculated initialization times, not a separate lockout timer. Heating remains
available while the reserve is being established.

Ordinary missing-report intervals **do not restart this fully frozen assumption**.
They debit only the elapsed conservative heat loss, using the coldest of the
previous local reading, a valid returning local reading and qualified outside air.
The outside reading must already cover the start of the gap and remain within
its 30-minute freshness window through the end. A fresh warm return reading
cannot establish past conditions. Without that evidence, the −40°C bound is used. No warming is
credited during missing history. A new genuine interval can resolve uncertainty
once its remaining heat reserve is positive; cached reports cannot do so.

Old degree-minute debt is not numerically convertible into this heat reserve.
The policy version marks an explicit operational boundary; old protection
records keep their historical meaning. The transition does not reinterpret an
old learning journal, reset learned garage coefficients or forgive an outstanding
restoration obligation. Changes to geometry, margin or heat-transfer settings
also cannot manufacture additional stored joules: the transition retains at most
the previous usable reserve, preserves possible frozen debt, and requires new
temperature evidence. See [reconstruction and versioning](reconstruction-and-versioning.md).

Freeze-protection recovery remains separate from whole-garage recovery. A positive
local reserve alone does not establish comparable building warmth, complete a
pause-and-recovery episode or qualify a savings claim.

## Independent sensitivity audit and installation checks

`node scripts/garage-pipe-simulation.js` retains a separate physical sensitivity
audit. Its 432 combinations vary wall thickness, insulation, effective surface
transfer, initial water temperature and cold-air temperature. Eighteen repeated
door-pulse scenarios vary duration, recovery and starting temperature. Insulation
is a comparison only; this installation's reference is bare pipe.

That audit also calculates full phase-change time, using water latent heat of
333,550 J/kg. **Full freezing time is not time before freezing begins, time to
damage or an operational exposure allowance.** Local wall ice or a plug can
precede full phase change. The model omits internal water gradients, fittings,
support conduction, connected warm sections and local radiation/draft geometry.
The [Copper Development Association handbook](https://www.copper.org/applications/plumbing/cth/design-installation/cth_3design_gencon.html)
distinguishes tolerance of some expansion from permission to freeze water lines.

Validate the assumed heat transfer with a temporary contact probe on the copper,
recorded alongside the air sensor during ordinary cooling and reheating. Measure
the delay from requesting heat to useful local warming. Garage air history can
describe exposure and reporting cadence, but cannot identify the pipe's response
or certify that every stored liquid follows the same reference.
