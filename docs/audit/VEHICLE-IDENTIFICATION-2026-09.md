# Vehicle identification audit

Scope: BMW CarData and TeslaMate association with the current physical charger
connection, including Easee cloud schedules and local OCPP pauses. All validation
uses synthetic vehicle feeds, charger transports and storage. No household
configuration, device commands or database reset is part of this change.

## Findings and corrections

| Finding | Correction |
| --- | --- |
| BMW's unchanged inlet fallback explicitly excluded OCPP and depended on cloud reason 54. | Normalize a verified pause at the charger boundary, then use one vehicle matcher for both transports. |
| The controlled-pause pending helper was unused. | Both BMW evidence paths use the same bounded pending display. |
| Economic scheduling could suppress the initial charging transitions needed for identification. | Observe an unrestricted new connection for at most three minutes when a plausible at-home vehicle is available; send no identification commands. |
| Unknown physical charging was stored as a stop. | Admit only available boolean physical charging observations. |
| OCPP's installation intent did not prove a charging observation immediately before dispatch. | Keep installation intent separate from an optional guarded charging witness; require the latter for identification. |
| The Tesla fresh-plug path could use old or missing physical power clocks. | Every Tesla path requires positive vehicle power and current-session physical power no older than one minute. |
| Identical Tesla publications could renew receipt times and promote retained data into new evidence. | Preserve change-only identity clocks and provenance, including same-value recovery after an unknown gap. Health pulses remain independent. |
| Matches were bound to chargers but not consistently to vehicle sources. | Bind assignments and conflicts to vehicle-feed identity as well as physical session. Keep startup state inert until the configured source is available. |
| Another identification path or charging point could reuse an earlier vehicle episode. | Consume both BMW plug/start events and source-bound Tesla power evidence; fence evidence after vehicle departures even if polling misses the unplug. |

## One decision path

`identity-evidence.js` is the protocol boundary. Cloud proof checks the exact
owned delayed schedule, enabled charger and matching scheduling-stop/mode clocks.
OCPP proof checks the owned profile, current transaction, EVSE suspension and fresh
zero power. Both produce the same connection/request/confirmation/release/stop
clocks. Neither an acknowledgement nor a cached ownership record proves a stop.

`vehicle.js` correlates vehicle evidence without knowing the charger protocol.
BMW's live plug plus paired charge/stop path remains available independently of
economic control. Its unchanged-inlet path requires the verified owned pause and
independent start/stop pairs within thirty seconds. Tesla uses live plug/ramp or
charging-start evidence with matching positive physical power.

`runtime.js` evaluates both chargers together, applies conflict handling and
source/session binding, and consumes evidence only after an unambiguous match.
Existing matches survive pauses and a restart of the same supported session;
new connections do not inherit them. Feed unavailability withdraws automatic
battery fields rather than guessing a different vehicle.

## Regression coverage

- The same successful and rejected BMW/Tesla scenarios run through real cloud
  and OCPP telemetry normalizers.
- Real controller simulations cover the initial observation, ordinary economic
  pause, independent delayed BMW stop, early Tesla match, timeout, restart and
  reconnect, with recorded synthetic command counts.
- Negative cases cover retained starts/power, duplicate and unchanged delivery,
  unknown gaps, stale/future clocks, missing stops, manual/foreign restrictions,
  failed confirmation, wrong transactions and a stop before queued dispatch.
- Session tests cover rapid unplug/replug, cable swaps between charging points,
  consumed evidence across restart, Tesla car/broker/namespace/home-zone changes,
  adapter/feed startup order and competing vehicles or charging points.
- Existing source validation, target filtering, controller ownership, native
  transport, charging progress and UI tests remain applicable.

Validation on Node 22.19.0: all 3,355 offline tests pass (`npm test`), and the
production build passes (`npm run build`). The fresh worktree needed its frontend
build before the full suite's dashboard availability assertion could pass.
Independent code reviews covered source provenance, transport parity and the
OCPP pre-dispatch witness and queue guards. No live charger operation was used.

## Preserved contracts and limits

No old payload/configuration translators or development-data migrations are
introduced. The redundant BMW `event` alias and confirmation-time substitute for
a guarded pause request are removed. New optional evidence is absent by default;
absence cannot create identity authority. Current persisted native restrictions
remain available for cleanup and supported restart recovery.

Identity needs observable independent evidence. A full battery, vehicle timer,
missed complete charge cycle, retained-only start, expired home context or
conflicting observations can correctly leave a vehicle unidentified. Waiting
longer or republishing identical values must not turn uncertainty into identity.
Manual inputs remain usable. The observation window neither enables a stopped
charger nor removes somebody else's restriction, and Charge now retains its
normal session and native-limit rules.
