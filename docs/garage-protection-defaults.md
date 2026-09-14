# Garage air protection defaults and pipe sensitivity audit

The September 2026 audit lowers the air-policy thresholds and shortens recovery
lockout while preserving independent rear/front measurements, accumulated local
exposure and early restoration. The installation information supplied for this
audit is a **bare copper pipe, 21 mm outside diameter, with stagnant water**.
The temperature gauges measure adjacent air; the new front gauge will sit beside
the pipe near the door opening. Wall thickness and actual local draft speed were
not supplied.

These facts support allowing brief freezing air without declaring that the pipe
has instantly frozen. They do **not** establish a safe subzero duration. A pipe
already near zero can start freezing much sooner than a pipe that has been warm.
The control inputs therefore remain the two real air sensors. The separate pipe
calculation is an audit tool and supplies no live inferred pipe temperature,
latent-heat allowance, or permission to ignore either sensor.

## Default changes

| Setting | Previous | Current | Effect |
| --- | ---: | ---: | --- |
| Exposure floor | 4°C | 2°C | Ordinary air between 2°C and 4°C no longer consumes allowance. |
| Hard restoration threshold | 2°C | −1°C | Brief near-zero air is not an immediate hard-limit event. |
| Independent exposure budget | 120°C·min | 90°C·min | Reduced nominal allowance partly offsets the lower floor. |
| Recovery threshold | 6°C | 4°C | Recovery can start earlier as local air warms. |
| Continuous recovery dwell | 30 min | 20 min | Short warm blips still cannot refill the allowance. |
| Recovery rate after dwell | 0.25°C·min/min | 1°C·min/min | A fully spent allowance needs 110 warm minutes instead of 510. |

Normal heating remains 10°C; aggressiveness remains 50. Automation remains
disabled, and the protection policy remains unapproved. The defaults are an
explicit operational proposal, not an installation safety certificate or an
automatic hardware commissioning action.

Exposure integrates `max(0, 2 - airC)` separately at each location. Starting with
an unused allowance, constant 1°C air spends it in 90 minutes and constant 0°C
air in 45 minutes. These are **index arithmetic**, not safe pipe exposure times.
Restoration lead time and forecast uncertainty reduce the permitted pause;
reaching −1°C requests restoration immediately regardless of remaining index.
This threshold is a control response point, not a predicted freezing point.
An open door may still drive the air below it while heating is already available.

Lowering the floor and hard threshold much further would be difficult to justify
for this bare pipe next to the door. The audit explicitly includes a strong-draft
sensitivity case; the warm bulk-water times should not be used to dismiss it.

## Independent physics calculation

Run `node scripts/garage-pipe-simulation.js` for the reproducible selected results.
The script tests 432 combinations of wall thickness (0.75/1/1.5 mm), insulation
(0/10/20 mm), effective surface heat transfer (5/10/30/60 W/m²K), initial water
temperature (2/5/10°C), and air temperature (−1/−5/−10/−20°C). Insulation is a
sensitivity comparison; **the actual pipe is treated as bare**. Eighteen door
pulse/recovery scenarios cover 2/5/10 minute plunges, initial 2/10°C and three
surface heat-transfer rates. None is fitted to the garage controller.

Per metre, assuming a 1 mm copper wall, the pipe contains about 0.284 kg of water
and 0.563 kg of copper. The total sensible thermal capacity is approximately
1,402 J/(m·K). The calculation uses water/copper densities of 1,000/8,960 kg/m³,
specific heats of 4,180/385 J/(kg·K), and water latent heat of 333,550 J/kg.
These rounded material values are adequate for sensitivity analysis. The
specific-heat scale is consistent with the [University of Texas material table](https://ch301.cm.utexas.edu/data/heat-capacities.php);
the ice enthalpy scale is given by the [IAPWS ice formulation](https://iapws.org/relguide/Ice-Rev2009.pdf).

The uniform bulk approximation uses `C dT/dt = G (air - T)` and time constant
`tau = C / G`, followed by a separate latent phase at 0°C. For insulation, its
cylindrical conduction resistance is added in series with surface resistance;
the illustrative insulation conductivity is 0.035 W/(m·K). Radiation and air
movement are represented together by the selected effective transfer values,
not by invented measurements of local wind. The underlying thermal-capacitance
and conductance relation is described in [NASA's thermal time-constant analysis](https://ntrs.nasa.gov/citations/20090037689).

For **bare pipe, 1 mm wall, constant −10°C surrounding air**:

| Effective surface transfer | Time constant | Bulk reaches 0°C from 10°C | Bulk reaches 0°C from 2°C | Additional complete-phase-change time |
| ---: | ---: | ---: | ---: | ---: |
| 5 W/m²K | 70.8 min | 49.1 min | 12.9 min | 477.8 min |
| 10 W/m²K | 35.4 min | 24.5 min | 6.5 min | 238.9 min |
| 30 W/m²K | 11.8 min | 8.2 min | 2.2 min | 79.6 min |
| 60 W/m²K | 5.9 min | 4.1 min | 1.1 min | 39.8 min |

The last column is deliberately separate: **a long time to freeze all the water
is not a long delay before freezing begins**. Local ice or an obstructing plug
can form before full phase change. Internal stagnant-water temperature gradients,
fittings, pipe support conduction, axial heat from connected sections, actual
surface radiation, ice nucleation and local drafts are omitted. The uniform
temperature approximation is particularly weak at high transfer rates: first
ice near the wall may precede the reported bulk-zero time. This calculation
cannot predict bursting pressure or time to pipe damage. The
[Copper Development Association handbook](https://www.copper.org/applications/plumbing/cth/design-installation/cth_3design_gencon.html)
also distinguishes copper's ability to tolerate some freezing expansion from
permission to expose water lines to freezing.

At 30 W/m²K, a five-minute −10°C door pulse leaves water initially at 10°C above
3°C in this approximation. Starting at 2°C, the identical pulse reaches bulk
zero after about 2.2 minutes and enters the latent phase. Repeated two-minute
plunges separated by only two-minute warm intervals eventually do the same,
even starting warm. That supports retaining local exposure and recovery across
door cycles, rather than forgetting each plunge when air briefly rebounds.

## Protection arithmetic corrections

`garage-exposure-v2` integrates recovery across the actual linear crossing of
the recovery threshold, including partial warm intervals. It processes the
warm and cold parts in time order, so an early warm portion cannot repay cold
exposure that occurs later in the same coarse interval. Equivalent 1/5/15/30
minute samples of the same piecewise linear path produce the same index and
warm dwell, provided the observation gaps are qualified.

Forecast assessment locates hard-limit crossings and budget exhaustion inside
each step. It no longer waits until the next 15-minute row or overlooks an
exhausted budget that recovers before the row endpoint. A supported recovering
forecast also replaces the previous constant-current-temperature extrapolation;
otherwise that extrapolation could deny restoration margin even when the
supplied trajectory warmed in time. Missing future local temperatures cannot
authorize a pause. These improvements preserve the existing distinction between
observed exposure and uncertain temperature forecasts.

The old v1 calculation remains an archival algorithm requiring its matching
repository revision. Upgrading a saved v1 operational exposure retains at least
its previous accumulated index, starts no lower than the current full budget,
clears warm dwell and marks both locations uncertain. Genuine local recovery
must repay that carried debt before permission returns. This is an explicit
operational transition, not replay of old measurements with new arithmetic.
Neither a model refit nor an aggressiveness change upgrades or resets exposure.

An explicitly configured `garage-exposure-v1` value is accepted at the input
boundary and normalized to v2 in the effective configuration. Supplied numeric
policy values, enablement and approval are preserved; no private configuration
file is rewritten. The effective configuration is recorded with its configuration
digest and new Garage learning epoch. Saved v1 exposure still undergoes the
separate uncertain-debt transition above, so retaining configuration approval
does not create fresh allowance. Unknown configured policy versions remain errors.
This narrow normalization prevents an obsolete Garage version field from
blocking Home startup while keeping old journal accounting archival.

Malformed or unsupported saved exposure cannot prevent Home startup. Garage
retains any valid larger local debt, marks both budgets exhausted and uncertain,
and requires measured warm recovery. Invalid or nonfinite exposure counters
cannot authorize a pause.

Validation: `node --test test/garage-protection-simulation.test.js` covers the
432-case sensitivity matrix, constant-air analytic/segment agreement, cold-soak
and repeated-door behavior, default/schema agreement, independent budgets,
cadence invariance, chronological recovery, precise forecast limits, unavailable
forecasts and debt-preserving version transition. Software/simulation validation
does not establish actual pipe temperatures or installed restoration performance.
