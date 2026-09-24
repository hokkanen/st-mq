# Charging and heating connection-loss review

Reviewed charging schedules, vehicle identification, unavailable publishers and
manual paired takeover against `30ace8d`. Validation uses synthetic fixtures and
isolated local services. Existing local state was inspected read-only to diagnose
identification; no household identifiers, exports or private settings are included
here. No household device was commanded or service restarted.

| Finding | Resolution and evidence |
| --- | --- |
| Tesla charging reports can arrive after the narrow EVSE power-ramp window; unchanged power then prevents identification retries. | Corroborate a live Tesla charging edge with the physical EVSE edge within 30 seconds, matching power and fresh physical evidence. The delayed match is bounded to 15 minutes. Retained edges, old connections, conflicting power, unknown home state and unhealthy feeds cannot establish identity. `charger-identification.test.js`. |
| TeslaMate publishes settings only when they change. Expiring them by receipt age discards a still-active timer/current limit. | Admit unchanged settings while live logger health is available, preserving original provenance and clocks; require a new live health pulse after MQTT reconnect. Actual EVSE charging supersedes a future next-start report. `charging-telemetry.test.js`. |
| A vehicle timer beyond the available price horizon can produce no planner candidate and throw. | Provisional open release with unavailable-price explanation; no fabricated free intervals or readiness promise. `charging-planner-audit.test.js`. |
| One vehicle timer after ready-by disables scheduling for both chargers. | Release ST-MQ's economic hold for that car, disclose its shortfall and continue planning its peer. Forecast its native start after clearing the old charger hold, and retain its competing load. `charging-planner-audit.test.js`. |
| A timer on an uncontrolled peer is absent from its load forecast. | Include the native start; charger release alone cannot imply charging before the car permits it. Observed charging retains precedence. `charging-planner-audit.test.js`. |
| Changing a vehicle timer during an economic pause can leave the remaining plan unchanged. | Include effective vehicle/native start, current and ceiling restrictions in the planning input fingerprint. Revise remaining periods without waiting for new prices or energy, preserving completed execution. `charging-runtime.test.js`. |
| Vehicle-feed loss replaces an observed SoC anchor with an unrelated saved manual default. | Preserve the same identified physical connection's anchor plus recorded energy. Label last-known vehicle charge, permit explicit manual replacement, and revoke on a new/ambiguous connection. `charging-progress.test.js`, `charging-vehicle.test.js`, `charging-ui.test.js`. |
| BMW HA publisher can stop while the broker stays online. | Ten minutes without a valid live publisher report withdraws automatic fields and displays stale status. Retained/DUP replay cannot restore live availability; unchanged valid heartbeat does not alter BMW source clocks. `charging-vehicle.test.js`, `equipment-connections.test.js`. |
| A forecast exception can prevent independent charger reconciliation. | Continue readback, ownership cleanup, manual detection and confirmed releases. An unavailable new plan does not invent a schedule. Easee reconciliation does not evaluate unrelated Charger 2 allocation inputs. `charging-runtime.test.js`. |
| Replacement garage host can remain restoring after the old Pill lease expires. | Preserve the observed foreign lease's expiry without adopting its OFF intent. Fresh confirmed ON can settle restoration; foreign owner and stale/retained state still fence takeover. `garage-pill.test.js`. |
| Garage outage documentation contradicts current door admission. | Document and test that unknown door state prevents new savings pauses, while current pauses remain subject to independent protection. Missing protection probes revoke OFF permission. `garage-runtime-adapter.test.js`. |

## Retained boundaries and operating limits

- The one current charging state and current-version restart/replication remain.
  Remove the unreachable pre-version-4 manual-control branch and version rewrite;
  do not introduce migrations, alternate decoders or old permissions.
- TeslaMate exposes a next scheduled start, not a complete recurring/end-time
  schedule. BMW profile/window availability depends on vehicle capabilities; the
  current bridge supplies no schedule times. No speculative BMW profile mapping,
  vehicle commands or automatic schedule disabling was added.
- A promoted master needs locally provisioned credentials, broker and reachable
  devices. VIP movement cannot restart HA/TeslaMate on a failed computer. It also
  cannot turn a stale replica into fresh physical observations.
- Pill's commissioned local OFF bound and external-temperature expiry remain
  essential. H66 has no documented local expiry; restoration needs a reachable
  gateway and the persisted obligation. ON is not proof of useful heat.
- Native Easee OCPP needs a live authorization server for new sessions. Shelly
  EVSE controller-loss behavior remains unverified. No software change can promise
  recovery of an unreachable actuator or completion against an unknown car timer.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 2,911 passed; zero failures, skips or cancellations. |
| `npm run test:extended` | 9 passed; zero failures, skips or cancellations, including isolated MQTT and SSH/SQLite replication. |
| `npm run build -- --configLoader native` | Passed; existing Vite large-chunk advisory remains. |
| `git diff --check` | Passed. |

Runs used Node 26.8.2. Focused regressions also cover planner peer reservation,
delayed Tesla identification, source-health recovery, saved same-session progress
and garage lease expiry after handover. The ordinary pre-commit hook checks the
final staged index for secrets before the commit.

Sandboxed broad runs could not run nested localhost services normally and were
stopped or failed at the file wrapper. Full validation runs outside that sandbox
with synthetic MQTT/HTTP/SSH services; this does not establish household hardware
commissioning or deployment.
