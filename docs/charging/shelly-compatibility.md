# Shelly EVSE compatibility

The supported EVSE profile has exhibited SYS permission interruptions after an
acknowledged Start. Native provenance and timing have been observed; their cause
and any firmware correction remain unproven. Under [F3](../../AGENTS.md#f3), the
owner approved the bounded [system-permission policy and native-Stop ambiguity](execution-and-recovery.md#shelly-system-permission-changes).

## Boundaries

`src/charging/shelly-compatibility.js` exposes three named policies:

- **Permission-transition reconciliation:** classify supported SYS transitions,
  preserve witnessed holds and reconcile an acknowledged Start through correlated
  native SYS readback. It never invents an external actor or a missing ACK.
- **Startup retry recovery:** own scoped counters, delays, incident deadlines and
  sustained-draw qualification. Scheduled retries and explicit Charge now
  requests have independent budgets. See the [execution contract](execution-and-recovery.md#startup-retry-recovery).
- **Reboot-state reconciliation:** the pure helpers in `src/charging/shelly-reboot.js`
  classify bounded uptime evidence and decide whether correlated SYS startup
  readings may establish a baseline despite backward native update clocks. The
  adapter owns acquisition, boot epochs and atomic publication; the existing
  controller retains desired intent and all physical duties. See
  [charger reboots](execution-and-recovery.md#shelly-charger-reboots).

The module operates on bounded state and supplied admitted evidence. It sends no
device commands, starts no timer, queries no device and writes no database. The
existing Shelly controller persists the result and rechecks authority, session,
current, native restrictions and command correlation before any publication.
The runtime's normal wakeup mechanism services due recovery; there is no second
command loop. Pending commands and physical restoration obligations stay in the
core controller, outside removable retry state.

Boot evidence is equipment-scoped acquisition state, not part of a session's SYS
retry counters. A recent verified uptime anchor is checkpointed with existing
acquisition evidence writes, without a separate polling heartbeat. After process
restart or handover it remains the conservative reference for detecting a later
boot. An inconclusive sample seeds only volatile monotonic observation; it cannot
replace the durable epoch or authorize backward-clock reconciliation. The owner-approved reboot-gap continuity policy does not reset
either retry budget. Startup baseline reads are not new SYS interruption events;
genuine subsequent transitions still pass through permission reconciliation.

Charge now instruction precedence and return-to-Automatic behavior are permanent
shared controls. Passive incident ingestion in session diagnostics remains
independent of the module, consumes a durable sequence and stores immutable rows
with the report checkpoint. SYS cycles are captured before the native queue is
acknowledged, including cycles between dashboard observations. Model/firmware,
source/receipt clocks, Start/ACK timing and actual applied current are retained
when observed. Raw device identifiers and payloads are excluded. An unsuccessful
report write retains a bounded 128-event replay tail and exposes the existing
diagnostic-storage error; unavailable reporting is not proof of a clean session.
Normal retention applies; only an explicit Save preserves a report permanently.

Reboot incidents have a separate durable sequence and opaque incident ID. A
confirmed reboot is neutral evidence; the third finding is raised only when
backward initialization requires compatibility reconciliation. A baseline is not
restored control, and restored control is not measured draw. Failed report writes
retain a bounded unacknowledged tail; overflow withholds recovery rather than
silently dropping evidence. Only successful report admission permits tail cleanup.

## Removing a qualified workaround

There are no feature switches or inferred firmware cutoffs. Qualify the candidate
firmware using native evidence and repeated real scheduler/Charge now starts,
pauses, current changes and long holds. Record the firmware and distinguish
absence of an observed failure from proof of its cause.

Remove the selected policy and its explicit controller hooks in one reviewed
change, together with policy-only state validation, tests and the owning execution
contract and policy summary.
For startup recovery, the hooks are native event observation, acknowledged Start,
recovery evaluation and the durable retry debit immediately before publication.
For permission reconciliation, replace its preview and acknowledged-Start policy
with the supported firmware's conservative native permission interpretation.
Do not restore the earlier interpretation that assigns SYS to an external actor.
No historical interpreter, schema migration or renamed-field alias is introduced.

Keep native provenance/events, unknown-outcome fences, interruption of continuous
pause proof, physical-zero checks, original identification bounds and all pending
command/restoration duties. Removing a workaround cannot erase an outstanding
physical duty or grant authority from saved state. Keep already recorded generic
report events and their labels so resolved incidents retain their meaning.

For reboot-state reconciliation, remove only the qualified backward-clock
exception and its policy-specific hooks/state. Preserve ordinary device reboot
detection, fresh discovery, approved intent/session recovery, epoch fences,
counter coverage gaps and outstanding commands/restoration. Already recorded
reboot evidence and labels remain readable without the workaround. Firmware
qualification must include actual reboots and unchanged/different startup states;
no firmware label alone proves the timestamp defect corrected.

Validate normal starts and earlier-Stop takeover, genuine later Stops, faults,
insufficient current, unknown ACKs, reconnect/restart/handover, report replay and
the remaining policy in isolation. Historical incident rows require no recovery
module to display. Deploy the reviewed change through the normal backed-up
paired rollout.
