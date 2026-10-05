# Charging

Charging has five distinct responsibilities: identify the connected vehicle,
choose economical charging periods, allocate available current, execute authorized
instructions, and record what physically happened. They share evidence but do
not imply one another: a planned period is not a confirmed charger command, and
a confirmed command is not measured charging.

## Start here

| I want to… | Read |
| --- | --- |
| Use the controls or understand a waiting charger | [User guide](charging/user-guide.md) |
| Understand the deliberate behavior choices | [Policies and ownership](charging/policies.md) |
| Find the code and understand subsystem boundaries | [Architecture and code map](charging/architecture.md) |
| Set up a charger or inspect firmware and readiness | [Easee](charging/integrations/easee.md) · [Shelly EVSE](charging/integrations/shelly.md) |
| Configure vehicle evidence | [BMW CarData](charging/integrations/bmw.md) · [TeslaMate](charging/integrations/teslamate.md) |
| Assess an ordinary charging session | [Session reports](charging/evidence-and-reporting.md#session-reports) · [Guided assessments](charging/guided-assessments.md) |
| Validate a change or record a selected physical experiment | [Testing and physical development tools](charging/testing.md) |

In the dashboard, charger cards own daily session controls, **Schedule & readings**
and session reports. **Data & settings → Connections & configuration → Charging**
owns device information, installation prerequisites, vehicle-feed setup,
documentation and guided assessments. Each charger card links to that setup area.

## Supported equipment and capability differences

There are two physical charger roles and three execution backends. Charger 1 uses
one Easee backend at a time. Charger 2 uses the supported Top AC Portable EVSE
profile on Shelly XT1; it is disabled by default and is not a generic relay adapter.
BMW and Tesla evidence can identify either vehicle on either charging point.

| Capability | Charger 1: Easee cloud | Charger 1: local OCPP | Charger 2: Shelly EVSE |
| --- | --- | --- | --- |
| Charging periods | Native delayed-start scheduling | Native expiring zero-current profiles | Application-managed start permission |
| Positive charging current | Native charger / vehicle / Equalizer | Native charger / vehicle / Equalizer | Property-load and shared-priority allocation, within configured and native limits |
| Pause release | Native schedule expiry | Native profile expiry | Requires an application command over working MQTT |
| Identification | Shared positive vehicle matching and bounded attempt | Same shared lifecycle | Same lifecycle; scoped 6 A comparison when capabilities permit |
| Physical electricity evidence | Easee measurements | Native readings preferred; cloud can back up acquisition | Native phase readings and lifetime energy counter |
| New-charge authorization during controller outage | Native cloud behavior | May wait for the local authorization server | Autonomous controller-loss behavior remains unverified |

OCPP pause expiry removes a restriction; it does not restore cloud authorization.
Ordinary application stop, restart and paired handover preserve installed OCPP
configuration. Read [Easee operation and outage limits](charging/integrations/easee.md#direct-local-ocpp-telemetry-firmware-344-or-later)
before relying on local control.

## Detailed contracts

| Responsibility | Authoritative detailed home |
| --- | --- |
| Positive vehicle evidence, attempts and identification restoration | [Identification](charging/identification.md) |
| Forecast energy, shared schedules and deadlines | [Planning](charging/planning.md) |
| Live current entitlement, headroom, fallback and settling | [Current allocation](charging/current-allocation.md) |
| Ownership, native instructions, command confirmation and recovery | [Execution and recovery](charging/execution-and-recovery.md) |
| Measured energy, estimated progress, cost and historical reports | [Evidence and reporting](charging/evidence-and-reporting.md) |

The [repository foundations](../AGENTS.md) govern these contracts. The
[configuration guide](configuration.md#charging-defaults-and-dashboard-overrides)
owns setting locations and installation defaults. Integration pages specify
protocol and hardware capabilities; a reported model or firmware version alone
does not establish that a capability has been qualified.
