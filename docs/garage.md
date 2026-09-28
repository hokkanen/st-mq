# Garage heating

Garage supports a persistent room setting and occasional worthwhile heat-pump OFF
periods. Economic control never preheats or raises the room setting. Two simple cooling rates predict the rear and front air;
two independent copper-pipe reference temperatures limit the pause. After each
pause, normal heating and observed recovery must complete before another starts.
Home heating, charging schedules and their savings accounting remain separate.

## Configuration and everyday controls

The Garage card opens Heating configuration. Home and Garage use the same order:
current state, **Temporary heating override**, **Pause price control**, strategy
and limits, then the separate heat model. Home calls its decision section
**Heating strategy & comfort**; Garage uses **Heating strategy & protection**.
Garage's current state shows heat-pump mode, heating control and the saved room
setting, distinguishing current device feedback from a requested state and
external-control availability.

Saved room intent is bound to the configured device, MQTT address and account.
Changing that binding leaves the earlier record and history intact but does not
apply its target to the new connection or prevent controller startup. Fresh
native evidence can establish the new room setting; select a low-temperature
target explicitly again when needed. A journaled reference boundary prevents
the old target from being restored indirectly through learned state. Existing
freeze exposure and physical restoration obligations remain protected.

Both offer **Gentle**, **Balanced** and **More savings**, with Balanced as the
default. Changes use **Apply configuration**. All three can select worthwhile
cycles; **Pause price control** suspends automatic savings. The decision sections
explain what the controller can do, what makes a cycle worthwhile, the limits
that always apply, and how predictions from the separate heat model guide
selection and ongoing checks. Garage shows its effective minimum benefit,
minimum planned OFF time, minimum normal-heating interval and daily start limit
alongside the independent pipe protection assumptions. Both rear and front
readings are required. The **Garage heat model** below explains recorded inputs,
learning evidence and model coefficients, keeping those distinct from owner
policy.

Permanent installation choices use sparse private overrides and **Apply
configuration**; shared engineering defaults and standard MQTT topics stay in
`config.json.options.garage`. See the [configuration guide](configuration.md) for
a minimal override. Public defaults are `enabled:false`,
`protection.approved:false`, `savingsStrategy:"balanced"`, `minSavingsEur:0.50`, `minOffMs:3600000` (one hour),
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
interruption or OFF state resets that dwell.

Gentle, Balanced and More savings require net benefit greater than 1.5, 1 or 0.5
times `minSavingsEur`. With the default €0.50 baseline, that is more than €0.75,
€0.50 or €0.25 after estimated recovery and uncertainty. Among qualifying safe
windows, the planner chooses the shortest retaining at least 60%, 80% or 100% of
the best net benefit respectively. Equal durations prefer greater benefit, then
an earlier start. More savings therefore pursues the greatest benefit, with
shorter duration breaking ties. Gentle favours shorter pauses even when a longer
pause could save slightly more. These are configured decision policies, not
learned optimal values or annual savings percentages. Temperature protection,
uncertainty, minimum OFF/recovery requirements and daily limits apply at every
strategy. See [the selection model](garage-model.md#one-opportunity-at-a-time).

**Room setting** in Heat-pump settings accepts a persistent target down to **5°C**
when the installed Pill supports external temperature control and its local
feature flag is enabled. Targets below 16°C use the independent Garage rear
sensor, `garage_temperature`. The pump must already be ON in HEAT mode. ST-MQ
explicitly commands and confirms the native 17°C target and feeds the Pill
`rear temperature + (17 − room setting)`; a 5°C setting adds
12°C. The room setting and native 17°C readback are displayed separately. This
does not use Mitsubishi i-save or assume that a special mode survives OFF/ON.

An empty database starts from a fresh unambiguous pump setting. Subsequent room
choices are retained as device-bound application state, outside configuration
and without expiry. Fan and vane adjustments preserve the target through any
required clear/write/confirm/re-enable sequence. Power off and non-heating modes
retain the choice without forcing heating back on. Choosing a room temperature
of 16°C or higher replaces the lower target and selects native internal sensing.

Remote temperature values use the driver's 8–39.5°C range and 0.5°C steps. The
current driver advertises a **180-second ceiling**; the host requests at most
**120 seconds from the older front/rear measurement**. Both measurements must be
younger than two minutes to admit or renew external control, and the thermal
reserve can require an earlier deadline. Repeated, retained or cached reconnect
reports cannot refresh these clocks. Each enable or renewal also requires ON,
HEAT and 17°C readbacks using the existing 30-second freshness requirement.
A failed native check stops renewals and lets the existing permission expire.
Pill driver 1.2.5 can continue an already admitted sample for up to 90 seconds
since its last valid native settings report, or the original sample expiry if
earlier. MQTT/Wi-Fi loss alone also leaves that original expiry intact. Known
incompatible settings or serial-write uncertainty still request immediate cleanup.

Front and rear must each have qualified freeze-protection reserve covering the
remaining permission and the delay until heating becomes useful. These checks
apply even when economic control or its protection approval is disabled. Missing
thermal history, an unknown heating delay or insufficient reserve blocks the
external override; either location can require earlier clearing. The pump's
internal sensor then uses the current native settings, normally HEAT at 17°C.
Manual power and mode choices are respected.

Brief communication interruptions may retain only the previously acknowledged
sample within its original deadline, provided the conservative reserve assessment
still permits it. The UI shows **Held** and leaves current control unconfirmed.
No new permission is issued from disconnected or held readings, and gaps remain
visible in temperature history and learning. Invalid readings, source changes
and expired evidence are not connection grace. When the Pill reconnects, fresh
same-session state must establish whether the sample survived. The driver enforces
the shorter host expiry locally; observed cleanup is always respected.
Reconnection cannot extend the deadline.
If a published renewal is lost, a fresh acknowledgement of the previous sample
and a new device challenge can permit a retry after 10 seconds. Exact fresh ACK
can also resolve a request made uncertain by MQTT loss or a 45-second result
timeout during Pill-only silence. An acknowledged predecessor can remain **Held**
under its original expiry and freeze protection while awaiting that fresh reply.
The timeout stays visible and grants no new permission. Without acknowledged
coverage, or with fresh conflicting evidence, cleanup is required; an already
sent clear cannot be reversed. Ownership changes or reboot also require cleanup;
retries never reset sensor clocks.
The retained room target resumes after a host restart only once fresh source
evidence and native setup are established again. The override is cleared through
the serial path before ordinary native settings or a managed pause can proceed.
These software checks do not certify physical frost protection or qualify the
installation's low-heat behavior.

The `shelly-cn105` driver supports ordinary Mitsubishi settings and selective
pause leases. Automatic pauses additionally require local arming, fresh matching
native mode/fan/vanes, selective power, local expiry and restart-restoration
commissioning, healthy communications, active host authority and approved
protection. Economic pauses still require the independently verified native
baseline; external temperature control does not supply that commissioning
evidence. Driver configuration, deployment and live commissioning are separate
from editing ST-MQ. See [adapter contract](garage-adapter.md).

**Pause price control** suspends economic control until its Finnish local deadline.
**Normal heating** and **Heating off** are explicit manual selections under
**Temporary heating override**. These controls require Active operating mode and
live input; this does not mean the compressor must already be heating. During
Pause the selection is held until its deadline; otherwise the next controller
update, normally within one minute, takes over. Freeze protection can restore
heating sooner. Manual OFF still needs the adapter's lease,
authority, restoration and freezing-protection checks. Restart retains the price
pause but restores an owned OFF request. Native ON is a request to allow the
pump's own thermostat to work, not a claim that it is producing heat.

Authenticated mutations return the full dashboard status:
`POST /api/garage/temporary`, `POST /api/garage/heating`,
and `POST /api/garage/native`. Room setting uses
`{ "setting": "targetC", "value": 5 }`. Slaves cannot change settings or command
the pump. UI polling never renews an OFF permission.

## Sensors, doors and protection

`garage_temperature` is rear; `garage_temperature_2` is front. Both must have
fresh external reports for every automatic pause. Retained packets, repeated
source timestamps and the pump's own room sensor cannot replace them. Configured
MQTT door contacts retain a confirmed state until an event or availability loss;
confirmation and original source time remain distinct.

A new savings pause is blocked when any configured door is open **or unknown**
and fresh outside temperature is **below 2°C**. At exactly 2°C or above, either
door state passes this rule. Unknown outdoor temperature still blocks a start.
Door changes during an existing pause trigger the ordinary protection
reassessment; they are not an unconditional cancellation. Door area alone
does not establish air exchange: wind, open duration and mixing are missing.
There is no fitted door coefficient or invented heat-loss calculation. Affected
intervals are excluded from clean cooling/reference/validation evidence.

When HA or its door bridge is unavailable, unknown doors use the same 2°C rule
as open doors. An existing accepted pause can also survive a brief transport-only
probe outage while both conservative reserve estimates still cover its original
permission and useful-heating delay. Such an outage alone does not request ON.
Held readings cannot start or renew a pause. Invalid readings, changed source,
insufficient reserve or expired evidence request restoration immediately.

Both managed OFF and external-temperature control request local expiry no later
than **120 seconds after the older supporting front/rear measurement**, shortened
when protection requires. Both retain the driver's **180-second ceiling** while
requesting the shorter host deadline. No extra grace starts at disconnect or
reconnect. If the host or broker fails, the commissioned Pill must honor that
original local expiry. Restart or promotion never resumes the former host's OFF
permission. These software
fallbacks require a working, powered Pill and serial path; native ON alone is
not proof of useful heat or physical frost protection.

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

`committed-garage-v7-room-reference` learns only two effective cooling coefficients,
from clean OFF intervals. Charger heat is **7.5% of qualifying charger energy**
(or power), shown separately. It never schedules charging for warmth or credits
future charging when judging safe OFF time. Current, unknown and forecast charging
status and power do not restrict savings pauses or alter the planned window.
Actual warmth is reflected in measured temperatures. Charging-disturbed or unknown
configured charger input still cannot train clean cooling/reference data or
establish comparable savings; those evidence rules do not block pause admission.

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

The current journal saves its own seed. Live learning, reconstruction and
coefficient charts share the ordered update function and recorded configuration.
Previous development algorithms and exposure shapes require an explicit fresh
database; they are not migrated or continued as archived episodes. Current-format
restart preserves actual protection and restoration obligations. Source corrections
never rewrite original observations. See [reconstruction contract](reconstruction-and-versioning.md).

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
