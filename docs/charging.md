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

Both charger cards show the physical connection, assigned vehicle or uncertainty, current request, measured/estimated progress, connection cost and control state. The automatic switch governs economic scheduling. Passive identification and metering continue with automatic charging OFF. The separately configured Charger 2 limiter can remain active with economic scheduling OFF.

Saved defaults are separate from current-session edits. Automatic charging initially defaults OFF, starting charge to 20%, minimum charge to 80%, and ready-by to 06:00. Unidentified vehicles use each charger's manual capacity fallback (74 kWh for C1, 57 kWh for C2). Identified vehicles use their profiles: BMW 74 kWh, Tesla 57 kWh initially. These usable-capacity values are editable assumptions, not measurements of the owner's batteries.

The **Save defaults** action updates persistent preferences. Default-derived fields also update the connected request; a deliberate session override remains pinned. **Apply edits to this connection** requires the current physical association, session ID and request revision. It rejects a stale browser tab or a cable swap. Editing a field does not erase the live source reading beside it. Draft edits survive ordinary status refreshes.

A manual SoC is a one-time anchor. A newer applicable vehicle reading supersedes it using the provider's source clock, or explicitly labeled receipt time when no measurement clock exists. A pinned capacity outranks the provider capacity. An explicit requested minimum remains distinct from the vehicle's actual ceiling; requesting 95% while the vehicle reports an 80% ceiling is constrained rather than silently rewritten. Vehicle current limits and native not-before times constrain either charging point.

The ready-by time becomes one concrete occurrence when the physical connection starts. Midnight, identification, progress updates, priority changes and restart do not roll it forward. A deliberate request/default edit may change it. Late identification replaces default-derived vehicle inputs without splitting the physical session or resetting its costs.

## Vehicle assignment

The observer evaluates both charging points together, including while automatic charging is OFF and hours after connection. Assignment requires positive corroboration: applicable vehicle home/plug/start evidence and physical charging behavior. Similar powers on two charging points can remain ambiguous. A negative Tesla match never identifies BMW or the other charger by elimination.

Assignments carry the physical association and plug epoch. Genuine disconnect/reconnect events are retained even between planner ticks or MQTT subscription admission and invalidate the old scope. Pause/resume within a connected work state remains one session. Explicit conflicting evidence withdraws certainty. A remembered identity alone cannot authorize a new connection, and current vehicle fields are withdrawn when the upstream feed is unhealthy.

TeslaMate has transport, subscription, live logger-health and per-field evidence checks. Sleeping while healthy is distinct from unhealthy. Retained or last-known values can be shown with provenance without granting current identity or control. BMW source timestamps, home scope and consumed plug/start events serve the same separation. Neither feed's remote voltage or power fills missing household electrical measurements.

## Planning and Equalizer

The global priority setting is **balanced**, **Charger 1**, or **Charger 2**. It belongs to the physical charging point and immediately revises allocation when changed. The revision invalidates queued intentions without resetting session requests, manual instructions, metered energy or cost.

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

Pre-1.0 native state is not migrated. The current charging state uses version 5; the physical adapter uses its own explicitly scoped current state. Old pseudo-C2 settings, charger-bound vehicle topics, efficiency overrides, unscoped verdicts and aliases are rejected. Only the v0.7.5 `easee.csv` and `st-mq.csv` import paths are supported legacy boundaries. Imported C1/property history retains its provenance and does not become a Shelly observation.

The **Added energy** tile shows recorded grid energy for the whole plugged-in
connection. A fresh vehicle battery reading can change the charge estimate's
reference, but does not reset this tile. The recorded total remains after charging
finishes, reaching the target, or passing ready-by; confirmed disconnection ends
it. Energy inferred only for a cost estimate is not shown as recorded energy.
