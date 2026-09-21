# Garage heating

Garage chooses occasional worthwhile heat-pump OFF periods. It never preheats or
raises the room setting. Two simple cooling rates predict the rear and front air;
two independent copper-pipe reference temperatures limit the pause. After each
pause, normal heating and observed recovery must complete before another starts.
Home heating, charging schedules and their savings accounting remain separate.

## Configuration and everyday controls

The Garage card opens Heating configuration. Its controls, Pause savings,
Savings & protection and Garage learning follow the structure of Home heating.
The learning disclosure has four sections:

- **Learning outcomes · Calculated:** supported cooling duration, prediction
  errors, normal rear/front warmth and electricity estimate basis.
- **Model inputs · Recorded & modeled:** external temperatures, native availability,
  reported electricity/activity, door evidence and fixed charger heat attribution.
- **Model coefficients · Current values:** rear/front cooling rates and the few
  fixed electricity/recovery assumptions, with their evidence.
- **Planning & safeguards · Decisions & limits:** current opportunity, minimum
  saving, dwell/duration limits, daily count and independent protection.

Permanent engineering settings use private configuration and Apply configuration.
Defaults are `enabled:false`, `minSavingsEur:0.50`, `minOffMs:3600000` (one hour),
`maxPauseHours:2`, `minOnMs:10800000` (three hours) and `maxPausesPerDay:1`.
The daily limit counts starts in the Finnish calendar day, including unsuccessful
attempts. A new process must observe the normal-heating dwell again. A reporting
interruption or OFF state resets that dwell. The retained `aggressiveness` setting
is only an enable preference: zero disables economic pauses; every positive value
uses the same explicit opportunity thresholds.

The **Assume i-save 10°C** checkbox in Heat-pump settings is stored immediately
on the owning instance. It records the owner's assumption that i-save stays at
10°C through OFF/ON. It does not activate i-save or command a thermostat change.
The room setting reads **10°C · Assumed i-save**; the detailed native reading
continues to show what CN105 actually reported, including 16°C. Verification
remains false unless independently established. Clearing the checkbox releases
an owned pause and restores strict baseline requirements.

The `shelly-cn105` driver supports ordinary Mitsubishi settings and selective
pause leases. Automatic pauses additionally require local arming, fresh matching
native mode/fan/vanes, selective power, local expiry and restart-restoration
commissioning, healthy communications, active host authority and approved
protection. The checkbox can replace the low-heat verification requirement only
when the installed driver advertises assumption support. An older driver stays
blocked until updated. Driver configuration, deployment and live commissioning
are separate from editing ST-MQ. See [adapter contract](garage-adapter.md).

**Pause savings** suspends economic control until its Finnish local deadline.
**Normal heating** and **Heating off** are explicit manual selections. During
Pause savings the selection is held until its deadline; otherwise the next
controller update takes over. Manual OFF still needs the adapter's lease,
authority, restoration and freezing-protection checks. Restart retains the price
pause but restores an owned OFF request. Native ON is a request to allow the
pump's own thermostat to work, not a claim that it is producing heat.

Authenticated mutations return the full dashboard status:
`POST /api/garage/temporary`, `POST /api/garage/heating`,
`POST /api/garage/native`, and `POST /api/garage/preferences` with exactly
`{ "assumeISave10C": true }` or false. Replicas cannot change settings or command
the pump. UI polling never renews an OFF permission.

## Sensors, doors and protection

`garage_temperature` is rear; `garage_temperature_2` is front. Both must have
fresh external reports for every automatic pause. Retained packets, repeated
source timestamps and the pump's own room sensor cannot replace them. Configured
MQTT door contacts retain a confirmed state until an event or availability loss;
confirmation and original source time remain distinct.

A new savings pause is blocked when any configured door is open and fresh outside
temperature is **below 2°C**. Unknown configured door state or outdoor temperature
also blocks a start. Opening during an existing pause triggers the ordinary
protection reassessment; it is not an unconditional cancellation. Door area alone
does not establish air exchange: wind, open duration and mixing are missing.
There is no fitted door coefficient or invented heat-loss calculation. Affected
intervals are excluded from clean cooling/reference/validation evidence.

Protection retains `garage-thermal-reserve-v1`: each location has its own
persisted water-filled copper-pipe reference, initially 21 mm outside diameter,
1 mm assumed wall, 20 W/m²·K heat transfer and a fixed factor of two that speeds
cooling and slows warming. The reference must remain above the 1°C margin.
This is a reference-object limit, not a 1°C air cutoff. The engineering defaults
remain unapproved until the actual installation has been reviewed.
Missing history grants no assumed warmth, and one location cannot borrow the
other's reserve. See [protection assumptions](garage-protection-defaults.md).

Permissions are revalidated every minute and bounded by fresh external temperature
evidence, outstanding possible OFF permission and the driver’s useful-heating
response allowance. The independent safety loop can revoke permission but never
renew it. Persistence precedes OFF publication. Shutdown, lost authority, stale
inputs and restart retain restoration obligations; restart never resumes OFF.

## Learning, recovery and reporting

`committed-garage-v4-simple-off` learns only two effective cooling coefficients,
from clean OFF intervals. Charger heat is **7.5% of qualifying charger energy**
(or power), shown separately. It never schedules charging for warmth or credits
future charging when judging safe OFF time. Current charging suppresses a new
opportunity because it may already suppress heat-pump demand. Unknown configured
charger input cannot train clean cooling/reference data.

Normal electricity uses a qualified observed mean when available, otherwise an
explicit **0.5 kW assumption**. Compressor activity/frequency is never converted
to watts, and electrical input does not establish delivered thermal heat. The
planner repays **125% of estimated avoided electricity** at subsequent prices,
spread over at least three hours, and deducts prediction uncertainty. This is a
conservative accounting assumption, not a learned COP or a verified savings claim.
Flat or small price differences keep normal heating available.

The first worthwhile opportunity can be a bounded one-hour trial after normal
reference learning. Longer pauses require completed training and held-out
cooling/recovery evidence. All opportunities remain capped at two hours by default.
Every event has one contiguous OFF interval and a fixed latest endpoint. No new
pause can start during its recovery. Both actual external temperatures, sustained
normal availability and both pipe reserves determine recovery; no hidden building
core is estimated. A missing-accounting recovery closes without claiming savings.

The first v4 journal entry saves its own seed. Live learning, reconstruction and
coefficient charts share the ordered update function and recorded configuration.
Previous algorithms are archival; their frozen forecasts and costs are never
reinterpreted as v4. Existing protection and measured restoration obligations
survive the version boundary. Sensor corrections remain source events and never
rewrite original observations. See [reconstruction contract](reconstruction-and-versioning.md).

Garage completed model savings are provisional comparisons against a frozen
normal-heating reference. Metered recovery is counted directly; unmetered recovery
pays the fixed allowance before completion. Recorded daily timing comparison
requires dedicated, qualified garage electricity and remains unavailable without
it. **Heating savings** keeps Home / Garage / Total and preserves missing or
negative results. See [reporting](garage-reporting.md), [model details](garage-model.md)
and [independent simulation](garage-simulation-audit.md).

If changed weather makes the frozen pre-pause temperatures unreachable, eight
continuous hours of fresh accepted native ON with both actual locations and both
certain pipe references above the protection margin can close recovery as
**incomplete**, with no savings claim. This also respects a longer configured
minimum ON time. Closing and a normal-reference reset are committed atomically.
The reset clears reference/electricity observers and their previous input, retires
active validation as incomplete, and retains learned cooling rates. The same
context event replays deterministically; new normal-temperature evidence must
qualify before another economic pause. Brief charging disturbances, changed
baseline/source and unqualified electricity never fabricate completed savings.
