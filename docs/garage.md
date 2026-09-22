# Garage heating

Garage supports a permanent room setting and occasional worthwhile heat-pump OFF
periods. Economic control never preheats or raises the room setting. Two simple cooling rates predict the rear and front air;
two independent copper-pipe reference temperatures limit the pause. After each
pause, normal heating and observed recovery must complete before another starts.
Home heating, charging schedules and their savings accounting remain separate.

## Configuration and everyday controls

The Garage card opens Heating configuration. Its controls, Pause savings,
Savings & protection and Garage learning follow the structure of Home heating.
The learning disclosure has four sections:

- **Learning outcomes · Calculated:** validated cooling evidence, prediction
  errors, normal rear/front warmth and electricity estimate basis.
- **Model inputs · Recorded & modeled:** external temperatures, native availability,
  reported electricity/activity, door evidence and fixed charger heat attribution.
- **Model coefficients · Current values:** rear/front cooling rates and the few
  fixed electricity/recovery assumptions, with their evidence.
- **Planning & safeguards · Decisions & limits:** current opportunity, minimum
  saving, minimum OFF time, pause spacing, daily count and independent protection.

Permanent installation choices use sparse private overrides and **Apply
configuration**; shared engineering defaults and standard MQTT topics stay in
`config.json.options.garage`. See the [configuration guide](configuration.md) for
a minimal override. Public defaults are `enabled:false`,
`protection.approved:false`, `minSavingsEur:0.50`, `minOffMs:3600000` (one hour),
`minOnMs:10800000` (three hours) and `maxPausesPerDay:1`.

`enabled` opts the installation into automatic Garage control.
`protection.approved` records the owner's review and approval of the protection
assumptions for that installation. Both may be set to `true` in private overrides;
the unapproved public default does not prohibit an owner's explicit approval.
Approval does not verify the assumptions or establish adapter readiness. With
approval false, available observations still update the reference reserve and
support learning where the evidence qualifies, but heating-OFF permissions and
actionable savings pauses are blocked. This is not a full automatic-planning
preview. Fresh sensors and every other control requirement still apply after
approval. The public MQTT topics alone establish no Pill availability or
commissioning.

There is no fixed maximum pause or artificial planning-horizon cutoff. Local
temperatures, the predicted pipe reserve and uncertainty, price/weather coverage and remaining
savings determine how long heating can stay OFF.
The daily limit counts starts in the Finnish calendar day, including unsuccessful
attempts. A new process must observe the normal-heating dwell again. A reporting
interruption or OFF state resets that dwell. The retained `aggressiveness` setting
is only an enable preference: zero disables economic pauses; every positive value
uses the same explicit opportunity thresholds.

**Room setting** in Heat-pump settings accepts a permanent target down to **5°C**
when the installed Pill supports external temperature control and its local
feature flag is enabled. Targets below 16°C use the independent Garage rear
sensor, `garage_temperature`. The pump must already be ON in HEAT mode. ST-MQ
explicitly commands and confirms the native 17°C target and feeds the Pill
`rear temperature + (17 − room setting)`; a 5°C setting adds
12°C. The room setting and native 17°C readback are displayed separately. This
does not use Mitsubishi i-save or assume that a special mode survives OFF/ON.

Remote temperature values use the driver's 8–39.5°C range and 0.5°C steps. Only
original, usable sensor reports less than 90 seconds old can renew the feed;
repeated or retained reports do not refresh them. Each external enable or renewal
also requires ON, HEAT and 17°C readbacks using the existing 30-second freshness
requirement. A failed native check stops renewals and lets the existing lease
expire, without new checks or native writes between renewals. The Pill driver is
unchanged. Missing or stale source evidence ends the feed. The pump's internal
sensor then controls using its current native settings, HEAT at 17°C if unchanged.
The saved room setting resumes after a host restart only once fresh source
evidence and native setup are established again. The override is cleared through
the serial path before ordinary native settings or a managed pause can proceed.
This control path does not establish physical frost protection or qualify the
installation's low-heat behavior.

The `shelly-cn105` driver supports ordinary Mitsubishi settings and selective
pause leases. Automatic pauses additionally require local arming, fresh matching
native mode/fan/vanes, selective power, local expiry and restart-restoration
commissioning, healthy communications, active host authority and approved
protection. Economic pauses still require the independently verified native
baseline; external temperature control does not supply that commissioning
evidence. Driver configuration, deployment and live commissioning are separate
from editing ST-MQ. See [adapter contract](garage-adapter.md).

**Pause savings** suspends economic control until its Finnish local deadline.
**Normal heating** and **Heating off** are explicit manual selections. During
Pause savings the selection is held until its deadline; otherwise the next
controller update takes over. Manual OFF still needs the adapter's lease,
authority, restoration and freezing-protection checks. Restart retains the price
pause but restores an owned OFF request. Native ON is a request to allow the
pump's own thermostat to work, not a claim that it is producing heat.

Authenticated mutations return the full dashboard status:
`POST /api/garage/temporary`, `POST /api/garage/heating`,
and `POST /api/garage/native`. Room setting uses
`{ "setting": "targetC", "value": 5 }`. Replicas cannot change settings or command
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
response allowance. The Pill's short renewable OFF permission protects against
communication loss; it does not limit the total continuous pause. The independent safety loop can revoke permission but never
renew it. Persistence precedes OFF publication. Shutdown, lost authority, stale
inputs and restart retain restoration obligations; restart never resumes OFF.

## Learning, recovery and reporting

`committed-garage-v5-protection-limited` learns only two effective cooling coefficients,
from clean OFF intervals. Charger heat is **7.5% of qualifying charger energy**
(or power), shown separately. It never schedules charging for warmth or credits
future charging when judging safe OFF time. Current charging suppresses a new
opportunity because it may already suppress heat-pump demand. Unknown configured
charger input cannot train clean cooling/reference data.

Normal electricity uses a qualified observed mean when available, otherwise an
explicit **0.5 kW assumption**. Compressor activity/frequency is never converted
to watts, and electrical input does not establish delivered thermal heat. The
planner repays **125% of estimated avoided electricity** at subsequent prices,
spread over at least three hours and at least 1.25 times the OFF duration, and
deducts prediction uncertainty. This is a
conservative accounting assumption, not a learned COP or a verified savings claim.
Flat or small price differences keep normal heating available.

Once normal reference learning qualifies, the first worthwhile opportunity may
use the initial cooling estimates with explicit uncertainty margins. Completed
training and held-out cooling/recovery episodes improve the forecast evidence.
The observed validation duration is shown as evidence, not a permission ceiling;
forecasts beyond it carry increasing uncertainty. The one-hour planned minimum
avoids frequent short cycles. Protection can always restore heating sooner.
Every event has one contiguous OFF interval and a fixed latest endpoint. No new
pause can start during its recovery. Both actual external temperatures, sustained
normal availability and both pipe reserves determine recovery; no hidden building
core is estimated. A missing-accounting recovery closes without claiming savings.

The first v5 journal entry saves its own seed. Live learning, reconstruction and
coefficient charts share the ordered update function and recorded configuration.
Previous algorithms are archival; their frozen forecasts and costs are never
reinterpreted as v5. Existing protection and measured restoration obligations
survive the version boundary. Sensor corrections remain source events and never
rewrite original observations. See [reconstruction contract](reconstruction-and-versioning.md).

Garage completed model savings are provisional comparisons against a frozen
normal-heating reference. Metered recovery is counted directly; unmetered recovery
pays the fixed allowance before completion. Recorded daily timing comparison
requires dedicated, qualified garage electricity and remains unavailable without
it. **Heating savings** keeps Home / Garage / Total and preserves missing or
negative results. See [reporting](garage-reporting.md), [model details](garage-model.md)
and [independent simulation](garage-simulation-audit.md).

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
