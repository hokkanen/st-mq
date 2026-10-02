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

## Parameters shown in Garage freeze protection

| Parameter | Initial value | Meaning |
| --- | ---: | --- |
| Protection margin | 1°C | Estimated reference temperature where usable reserve reaches zero. |
| Reference pipe outside diameter | 21 mm | Sets the exposed surface and quantity of copper and water. |
| Reference pipe wall thickness | 1 mm | Assumed copper thickness; the water bore is calculated from it. |
| Heat transfer | 20 W/m²·K | Initial estimate of heat exchange with the adjacent air. |
| Safety factor | 2, fixed | Counts heat loss twice as fast and credits heat gain half as fast. |

These parameters appear in **Connections & configuration → Garage freeze
protection**, below **Floor preheating**. Its link opens **Garage → Freeze
protection**, below **Normal temperature**, for live rear/front air readings,
pipe estimates and reserves; the live fold links back to these settings.

The geometry and heat-transfer values are explicit engineering assumptions,
not fitted building-model coefficients. They and installation approval are owned
by `garage.protection` in configuration. The dashboard is read-only and compares
loaded configuration with sender readback; it cannot store a competing preference
or directly edit the sender's parameters. The sender validates and persists
settings delivered from loaded configuration, independently of its pipe state.
The shared installation default is unapproved until explicitly commissioned.

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

## Local sender and recovery

The protection sender runs this calculation independently for both probes.
Neither location can donate reserve to the other. Freshness follows genuine
probe reports; repeating cached values or receiving a new target cannot create
warmth. A short door-related air plunge spends reserve according to actual
elapsed exposure.

The sender persists settings and conservatively handles reboot or acquisition
gaps. Missing history is unknown: it cannot initialize a warm reference merely
from a warm current reading. Protection demand accounts for useful-heating delay,
uses bounded target increases and hysteresis, and holds rescue until both
locations have recovered and remained safe for ten minutes. With uncertain
history, the conservative initial cold state is an assumption, not a measurement
of frozen pipes. Air may already be warm while the model gradually credits pipe
warming; no established pipe temperature or reserve is claimed during that time.
Stored protection state is separate from the removed Garage building model; there is no learned economic controller.

The sender broadcasts room temperature, minimum target, rescue and validity over
Bluetooth. The minimum applies only while the sender demands protection,
including the recovery hold; it is not a permanent 5°C limit. During normal room
regulation, a saved 3°C target with a 5°C minimum temporarily becomes 5°C, then
returns to 3°C on release. The sender reports a zero minimum when monitoring
without demand. The saved target is never overwritten.
The controller explicitly selects HEAT/ON for rescue. A saved 8°C target with a
5°C minimum therefore remains 8°C even during rescue. HEAT/ON enables heating rather than forcing continuous
compressor operation. On recovery, the saved target applies and power stays ON.
ST-MQ displays the sender's actual status/settings and applies loaded configuration over MQTT;
broker/application loss must not stop local protection. Configured feed loss is
a distinct fault policy: HEAT/ON at native 16°C, with the saved target preserved.
Unusable room input or an unrepresentable calculated external temperature also
uses native 16°C in HEAT, preserving power unless protection requests rescue.
With no sender installed, the dashboard reports protection unavailable.

The reference assumptions do not certify every pipe or stored container. Sensor
placement, useful-heating delay, radio reception and pump operation need actual
installation validation. Software tests and normal native ON readback do not prove
that useful heat reached a pipe. The BLU H&T development feed does not supply the
two required locations or pipe-reserve state.
