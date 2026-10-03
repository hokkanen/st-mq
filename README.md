# ST-MQ

![Home Energy icon](icon.png)

ST-MQ is a local home-energy controller for Home Assistant OS and standalone
Linux. Its dashboard and Home Assistant app are named **Home Energy**; the
repository and installation slug are `st-mq`.

**0.9.5-dev.1 is the first public development prerelease after 0.7.5.** It is
intended for evaluation and installation-specific commissioning. Default startup
uses simulated devices with Home heating paused. Live input and each feature's
control permission are separate choices.

## Capabilities

- Home heating: adaptive thermal learning, electricity-price planning,
  preheat/reduction/recovery assessment, manual controls and durable restoration
  of owned heat-pump settings.
- Garage heating: persistent Normal/Away targets, native pump controls and
  independent device-local frost protection through the CN105 controller and
  protection sender. Garage has no learned heat model or economic scheduler.
- EV charging: coordinated Easee and Shelly EVSE schedules, per-connection
  controls, BMW/Tesla vehicle evidence and recorded session reports. Native
  device limits and later external charging instructions retain authority.
- History: SQLite recording, source/quality information, chart exploration,
  backups, exports and read-only import of the two supported 0.7.5 CSV formats.
- Integrations: MQTT equipment, H66, electricity prices, weather forecasts,
  room sensors and an optional Home Assistant dehumidifier bridge.
- Operation: standalone control, a read-only SSH mirror or a manually managed
  pair with explicit handover. Neither replicated topology automatically takes
  over equipment after a failure.

## Install

Add `https://github.com/hokkanen/st-mq` under **Settings → Apps → Install app →
⋮ → Repositories** in Home Assistant OS, then select **Home Energy**. The
repository's default branch, `main`, includes the integrated H66 development work
and publishes this development prerelease. Installations configured with `#H66`
need the default repository source for this release; a tag does not change their
configured source.
Follow [Home Assistant setup](DOCS.md) for installation, saved options, ingress,
backups and MQTT integration. Home Assistant Container has no app manager; use
standalone ST-MQ alongside it.

For standalone Linux, use Node.js **22.19 or newer**:

```sh
git clone --branch v0.9.5-dev.1 https://github.com/hokkanen/st-mq.git
cd st-mq
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:1234`. See [standalone startup](docs/startup.md) for
environment variables, systemd, UI development and port-conflict recovery.

Shared defaults live in `config.json.options`. Keep credentials, private device
identifiers and sparse installation overrides outside the checkout, normally in
`~/.config/st-mq/secrets.json`. In Home Assistant, saved app options are
authoritative. See the [configuration guide](docs/configuration.md) before
applying changes. Every accepted Home Assistant ingress session has application
admin access; restricted family access uses its separate direct-access password.

## Guides

| Topic | Documentation |
| --- | --- |
| Configuration, access and electricity rates | [Configuration](docs/configuration.md) |
| Home heating and manual controls | [Learning and control](docs/learning-and-control.md), [automation and restoration](docs/automation-and-manual-control.md), [planning explorer](docs/heating-plan-explorer.md) |
| Garage and local protection | [Garage heating](docs/garage.md), [adapter contract](docs/garage-adapter.md), [CN105 integration](docs/shelly-pill-handoff.md) |
| Charging | [Controls, identification and reports](docs/charging.md), [Easee](docs/charging-easee.md), [provider capabilities](docs/charging-provider-capabilities.md), [BMW](docs/bmw-cardata.md) |
| Charts, storage and exports | [Recording and chart exploration](docs/recording.md), [CSV import](docs/csv-import.md), [learning reconstruction](docs/reconstruction-and-versioning.md) |
| Devices and sensors | [MQTT equipment](docs/mqtt-equipment.md), [temperature sensors](docs/temperature-sensors.md), [H66](docs/h66-mqtt.md), [SmartThings](docs/smartthings-temperature-rule.md) |
| Home Assistant bridges | [MQTT setup](docs/homeassistant-mqtt.md), [Caravan dehumidifier](docs/caravan-dehumidifier.md) |
| Other heating inputs | [Firewood](docs/fireplace.md), [floor preheating](docs/floor-preheat.md) |
| Replication | [Read-only mirror](docs/replication.md), [manual pair](docs/pairing.md) |

## Operating limits

Measured device readback, command acknowledgement and physical heat delivery
are different evidence. Software fixtures do not commission an installation or
prove energy savings. Home learning retains explicit model uncertainty; see
[model design and limits](docs/learning-model-design.md).

The planned SONOFF floor controller has no supported firmware/control interface
yet, so floor activation and commissioning remain unavailable. H66 restoration
requires a reachable application and gateway; no device-local expiry is assumed.
Garage pipe estimates require installation-specific validation.

Ordinary stop, restart and pair handover preserve Easee OCPP configuration and
outstanding restrictions. New charging can wait for the controller's
authorization during an outage; pause expiry alone does not restore cloud
control. See [Easee control and qualification](docs/charging-easee.md).

Before 1.0.0 there is one current database/configuration contract. Incompatible
development databases are rejected before mutation and require a deliberate
fresh start; there is no automatic migration or reset. Same-version backup,
restore, restart and learning reconstruction remain supported. The two 0.7.5 CSV
imports are the historical exception; keep original exports outside the checkout.
Existing 0.7.5 installations need a fresh current configuration and database,
with any supported CSV history imported explicitly. Review
[Home Assistant installation changes](DOCS.md#moving-from-an-earlier-version) or
[standalone installation changes](docs/startup.md#moving-from-an-earlier-version)
before replacing a running controller.

## Deployment paths

The root `config.json`, `Dockerfile`, `DOCS.md`, `CHANGELOG.md`, `icon.png`,
`logo.png` and `translations/` serve Home Assistant packaging. `repository.yaml`
describes the app repository. These names and the `st-mq` slug are intentional.

The same Node core runs on standalone Linux and in the `amd64`/`aarch64` app
container. To build locally:

```sh
docker build -t st-mq:development .
```

Home Assistant builds from the configured repository branch. A GitHub prerelease
tag alone does not change that branch or update an installed app. See
[deployment validation](docs/development-validation.md) for container and
Supervisor checks and their installation limits.

## Development and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [repository foundations](AGENTS.md).
`npm run check` builds the dashboard and runs the offline tests. Extended, browser,
container and pinned Supervisor checks are documented in
[development validation](docs/development-validation.md). Live provider diagnostics
are [separately invoked](docs/live-testing.md).

Use [GitHub issues](https://github.com/hokkanen/st-mq/issues) for actionable bugs
and planned work, with private configuration and household data removed.
Release-facing changes belong in [CHANGELOG.md](CHANGELOG.md); implementation
history is kept in Git. Report vulnerabilities through the private contact route
in [SECURITY.md](SECURITY.md).

ST-MQ is licensed under the [MIT license](LICENSE). Third-party integration and
test fixture sources retain their accompanying licenses. The maintained icon
source and export instructions are in [branding assets](assets/branding/README.md).
