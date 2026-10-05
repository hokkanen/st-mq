# Control execution and recovery

[Charging overview](../charging.md) · [Code map](architecture.md)

This contract owns session authority, native instruction precedence, interruption and restart. Backend-specific command protocols live in the [Easee](integrations/easee.md) and [Shelly](integrations/shelly.md) integration guides. Temporary identification obligations are specified in the [identification contract](identification.md).

## Session requests and readiness

A session edit requires the current physical association, session ID and request
revision. A stale browser or cable swap cannot apply it to a replacement
connection. Restart retains only the same valid scope. Configured defaults,
explicit session edits and observed vehicle fields remain separate.

Vehicle-feed loss does not suspend ordinary scheduling from valid session/default
inputs; proposed periods remain visible. Active identification actions retain
their own progress and recovery status. An OCPP connection awaiting a transaction
can also show proposed periods alongside pending approval, without claiming a
profile was accepted. Plug-and-charge approval requires the price plan or a
permitted charging action to call for charging.

## Automatic takeover and native instructions

**Charge now** releases the controller's automatic scheduling delay for the
current connection without changing the Automatic preference. It works with
Automatic off. Turning Charge now off returns to Automatic and enables it if
needed; unplugging ends the override. The request remains subject to native
restrictions and confirmed control readiness.

The Automatic switch saves the scheduling preference. It stays **ON** while
manual control has priority. With Automatic enabled, a new confirmed physical
connection takes automatic control and supersedes earlier charger instructions
and native charging schedules, including recurring schedules. A genuinely missing
saved session follows that policy after fresh connection evidence; unreadable or
invalid saved state cannot authorize takeover. Restart and network reconnection
preserve a known session's automatic or manual ownership. A later external change
has priority for that connection; unplugging ends that manual scope. Changing the
Automatic preference alone does not take over an already established session.

**Use automatic** is a separate, explicit new
instruction: enable Automatic, end Charge now, supersede the observed manual
Start/Stop and disable supported native charging schedules. Those earlier
instructions are not restored after the session, unplugging or restart; a new
external instruction takes priority again. Returning to the price plan may keep
charging paused until a cheaper period. The action is available only for the current connection and control authority.
Pending, blocked and unconfirmed outcomes remain distinct; success requires
charger readback.

For local OCPP, a handover that needs an economic wait must first install and
confirm its zero-current pause before clearing the existing native stop. A failed
step keeps the handover blocked. Its message identifies the failed operation and
distinguishes a timeout, cancelled command and protocol failure. Session reports
retain the supported error code and operation for later diagnosis; older generic
failures cannot establish which of those causes occurred.

Automatic and explicit handover are bound to the current equipment, connection, request/control
revisions and observed native instruction. A newer observed instruction fences
it. Charger APIs do not supply an atomic cross-client lock: a concurrent external
edit must still be detected through source clocks, schedule revisions and
readback. Observed stop/enable changes do not prove which app or person caused
them. Shelly's native command-source evidence distinguishes same-value `sys`
refreshes from newer external instructions. A system refresh preserves existing
ownership only when no intervening permission change was observed; a Stop followed
by Enable cannot disappear because one poll sees the same final value.
The owner-approved [system permission exception](#shelly-system-permission-changes)
classifies fresh `sys` changes separately while preserving the observed edges,
physical permission and their provenance. Other observed external instructions
retain priority. Detecting a repeated
selection of the same value requires newer native instruction evidence. If a
repeated Shelly Stop leaves the value `false`, source `rpc` and update timestamp
unchanged, the status API cannot distinguish that command from the existing
automatic pause. Polling freshness cannot supply the missing instruction. This
is an unresolved detection limitation; genuinely observed native Stop still
prevents automatic resumption. Missing provenance is not attributed to the application.
Vehicle timers and targets, faults, electrical limits and authorization
remain authoritative. Unsupported native schedule shapes stay visible as blocked
rather than being silently removed. See the [Easee takeover constraints](integrations/easee.md#ownership-and-manual-controls)
and [Shelly command contract](integrations/shelly.md#mqtt-and-commands).

## Shelly system permission changes

The Top AC Portable profile has produced `sys` false-to-true start-permission
sequences after confirmed application Starts, including ordinary charging long
after connection with native Auto charge disabled. On 2026-10-04 the owner
explicitly broadened the earlier first-start exception: fresh supported `sys`
permission changes are device transitions at any connection age and current,
including repeated cycles and changes outside identification. There is no plug,
first-Start or ten-second eligibility window.

Classification and physical permission remain separate. A genuine device Stop
blocks replacement Start while permission is false or unknown, including with
**Charge now**. Fresh true permission can clear only that device hold; it does
not supply automatic authority, clear a separate native Stop, or itself request
another Start. A false-only hold has no retry timer. Restart preserves the
restriction until fresh device evidence resolves it; a restored record cannot
manufacture a new physical connection, observation or control permission.
An initially observed false setting on a new connection, with no intervening
device Stop, is not such a hold. Normal connection authority can still start a
charger whose native Auto charge is disabled.

A same-value `sys` refresh of an uninterrupted, application-owned Stop preserves
that pause and its original resume deadline. A true edge interrupts its physical
confirmation, even if a later false edge arrives in the same batch before polling.
That sequence cannot furnish continuous application-owned stop evidence or a new
BMW identification witness. Valid earlier historical evidence stays unchanged.
Effective command source follows the native partial-notification contract; omitted
unchanged attributes do not create new provenance. Retained, stale, unknown or
invalidated readings cannot release a hold or supply new control evidence.
Events admitted and saved while fresh retain their historical meaning after an
outage: a recorded interruption still invalidates the earlier continuous pause,
and a held Stop still needs a fresh correlated query before release.

Identification may continue through a device permission cycle only within its
existing attempt, current-test/probe deadlines and energy allowance. The cycle
does not renew a deadline, create another attempt or authorize an extra Start.
Original expiry and current-restoration obligations still apply. Fresh physical
zero remains necessary before raising current while stopped.

Other native instructions, current reductions, schedules, faults, authorization,
vehicle restrictions and electrical limits retain their existing authority.
Unknown command outcomes remain fenced; a system event cannot retroactively
acknowledge an uncertain application write. Queue and persistence failures retain
their conservative command gates.

The exposed source is not a reliable actor identity. An independent native action
reported as `sys` can receive the same classification; the owner accepted this
ambiguity when widening the exception. No firmware cause or firmware fix is
claimed. The separate limitation detecting a repeated native Stop while permission
is already false remains as described above.

## Confirmed charging and pauses

An open charging period can show **Charging is allowed** while the connected
vehicle draws no power. A later planned period does not mean the current one
has paused. **Paused between periods** requires the controller to confirm the
pause; a pending transition is shown as unconfirmed, with the next planned
period kept separate from that confirmation. **Reported allowance** is the
Equalizer's current allowance, not actual draw or proof that a scheduling pause
has taken effect. Vehicle timers, limits and other native restrictions still
apply during an open period.

Both native expiring pauses and application-managed pauses use the same confirmed
pause wording. An application-managed pause needs current session ownership,
confirmed disabled start permission and fresh physical noncharging evidence.
Its next charging period still requires the application to resume the charger.
An ordinary OCPP pause installed while already suspended can use fresh zero power
measured during that suspension together with the current confirmed zero-current
profile. Replanning does not require the stopped charger to report another stop
transition. A command dispatched while charging and every identification pause
still require power evidence after the command; an existing stop cannot establish
a causal vehicle response.

## Missing feeds and controller outages

Charging does not require vehicle identification: editable current charge,
target, usable capacity and ready-by remain available. Within the same identified
physical connection, feed loss preserves the last charge anchor plus recorded
energy, labeled as last known vehicle charge. An explicit **Current charge** edit
replaces it. A new or ambiguous connection cannot borrow that estimate.

The BMW publisher sends a live report every five minutes. Ten minutes without
a valid live report withdraws its automatic values even if the broker remains
connected; source measurement clocks do not advance with these reports. Retained
replay alone does not restore live-feed availability. TeslaMate uses its separate
live logger-health reports. Physical charger metering remains independent.

After a master-host failure, the promoted computer needs its own working broker,
device connections and credentials; see [paired operation](../pairing.md). Cached
data is not fresh device evidence. Reachable chargers can continue with manual
inputs. Missing shared prices or usable property-capacity forecasts select
provisional release only when no existing adopted instruction needs preserving.
For the same confirmed physical connection, an adopted schedule retains its
original pauses and release times while these inputs recover, including after
restart. Missing evidence does not authorize an early start or renew a pause.
A modeled deadline shortfall remains a separate release decision; an unknown charger current alone uses the
[planning assumption](planning.md#maximum-available-current-assumption).
An unreachable charger cannot receive a release, and an unavailable OCPP
authorization server can block new charging. Shelly EVSE controller-loss behavior
remains unverified; software cannot promise an autonomous hardware fallback.

The ready-by time becomes one concrete occurrence when the physical connection starts. Midnight, identification, progress updates, priority changes and restart do not roll it forward. A deliberate session ready-by edit may change it. Late identification replaces default-derived vehicle inputs without splitting the physical session or resetting its costs.

## Restart and compatibility

Current-format sessions, requests, assignments, costs and uncertain commands recover only within the same physical/source association. Device, MQTT broker/root, integration profile/service or phase association changes cannot borrow old ownership. A potentially dispatched command is reconciled with native readback before another intention; it is never blindly replayed.

Shelly command confirmation requires its acknowledged setting and fresh native
readback within the same adapter generation and physical connection. An unrelated
connected work-state update does not erase that confirmation. Pending observations
still withhold readiness for further commands, and physical charging or stopping
requires its own fresh measurement.

Pre-1.0 native state is not migrated. The current charging state remains version 6
and database schema 20; the physical adapter uses its own explicitly scoped
current state. New optional control choices default to OFF/Balanced when absent;
recorded presentation never supplies control permission. Retired configuration switches for automatic charging and
priority, dashboard overrides of permanent battery defaults, old pseudo-C2
settings, charger-bound vehicle topics, efficiency overrides, unscoped verdicts
and aliases are rejected. Incompatible development databases, including those
with the earlier Shelly power-unit interpretation, are rejected before mutation
and require an intentional fresh start; no conversion or repair is attempted.
Only the v0.7.5 `easee.csv` and
`st-mq.csv` import paths are supported historical boundaries. Imported
C1/property history retains its provenance and does not become a Shelly observation.
