# Garage heating

Garage supports a persistent room setting and price-based reductions of the
effective room target. Native power stays ON during automatic savings; a higher
adjusted external temperature reduces demand without power cycling. The pump can
still heat at the lower target, so this is not a guarantee of a stopped compressor.
Economic control never preheats or raises the saved room setting. Two cooling rates
predict rear/front air, while independent copper-pipe references limit reduction.
Normal heating and observed recovery must complete before another cycle starts.
Manual timed OFF remains a separate control with automatic restoration.
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
minimum planned reduction time, minimum normal-heating interval and daily start limit
alongside the independent pipe protection assumptions. Both rear and front
readings are required. The **Garage heat model** below explains recorded inputs,
learning evidence and model coefficients, keeping those distinct from owner
policy.

Permanent installation choices use sparse private overrides and **Apply
configuration**; shared engineering defaults and standard MQTT topics stay in
`config.json.options.garage`. See the [configuration guide](configuration.md) for
a minimal override. Public defaults are `enabled:false`,
`protection.approved:false`, `savingsStrategy:"balanced"`, `minSavingsEur:0.50`, `minOffMs:3600000` (one hour),
`minOnMs:10800000` (three hours) and `maxPausesPerDay:1` and `reducedRoomTargetC:0`.
The existing cadence settings describe target reductions: `minOffMs` is their
minimum planned duration, `minOnMs` the normal-target interval, and
`maxPausesPerDay` their daily admission limit. They do not count compressor starts.

`enabled` enables the Garage integration. The independent dashboard
**Plan only / Automatic** choice authorizes economic actuation.
`protection.approved` records the owner's review and approval of the protection
assumptions for that installation. Both may be set to `true` in private overrides;
the unapproved public default does not prohibit an owner's explicit approval.
Approval does not verify the assumptions or establish adapter readiness. With
approval false, available observations still update the reference reserve and
support learning where the evidence qualifies, but manual heating-OFF permissions and
actionable target reductions are blocked. This is not a full automatic-planning
preview. Fresh sensors and every other control requirement still apply after
approval. The public MQTT topics alone establish no Pill availability or
commissioning.

There is no fixed maximum reduction duration or artificial planning-horizon cutoff. Local
temperatures, the predicted pipe reserve and uncertainty, price/weather coverage and remaining
savings determine how long the effective room target can remain reduced.
The daily limit counts starts in the Finnish calendar day, including unsuccessful
attempts. A new process must observe the normal-heating dwell again. A reporting interruption, target reduction or native OFF state resets that dwell.

Gentle, Balanced and More savings require net benefit greater than 1.5, 1 or 0.5
times `minSavingsEur`. With the default €0.50 baseline, that is more than €0.75,
€0.50 or €0.25 after estimated recovery and uncertainty. Among qualifying safe
windows, the planner chooses the shortest retaining at least 60%, 80% or 100% of
the best net benefit respectively. Equal durations prefer greater benefit, then
an earlier start. More savings therefore pursues the greatest benefit, with
shorter duration breaking ties. Gentle favours shorter reductions even when a longer
reduction could save slightly more. These are configured decision policies, not
learned optimal values or annual savings percentages. Temperature protection,
uncertainty, minimum reduction/recovery requirements and daily limits apply at every
strategy. See [the selection model](garage-model.md#one-opportunity-at-a-time).

**Room setting** in Heat-pump settings accepts a persistent target down to **5°C**
when the installed Pill supports external temperature control and its local
feature flag is enabled. Targets below 16°C use the independent Garage rear
sensor, `garage_temperature`. The pump must already be ON in HEAT mode. ST-MQ
explicitly commands and confirms the native 17°C target and feeds the Pill
`rear temperature + (17 − room setting)`; a 5°C setting adds
12°C. The room setting and native 17°C readback are displayed separately.

Automatic price control temporarily replaces the effective target with configured
`reducedRoomTargetC`, default **0°C**, while retaining the owner's saved target
(minimum **5°C**). It uses the same formula and fresh source clocks: for example,
rear 6°C with effective target 0°C supplies 23°C to the pump at native 17°C.
The control value is not a room measurement. The display keeps the saved room
setting visible and identifies the temporary target, deadline and acknowledgement.
A target at or above the saved target offers no reduction. Current automatic
target control requires a saved external room target below 16°C; it does not
silently convert ordinary native room settings into external control.

An empty database starts from a fresh unambiguous pump setting. Subsequent room
choices are retained as device-bound application state, outside configuration
and without expiry. Fan and vane adjustments preserve the target through any
required clear/write/confirm/re-enable sequence. Ordinary native power OFF and non-heating modes
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
The Pill can continue an already admitted sample for up to 90 seconds
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
the serial path before ordinary native settings or manual timed OFF can proceed.
These software checks do not certify physical frost protection.

The `shelly-cn105` driver supports ordinary Mitsubishi settings, external input
and separate bounded pause leases. Price automation needs the external-input
capability, local enablement, fresh native ON/HEAT/17°C, qualified source evidence,
ownership and protection. It does not require the manual OFF permission or its
selective-power commissioning checks. Manual timed OFF additionally requires
installed selective-power/local-expiry/restart evidence, release-ordering
capability, accepted ordinary HEAT settings and approved freeze protection.
The supported external baseline is native 17°C; special low-temperature mode
preservation is not a requirement. Driver deployment and installed qualification
remain separate from editing this application. See the [adapter contract](garage-adapter.md).

Garage independently chooses **Plan only** or **Automatic**. Plan only computes
plans and collects evidence without automatic target changes. Home, charging
and Caravan have their own automation choices. Persistent native room settings
and explicit bounded heating selections remain available when automation is off.

**Pause price control** suspends economic control until its Finnish local deadline.
**Normal heating** and **Heating off** are explicit selections under
**Temporary heating override**, available with live input and control ownership.
During Pause the selection is held until its deadline; otherwise the next
controller update, normally within one minute, takes over. Freeze protection can
restore heating sooner. Manual OFF uses a qualified bounded device-local lease;
its purpose stays in the application, not in separate driver permissions.
The request never becomes indefinite ordinary power OFF.

When external temperature control is active, manual Heating off first clears it
and waits for internal-sensor acknowledgement and durable cleanup before OFF.
The saved room target is retained. Normal, expiry or cancellation restores native
ON; only fresh ON evidence and a new qualified source sample allow external input
to resume at the saved target. The automatic saving path avoids this handover
by changing the external offset while native power remains ON.

Independent native setting changes inhibit resumption. Restart retains the price
pause and restoration obligation, but neither saved OFF permission nor cached
sensor data grants control. The buttons show clearing, requesting, confirmed,
restoring or specific unconfirmed outcomes. Native power readback confirms manual
ON/OFF; a reduced target also requires current external-input acknowledgement.
Serial acknowledgement does not prove which sensor the pump uses or that its
compressor has stopped. Native ON is not proof of useful heat.

Authenticated mutations return the full dashboard status:
`POST /api/garage/temporary`, `POST /api/garage/heating`,
and `POST /api/garage/native`. Room setting uses
`{ "setting": "targetC", "value": 5 }`. Slaves cannot change settings or command
the pump. UI polling never renews an OFF permission.

## Sensors, doors and protection

`garage_temperature` is rear; `garage_temperature_2` is front. Both must have
fresh external reports for every automatic reduction. Retained packets, repeated
source timestamps and the pump's own room sensor cannot replace them. Configured
MQTT door contacts retain a confirmed state until an event or availability loss;
confirmation and original source time remain distinct.

A new target reduction is blocked when any configured door is open **or unknown**
and fresh outside temperature is **below 2°C**. At exactly 2°C or above, either
door state passes this rule. Unknown outdoor temperature still blocks a start.
Door changes during an existing reduction trigger the ordinary protection
reassessment; they are not an unconditional cancellation. Door area alone
does not establish air exchange: wind, open duration and mixing are missing.
There is no fitted door coefficient or invented heat-loss calculation. Affected
intervals are excluded from clean cooling/reference/validation evidence.

When HA or its door bridge is unavailable, unknown doors use the same 2°C rule
as open doors. An already acknowledged external sample can also survive a brief transport-only
probe outage while both conservative reserve estimates still cover its original
permission and useful-heating delay. Such an outage alone does not extend external permission.
Held readings cannot start or renew a reduction. Invalid readings, changed source,
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

Permissions are revalidated every minute and bounded by original measurement
clocks, protection reserve and useful-heating delay. The short external permission
does not limit the total reduction duration. The independent safety loop can
withdraw permission but never renew it. Manual OFF persists its restoration duty
before publication. Shutdown, lost authority, stale inputs and restart retain
cleanup obligations; restart never resumes an old OFF lease or external sample.

## Learning, recovery and reporting

`committed-garage-v7-room-reference` learns only two effective cooling coefficients,
from clean OFF intervals. Charger heat is **7.5% of qualifying charger energy**
(or power), shown separately. It never schedules charging for warmth or credits
future charging when judging a safe reduction. Current, unknown and forecast charging
status and power do not restrict target reductions or alter the planned window.
Actual warmth is reflected in measured temperatures. Charging-disturbed or unknown
configured charger input still cannot train clean cooling/reference data or
establish comparable savings; those evidence rules do not block reduction admission.

Normal electricity uses a qualified observed mean when available, otherwise an
explicit **0.5 kW assumption**. Compressor activity/frequency is never converted
to watts, and electrical input does not establish delivered thermal heat. For lower-target operation the planner includes an engineering idle allowance
of the greater of 0.1 kW or 25% of normal input, capped at normal input. It also
estimates maintenance heating at the lower target; neither is measured standby
or a physical upper bound. Avoided electricity is normal-reference consumption
minus that lower-target estimate, never an assumed zero-power interval. The
planner repays **125% of estimated avoided electricity** at subsequent prices,
spread over at least three hours and at least 1.25 times the reduction duration, and
deducts prediction uncertainty. This is a
conservative accounting assumption, not a learned COP or a verified savings claim.
Flat or small price differences keep normal heating available.

Once normal reference learning qualifies, the first worthwhile opportunity may
use the initial cooling estimates with explicit uncertainty margins. Clean observed native-OFF training and held-out cooling/recovery episodes improve
the cooling evidence. A price reduction remains observed native ON and does not
become an OFF training experiment. Its forecast is explicitly extrapolated from
that cooling evidence, with separate lower-target electricity assumptions.
The observed validation duration is shown as evidence, not a permission ceiling;
forecasts beyond it carry increasing uncertainty. The one-hour planned minimum
avoids frequent short cycles. Protection can always restore heating sooner.
Every automatic event has one contiguous target-reduction interval and a fixed latest endpoint. No new
reduction can start during its recovery. Both actual external temperatures, sustained
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

If changed weather makes the frozen pre-reduction temperatures unreachable, recovery
can close as **incomplete**, with no savings claim, after continuous fresh accepted
native ON with both actual locations and both certain pipe references above the
protection margin. That continuous interval must cover the longest of eight hours,
the configured minimum ON time, the originally planned recovery-pricing period,
and the recovery allowance for the actual reduction duration (at least three hours and
1.25 times reduction hours). Longer reductions therefore retain their full recovery obligation. Closing and a normal-reference reset are committed atomically.
The reset clears reference/electricity observers and their previous input, retires
active validation as incomplete, and retains learned cooling rates. The same
context event replays deterministically; new normal-temperature evidence must
qualify before another economic reduction. Brief charging disturbances, changed
baseline/source and unqualified electricity never fabricate completed savings.
