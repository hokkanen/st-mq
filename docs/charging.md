# Charging

ST-MQ models two physical charging points: **Charger 1 is Easee**, using either the cloud delayed-start scheduler or the native OCPP controller’s expiring zero-current pauses; **Charger 2 is the commissioned Top AC / Shelly XT1 EVSE**, controlled through MQTT RPC. TeslaMate and BMW CarData supply vehicle evidence for either charging point. They never supply another home electricity contribution or receive vehicle commands.

Charger 1 uses one control backend at a time. Native OCPP activation releases
ST-MQ's owned cloud instruction and waits when a foreign cloud schedule still
owns charging. Cloud telemetry remains a data fallback without silently
reactivating cloud scheduling. Native `plug-and-charge` authorization can start
a connected vehicle without an RFID tap; RFID mode instead requires permitted
tags. Native economic pauses expire on the charger and release to its existing
charger/vehicle/Equalizer limits without positive-current commands. See
[local setup and native control](charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later).

**Native OCPP needs ST-MQ for charging authorization.** Normal Ctrl+C or service
stop requests a return to cloud control; paired handover keeps OCPP active. A
failed cloud request leaves handback unconfirmed. A crash or power loss can leave
new charging or Easee app Start waiting for approval. Restart ST-MQ or disable
Direct OCPP through Easee configuration. Expiring economic pauses do not provide
automatic cloud authorization after a crash.

Charger 2 is disabled and unverified by default because the hardware has not arrived. Its production acquisition, planning, recording and command paths are implemented and tested with synthetic providers. Enabling MQTT acquisition is separate from commissioning control. See [provider capabilities and commissioning](charging-provider-capabilities.md).

## Dashboard and requests

Both charger cards show the physical connection, assigned vehicle or uncertainty, current request, measured/estimated progress, connection cost and control state. The Automatic charging switch governs economic scheduling. Vehicle identification and metering continue with automatic charging OFF. The separately configured Charger 2 limiter can remain active with economic scheduling OFF.

Each card’s **How charging works** section explains its scheduling, current
limits and pause recovery. Easee cloud delays and local OCPP pauses can release
on the charger without a new command; Shelly pauses need a live application
command to resume. Local OCPP pause expiry does not authorize a new charging
session or restore cloud control. The Identification section keeps the current
test status and any outstanding recovery or review action.

An open charging period can show **Charging is allowed** while the connected
vehicle draws no power. A later planned period does not mean the current one
has paused. **Paused between periods** requires the controller to confirm the
pause; a pending transition is shown as unconfirmed, with the next planned
period kept separate from that confirmation. **Reported allowance** is the
Equalizer's current allowance, not actual draw or proof that a scheduling pause
has taken effect. Vehicle timers, limits and other native restrictions still
apply during an open period.

Permanent defaults come only from configuration. Both unidentified charging
points start with 20% charge, an 80% minimum, 06:00 ready-by and 74 kWh capacity
from `charging.defaults`. Identified vehicles apply their sparse
`charging.vehicles.<vehicle>.defaults`: BMW 74 kWh and Tesla 57 kWh initially,
with other values inherited from the shared defaults. These usable capacities
are assumptions, not measurements. Automatic charging starts OFF and shared
priority starts Balanced on a fresh installation. Change both in the dashboard;
these choices survive restart and unplugging for the same equipment. They are
stored separately from configuration and session requests. A changed charger
identity does not inherit automatic-control permission; shared priority resets
when either physical charger changes.

**Save for this session** changes only the current physical connection. The
server requires the current physical association, session ID and request revision, rejecting a stale browser
tab or cable swap. Overrides survive restart only within that same connection;
unplugging returns to configuration defaults. Editing a field does not erase the
live source reading beside it. Draft edits survive ordinary status refreshes.
Change permanent defaults in configuration and choose **Apply configuration**.

**Charge now** is immediately visible at the top right of each charger card.
It releases the controller's automatic scheduling delay for the current session
without changing the Automatic charging choice. It works with Automatic
charging OFF. The button has an explicit **ON/OFF** indicator with a sliding knob
and stays highlighted while ON; click **Charge now** again to turn the override
OFF and use automatic charging (enabling it if it was OFF). ON means immediate
charging is requested; the card's activity line reports whether the vehicle is
actually charging, waiting or blocked.
The card keeps its height while saving and after either action, without an extra
confirmation message. Unplugging also ends the override. **Use automatic** remains
in Details & settings when an external charger instruction has manual priority.
Native vehicle timers, targets, user stops, faults, charger limits and authorization
still apply, and unavailable or uncommissioned hardware cannot be started through
this action.

A manual SoC is a one-time anchor. A newer applicable vehicle reading supersedes it using the provider's source clock, or explicitly labeled receipt time when no measurement clock exists. A pinned capacity outranks the provider capacity. An explicit requested minimum remains distinct from the vehicle's actual ceiling; requesting 95% while the vehicle reports an 80% ceiling is constrained rather than silently rewritten. Vehicle current limits and native not-before times constrain either charging point.

### Schedules inside the vehicle

[TeslaMate MQTT](https://docs.teslamate.org/docs/integrations/mqtt/) exposes
`scheduled_charging_start_time`. ST-MQ uses that next start when selecting the
cheapest feasible charging periods. Unchanged settings keep their original
receipt/provenance while live TeslaMate health establishes feed availability.
This is not a complete weekly schedule: the standard MQTT feed does not expose
all recurrence rules and end times. An absent start does not prove that every
vehicle-side restriction is disabled.

BMW CarData offers charging-profile/window information subject to vehicle
capabilities, but the current [BMW bridge](bmw-cardata.md) forwards battery and
identity facts only. It does **not** currently supply BMW charging windows to
the planner. A window-selection flag without actual times, timezone and mode
cannot safely identify available charging periods. BMW schedule-aware readiness
therefore remains unsupported until the applicable profile is mapped; do not
interpret the forecast as confirmation that a BMW timer allows it.

If a known vehicle start is after ready-by, ST-MQ reports the shortfall and
releases its economic hold so the vehicle can start when it allows. The other
charger keeps its own plan. If published prices do not cover any eligible time,
the provisional fallback also permits charging. ST-MQ cannot override a vehicle
timer, target or user stop. The final period always remains an open release.

### Missing vehicle feeds and takeover

Charging does not require vehicle identification: editable starting charge,
target, usable capacity and ready-by remain available. Within the same identified
physical connection, feed loss preserves the last charge anchor plus recorded
energy, labeled as last known vehicle charge. An explicit starting-charge edit
replaces it. A new or ambiguous connection cannot borrow that estimate.

The BMW publisher sends a live report every five minutes. Ten minutes without
a valid live report withdraws its automatic values even if the broker remains
connected; source measurement clocks do not advance with these reports. Retained
replay alone does not restore live-feed availability. TeslaMate uses its separate
live logger-health reports. Physical charger metering remains independent.

After a master-host failure, the promoted computer needs its own working broker,
device connections and credentials; see [paired operation](pairing.md). Cached
data is not fresh device evidence. Reachable chargers can continue with manual
inputs, and missing prices or supply forecasts select provisional release.
An unreachable charger cannot receive a release, and an unavailable OCPP
authorization server can block new charging. Shelly EVSE controller-loss behavior
remains unverified; software cannot promise an autonomous hardware fallback.

The ready-by time becomes one concrete occurrence when the physical connection starts. Midnight, identification, progress updates, priority changes and restart do not roll it forward. A deliberate session ready-by edit may change it. Late identification replaces default-derived vehicle inputs without splitting the physical session or resetting its costs.

## Vehicle assignment

The observer evaluates both charging points together, including while automatic charging is OFF and hours after connection. Assignment requires positive corroboration: applicable vehicle home/plug/start evidence and physical charging behavior. Similar powers on two charging points can remain ambiguous. A negative Tesla match never identifies BMW or the other charger by elimination.

Assignments carry the physical association, plug epoch and vehicle-feed identity. Changing the configured Tesla car, broker, topic namespace or home-zone configuration cannot lend a replacement source’s readings to a saved match. Genuine disconnect/reconnect events are retained even between planner ticks or MQTT subscription admission and invalidate the old scope. Pause/resume within a connected work state remains one session. Explicit conflicting evidence withdraws certainty. A remembered identity alone cannot authorize a new connection, and current vehicle fields are withdrawn when the upstream feed is unhealthy.

TeslaMate has transport, subscription, live logger-health and per-field evidence checks. Sleeping while healthy is distinct from unhealthy. A reconnect requires a new live healthy pulse. TeslaMate publishes most values only when they change; its current-limit and next-start settings remain available while the logger is healthy, preserving their original receipt times and retained provenance. Fresh physical charging takes precedence over a reported future timer. Retained or last-known values alone cannot identify a car. A live charging-state start within 30 seconds of a physical charging start can corroborate matching power after the normal ramp delay, for up to fifteen minutes, while physical power remains fresh. Retained starts and power cannot supply that evidence. Repeated identical publications and same-value recovery after an unknown gap preserve their original provenance. Every Tesla match requires positive vehicle power and physical power measured within the current session and the last minute; a consumed power observation cannot identify another connection. BMW source timestamps, home scope and consumed plug/start events serve the same separation. Neither feed's remote voltage or power fills missing household electrical measurements.

Easee cloud scheduling, local OCPP and the commissioned Shelly EVSE use the same
vehicle matcher, pending status, consumed-evidence checks and session boundaries.
Their adapters normalize ownership and physical pause evidence before it reaches
identification. A schedule, RPC reply or OCPP acknowledgement alone cannot identify
BMW. Its unchanged-inlet fallback requires both live vehicle transitions to match the charger transitions
around a verified pause request; fresh-plug matching can use a natural stop.
Unknown charger state never counts as a stop.

Identification is an explicit connection phase before economic scheduling.
Easee cloud, local OCPP and Shelly EVSE support one automatic active attempt per
physical connection, including when Automatic charging is OFF or Charge now is selected.
An already confirmed passive match skips the test. Otherwise, live charger
readiness and plausible at-home vehicle context allow the controller to release
its own economic delay and observe charging. Native electrical limits, faults,
authorization, vehicle timers and manual Stop retain priority. Pending
identification has no ten-minute label expiry: a vehicle timer or full battery
can leave it waiting until charging starts. Missing vehicle context leaves it
pending without repeatedly starting a test.

BMW location can become unknown when GPS is unavailable or its coordinate
updates have different source times. A last confirmed home observation can
support identification for up to two hours from its original measurement time,
while the current location remains explicitly unknown. Repeats and restart do
not extend this bound. Away reports and subsequent BMW unplug evidence invalidate
that fallback; fresh vehicle and physical charger correlation is still required.
The charger details show the remembered home observation separately. See
[BMW location context](bmw-cardata.md#home-location). Missing context before a
test leaves its budget unused; loss during an active test never renews its limits.

Once charging starts, a fresh Tesla power match can finish immediately. A usable
BMW charging baseline instead triggers a brief, confirmed pause as soon as it
is available. Startup can use live ongoing BMW charging without inventing a
missing historical start edge. Matching charger and vehicle stop evidence is
still required; an accepted pause command alone is insufficient. Active tests
are serialized across charging points. Shelly requires commissioned control,
fresh physical readings and available MQTT, and retains its electrical limiter
and native restrictions throughout the test.

The test observes charging for at most 60 seconds or 0.15 kWh, whichever is
observed first, then ends inconclusively if no usable match or pause candidate
arrived. These are controller decision limits; telemetry and actuator response
delays can add physical charging. A requested identification pause has a deadline
90 seconds later, rounded up to the next whole second. Easee cloud and OCPP
enforce that expiry at the charger. Shelly's pause uses its start permission and
is released by the application; its outage behavior is described below. A
confirmed identity ends the temporary test immediately and applies the current
charging choice. An expired or interrupted
test becomes **Identification inconclusive** and returns to normal charging
control with session/default battery inputs. Passive matching continues; late
BMW stop evidence can still confirm the same witnessed pause for up to fifteen
minutes. Tests never repeat automatically for that connection.

The attempt, absolute deadlines and physical evidence survive a current-version
restart. A known connection resumes its pending attempt or completed outcome;
restart does not renew its budget. An already connected charger with no saved
connection starts one attempt when fresh readings permit it. Unplugging cancels
the attempt and clears its scope. Easee native pause expiry prevents a stopped
process from leaving an identification-only pause indefinitely.

Shelly has no charger-side expiry for this test. The controller saves its pause
and restoration obligation before sending the stop. If the application or MQTT
connection fails, the temporary stop can last beyond the 90–91 second deadline.
On recovery, fresh native readings must confirm the same equipment and physical
connection before the controller resolves its saved command and returns to the
current charging choice. An unconfirmed stop that cannot be distinguished from
a manual instruction stays uncertain until explicitly resumed. Restarting does not create another attempt or extend
the test deadline. An explicit manual Stop, an active native schedule or an
electrical restriction still prevents starting; an old identification pause
cannot authorize starting a different connection.

Each card places **Charging controls** below **Session settings**, with
**Identify** at the end of the controls. It requests another attempt for the
current connection, even if a vehicle is already identified. The confirmed
association remains visible during that check. The button is disabled when
identification is unavailable, already pending/in progress, or the viewer has no
control authority. It uses the current charger association, session ID and
request revision; an old screen cannot test a replacement connection. Admin and
family users may both use it. Waiting, active testing and an inconclusive outcome
remain separate visible states, independently of the Automatic charging switch.

## Planning and Equalizer

The global priority setting is **balanced**, **Charger 1**, or **Charger 2**. It belongs to the physical charging point and immediately revises allocation when changed. The revision invalidates queued intentions without resetting session requests, manual instructions, metered energy or cost.

Change priority in either charger's details. Both entries edit the same saved
choice, which survives restart and new vehicle connections for the same physical
chargers. Automatic charging is also a persistent dashboard choice; the four
ready-by and battery defaults remain configuration-owned.

The planner first respects device/vehicle limits, manual permission, native start times and credible capacity. It protects both deadlines where the modeled opportunities allow that. Actual all-in electricity cost then governs period selection. Priority must not buy more expensive energy merely to favor a charger. In infeasible cases, charger priority favors its remaining request; balanced mode shares normalized shortfall. Eligible charging time and grid-energy need determine pressure. Shared budgets below two minimum currents use bounded time slices rather than invalid sub-minimum simultaneous commands.

The implementation is a bounded search over a declared slot/current model, **not a globally exact continuous-time optimizer**. Results expose the search kind, relaxed cost lower bound, feasible candidate cost and upper bound on the cost gap where available. Search pruning can miss a better joint candidate; reported feasibility is conditional on the recorded assumptions. Synthetic exhaustive small-horizon comparisons validate representative cases. There is no one-cent pause penalty or mandatory one-cent saving hurdle. Practical minimum economic runs/gaps remain 15 minutes; equal-cost choices prefer stability.

Easee's Equalizer, charger and vehicle determine positive charging current. ST-MQ does not write a positive-current setpoint, circuit protection or fuse setting; native OCPP economic pauses impose only an expiring 0 A restriction. Current already drawn by an automatic-OFF, manually running or post-target peer remains a load until physical evidence says otherwise. Forecast household load, gross configured capacity and current net allowance are distinct. A clipped zero Equalizer allowance does not establish an exact gross budget. Missing rates or capacity produce provisional decisions, not free electricity or invented assured readiness.

The final period is an open release. Reaching the planning minimum or ready-by deadline does not issue a final stop. Extra actual energy remains metered and priced. Unknown future post-target consumption cannot have a guaranteed optimized bill. Later economic pauses require ST-MQ and the provider to be available; the UI distinguishes the proposed plan, dispatched request, readback and observed physical response.

## Charger 2 current allocation

Commissioning must verify three-phase association, phase order, installation fuse ratings and whether the property and charging-current magnitudes support the additive model. For each phase, the modeled non-EV base is `B = property − Easee − Shelly`. The absolute Shelly ceiling is the tightest `fuse − margin − B`, then any planned Easee reservation and hardware, vehicle and native user limits. The calculation includes Shelly's existing draw; it does not mistake incremental spare margin for an absolute setpoint.

Shelly priority excludes Easee's present draw from this fuse test. A temporary property total above the fuse while non-Easee load fits does not cause ST-MQ to fight Equalizer by reducing Shelly. An explicit secondary-deadline reservation can still reduce Shelly and is labeled separately. Equalizer response and actual installation protection are not guaranteed by this model.

A common current is rounded down to the verified step. The initial supported profile uses a verified 6 A minimum and 1 A step; other quantizations fail configuration validation. Values below the verified minimum cause an EVSE pause, not an invalid current RPC. Decreases act promptly. Increases ramp by the configured step budget after dwell; resumption also requires dwell and permission. Native lower current choices, start/stop, energy/time caps, faults and schedules retain authority. Enabled native schedules conservatively own start/stop until disabled/removed; ST-MQ does not guess their cron window or rewrite them. Current limiting remains separate.

Coherent current inputs default to a 15-second age and 5-second skew bound, with 1 A per-phase margin. Unknown, stale, misaligned or non-additive inputs select the owner's configured fallback ceiling, initially **12 A**. Known tighter limits still apply. Fallback does not start a stopped vehicle or bypass its native timer. It is not guaranteed fuse protection.

If the process, broker or charger is unavailable, ST-MQ cannot apply a new fallback. **Autonomous controller-loss behavior is unverified.** There is no invented watchdog, command TTL or broker-will guarantee. Actual last-setpoint, reboot and outage behavior must be established with the arrived hardware before unattended deployment. The status reports this separately from a successfully requested telemetry-loss fallback.

## Charge progress and cost

Physical electricity sources are always Easee for C1 and Shelly EVSE for C2, regardless of vehicle identity. Progress uses accepted interval kWh plus the recorder's admissible pending tail. Wrong units, unusable quality, invalid geometry and overlapping conflicting contributions are excluded. Missing energy receives no invented credit. The modeling assumption is 92.5% grid-to-battery efficiency; it is not measured battery capacity or efficiency.

A new SoC observation rebases modeled progress. Connection energy and cost retain their separate physical-session lifetime across those rebases, edited targets, pauses and restart. Native Shelly accumulated-energy deltas record C2 energy; counter resets, implausible jumps and excessive source-time gaps start a new baseline without bridging invented energy. Its native session-energy field remains diagnostic until reset semantics can be verified.

Price revisions are canonicalized by publication authority over their actual coverage. New quarter/hour slices replace the overlapped region only; negative prices, remaining older coverage and gaps remain explicit. Binary interval lookup prices physical contributions efficiently. Costs distinguish actual delivered, estimated remaining, missing/unpriced coverage and timing comparisons. The per-charger and combined timing benchmark is not proof of causal controller savings.

## Restart and compatibility

Current-format sessions, requests, assignments, costs and uncertain commands recover only within the same physical/source association. Device, MQTT broker/root, configured firmware/profile or phase association changes cannot borrow old ownership. A potentially dispatched command is reconciled with native readback before another intention; it is never blindly replayed.

Pre-1.0 native state is not migrated. The current charging state remains version 6
and database schema 14; the physical adapter uses its own explicitly scoped
current state. New optional control choices default to OFF/Balanced when absent;
recorded presentation never supplies control permission. Retired configuration switches for automatic charging and
priority, dashboard overrides of permanent battery defaults, old pseudo-C2
settings, charger-bound vehicle topics, efficiency overrides, unscoped verdicts
and aliases are rejected. No database reset or data migration is needed for the
new control choices. Only the v0.7.5 `easee.csv` and
`st-mq.csv` import paths are supported historical boundaries. Imported
C1/property history retains its provenance and does not become a Shelly observation.

The **Added energy** tile shows recorded grid energy for the whole plugged-in
connection. A fresh vehicle battery reading can change the charge estimate's
reference, but does not reset this tile. The recorded total remains after charging
finishes, reaching the target, or passing ready-by; confirmed disconnection ends
it. Energy inferred only for a cost estimate is not shown as recorded energy.
