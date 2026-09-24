# A01–A11 and B12 implementation record

This change addresses the package `stmq-audits-A01-A11-B12.zip` against repository
baseline `f017684f708d0016978f27c40b291e7f2e222a59`. The package checksums were
verified before implementation. Archive SHA256:
`b10155330985109c6afbf66c26541b7fc7a533778ea644688929f548bd39a0f6`. Findings are judged against current correctness
and the owner's pre-v1.0.0 compatibility policy, rather than copied literally.

See [final validation](VALIDATION.md) for executed suites, browser and container
checks, runtime versions, reproduction commands and remaining operating limits.

The subsequent [September owner review](OWNER-REVIEW-2026-09.md) records the
dashboard, acquisition, recording and control refinements against this audited
baseline, including validation and installation requirements.

The later [automatic OCPP setup and native-control record](OCPP-SETUP.md)
supersedes the earlier Easee coexistence assumption and documents its bounded
live evidence, exclusive control handover and remaining installation limits.

| Scope | Implementation and evidence |
| --- | --- |
| A01 charging | [Physical Charger 2, identity, energy, scheduling and controls](A01.md); [acceptance tracker](A01-tracker.json) |
| A02–A03 Home | [Thermal learning, planning and execution](A02-A03.md) |
| A04–A05 Garage and sources | [Frost protection, learning, source clocks and providers](A04-A05.md) |
| A06 equipment; A10 transport | [Native equipment and publication fencing](A06-A10-transport.md) |
| A07/A09 prices and history | [Accounting authority, chart data and browser liveness](A07-A09.md) |
| A08/A10/A11 | [Storage, pairing, recovery, lifecycle and deployment](A08-A10-A11.md) |
| A11 Supervisor boundary | [Actual upstream validation and remaining installation limits](A11-supervisor.md) |
| B12 compatibility | [Every removal and retained current capability](B12.md) |

The new Charger 2 is a real MQTT EVSE endpoint; vehicle telemetry is independent.
It remains disabled/uncommissioned by default until the arriving hardware's
exact identity, firmware, components, permissions and state/limit/readback
semantics are verified. Synthetic tests do not establish physical commissioning.
Garage automatic OFF likewise requires installation release-ordering evidence.

The implementation preserves only the two supported v0.7.5 CSV import formats.
An incompatible development database or configuration is rejected; existing
files are not automatically rewritten, relocated or erased. Native restart,
recovery and backup operate on the one current contract.

Validation uses invented data, temporary databases and isolated services. No
household credentials, exports, broker, actuator or installed configuration were
used. Feature ledgers distinguish executed regressions from hardware/platform
limits. A measured five-second SQLite lock wait remains an explicit operating
limit, with event-loop delay visible in status. The bounded charging planner also
remains synchronous; synthetic 24-hour plans took about 0.47–1.24 seconds on the
validation machine. Neither measurement establishes a safe device deadline or a
hard real-time promise.
