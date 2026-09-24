# Ground-floor valve preheating

The floor override controls two dedicated Shelly Pro 2 v0 devices, each with outputs 0 and 1. Their logical names are **Storage** and **Living**. Initially, all four outputs form one pooled treatment: all must confirm ON before the controller records successful activation. These are override contacts: **OFF must release control to the original thermostats**, leaving ordinary heating electrically possible. Relay ON/OFF feedback does not prove valve travel, water flow or delivered heat. The other ground-floor loops remain at their existing fixed valve settings.

The adapter and device script are implemented and exercised in an API harness. They have **not been installed or verified on household equipment**. Keep the feature disabled until the wiring, firmware and failure tests below pass. The separate heat-pump ROOM setting retains its own host-side restoration; local Shelly expiry releases only the valve overrides. It cannot restore ROOM across a host or H66 communication failure.

## Thermal model and control settings

Preheating requests the captured normal ROOM setting plus
`controller.preheat_room_boost_c` (default **5 °C**), capped at the device's supported
maximum. Renewals maintain that request without adding another increment. This is
a heat-pump demand setting; occupied room temperatures remain bounded by the learned
reference and `max_drop_c` / `max_rise_c` (both default **1.5 °C**).

A positive `controller.floor_thermal_priors.capacity_kwh_per_c` enables one separate
selected-slab state. Configure it in the installation's private configuration,
then choose **Apply configuration**. The following keys express fixed assumptions:

| Key | Meaning |
| --- | --- |
| `capacity_kwh_per_c` | Selected concrete heat capacity, kWh/K; geometry and material assumptions establish a prior, not usable tariff storage. |
| `native_capacity_kwh_per_c` | Remaining building reserve, kWh/K; when omitted, the selected capacity is subtracted from the seeded total reserve. |
| `exchange_kw_per_c` | Effective slab-to-room conductance, kW/K; a provisional release assumption until measured. |
| `ground_loss_kw_per_c` | Effective slab-to-ground conductance, kW/K; positive insulated floors still lose heat. |
| `ground_c` | Assumed slow ground temperature, °C, independent of outdoor air and heat-pump brine. |
| `open_allocation_fraction` | Fraction of space-heating input allocated to the selected slab with confirmed override. |
| `closed_allocation_fraction` | Fraction allocated with native thermostat authority; OFF does not imply no heat. |

Document the basis for each installation value privately. Floor area and thickness
can support a material-capacity estimate; they do not measure hydraulic allocation,
release time, ground temperature or charging efficiency. The permanently open loops
remain in the native building reserve. The model conserves supplied heat across both
paths. With an explicit slab, the fitted envelope coefficient describes above-ground loss; slab-to-ground exchange is a separate passive path. The current model starts with fresh priors rather than converting old total-loss fits.
DHW-routed compressor heat is excluded from space heating as a deliberate simplifying
assumption.

Thermal configuration and relay permission are independent. Keep
`floor_preheat.enabled` and `floor_preheat.commissioned` false until the physical
checks below pass. Configuring the slab does not activate any output or establish
usable storage from room temperature alone.

Normal DHWR scheduling continues during preheat. During tariff reduction it is
suppressed and DHW demand settings are reduced. Space heating resumes immediately
when reduction ends, followed by a bounded recovery hold
(`controller.recovery_hold_minutes`, default **60 minutes**) with those hot-water
restrictions retained. AUX shares that deadline when
`controller.recovery_compressor_only` is enabled, with independent early release
for room comfort. At expiry, native DHW settings and circulation eligibility return;
a circulation pulse is not forced. To restore normal hot-water settings earlier,
pause price control; this selects Normal heating and restores the captured native
settings. A timed circulation run can then be started if needed. The deadline is not extended by ongoing estimated
thermal recovery.

## Renewal and failback

The controller renews an active lease every **5 minutes**. Each renewal expires locally after **15 minutes**, or at the planned preheat end, whichever comes first. Five-minute renewals do not cycle the relay: they reaffirm ON and its deadline. This allows missed renewals while bounding unwanted extra heating more tightly than a 50-minute timeout. Changing these defaults requires validating the installed firmware again; software accepts no local lease above 15 minutes.

Each device runs [the local script](../scripts/shelly/floor-lease.js), with three complementary protections:

- A one-second local watchdog ends a lease at its absolute deadline or monotonic uptime deadline, and releases on lost/stepped clock, unexpected relay state or unsafe relay configuration.
- Every ON also carries a native `Switch.Set` `toggle_after` timer, with a configured native auto-off backup. The native timer remains a fallback if the script stops. Power-on state is OFF.
- A persistent boot generation, monotonically increasing command sequence, owner identity and fresh issuance timestamp reject old ON commands. Duplicate ON delivery never extends a lease. An expired/released owner cannot restart in the same script session. A new episode needs a new owner identity.

The device rejects ON if its UTC clock is absent or differs from the host timestamp by more than the protocol allowance (5 seconds into the future or 30 seconds old). UTC clock steps exceeding 5 seconds relative to uptime release an existing lease. NTP and the host clock must be reliable. A release is accepted even without a valid clock.

The host persists the release obligation before publishing any ON. Its obligation includes a SHA-256 scope digest of the broker address and username; neither raw account details nor passwords are stored in this scope marker. It uses fresh request-correlated device readback for both outputs on both devices, rejecting retained, duplicated, stale and unrelated statuses. It polls every 30 seconds when ticked; feedback expires after 90 seconds. Call the adapter's `tick` at least once per minute. Tick performs polling and release retries, **not autonomous preheat renewal**: the currently admitted preheat decision must keep calling `lease`.

Cancellation, manual owner replacement, failed/partial activation, lost readback, restart and expired permission release all owned channels. Lost OFF acknowledgement keeps the durable obligation pending and blocks a replacement treatment until release is confirmed. Broker reconnection performs release before resuming control. An interrupted attempt is not evidence of an all-open treatment. On an unreachable device, the local deadline remains the independent release mechanism.

## Private configuration and MQTT

Device identities belong only in the private configuration file. This invented example shows the `controller.floor_preheat` shape:

```json
{
  "controller": {
    "floor_preheat": {
      "enabled": false,
      "commissioned": false,
      "renew_seconds": 300,
      "lease_seconds": 900,
      "storage": { "topic_prefix": "invented-floor-storage" },
      "living": { "topic_prefix": "invented-floor-living" }
    }
  }
}
```

Do not copy the invented prefixes as real device identities. Each actual prefix must match that device's MQTT configuration. Each group maps exactly to switch components 0 and 1. Do not map either device to another equipment role or another command writer.

| Topic relative to each private prefix | Direction | Content |
| --- | --- | --- |
| `/stmq/floor/command` | Host → device | JSON `probe`, `lease` or `release`, protocol `stmq-floor-v1` |
| `/stmq/floor/status` | Device → host | Request-correlated boot, clock, lease and per-channel relay readback |
| `/online` | Device → host | Native availability; OFF invalidates existing feedback |

Commands and script statuses use QoS 1 and are never retained. The script obtains its prefix from `Shelly.getComponentConfig('mqtt')`. Existing retained commands must be removed during commissioning. Restrict broker write permissions to the intended host and device; this replay protocol is not an authentication mechanism. Disable alternate schedules, webhooks, cloud automations and direct relay ON writers on these dedicated outputs. A direct native ON bypasses the lease admission protocol; the running watchdog releases an unowned ON, but a stopped script cannot intercept such commands.

## Changing the broker or account

Release and verify all four outputs before changing the MQTT broker address or username. If a release obligation survives a restart with a different broker/account, the adapter sends no floor commands through the new route and blocks new leases. It keeps the original obligation pending. Reconnect using the original broker address and username, verify the acknowledged OFF release, and then apply the migration. A password-only rotation does not change the scope marker. Local expiry still releases the original devices if the original broker is unreachable; that alone does not fabricate host readback or clear its obligation.

A release obligation without a broker scope also blocks activation: matching topic names do not establish which broker owns the outputs. Verify the original outputs are OFF before deliberately resetting an obligation whose route cannot be established.

## Commissioning

The dashboard keeps these instructions under **Home → Heating control → Floor
preheating setup**. Connection/MQTT entries describe device state and topics only.
This is not an ordinary Shelly ON/OFF integration: the local floor-lease script
must be installed and run at startup on both devices before commissioning can
succeed. The native 900-second auto-off is an independent backup to the script;
neither a working MQTT connection nor an ON readback establishes correct expiry.


1. Have the installed wiring checked: each of the four OFF states must restore the thermostat path independently of the host, broker and device power. Confirm device/output-to-actuator mapping, including any output driving more than one water loop. Check actuator power and travel delays. Leave the other fixed valve settings unchanged.
2. With control disabled and outputs disconnected from the override loads where needed for safe testing, identify the actual model/firmware. Verify that this Pro 2 v0 firmware supports scripting, KVS, MQTT script subscriptions and `Switch.Set` timers. The supplied code uses the documented Gen2 APIs; harness tests cannot certify firmware behavior.
3. Configure both switch components with `initial_state: "off"`, `in_mode: "detached"`, `auto_on: false`, `auto_off: true`, `auto_off_delay: 900`. Confirm readback of those settings and absence of other relay control paths. The script checks these settings and refuses a lease if they are unsafe; it does not silently rewrite them.
4. Initialize the KVS key **`stmq_floor_boot_v1` to numeric `0` once**, before commissioning. Upload the script and enable startup execution. Check that every script/device restart increments this persistent value and begins OFF. Never reset or restore this key on a commissioned device: reinitialization requires clearing old commands and recommissioning. KVS failure must prevent activation.
5. Verify both clocks, MQTT topics, ON readback, OFF readback and renewal of a still-ON native timer. The script uses absolute deadlines and supplies a remaining `toggle_after`; verify this behavior on the installed firmware. Confirm expiry at a deliberately short plan end as well as the 15-minute ceiling.
6. Test host termination, broker/network loss, script stop, power cycle, missing/stepped UTC clock, stale/retained commands, delayed duplicate ON, failed renewal, one failed output and lost OFF acknowledgement. Observe actual override release and native thermostat operation; electrical status alone is insufficient. Test native auto-off after script failure separately.
7. Record the commissioning outcome and hydraulic configuration epoch privately. Then set `commissioned: true` and `enabled: true` for a supervised short treatment, checking supply/floor limits, occupied-room temperatures, hydraulic redistribution, valve delays and the complete recovery. Equipment-response evidence must cover the selected valve configuration throughout charging, reduction and recovery.

The initial software treatment is pooled. Separate Storage/Living experimentation, direct valve-position/flow sensing and automatic tuning of a separate slab parameter need their own evidence; they are not established by successful MQTT commands.

## Integration API and tests

`createFloorOverride` in [floor-override.js](../src/control/floor-override.js) accepts durable `getState`/`setState`, a publish callback, normalized settings, a clock, an authority callback and a broker identity. The acquisition layer supplies the broker address and username for the private scope digest. Its methods are `setConnected`, `ingest`, `status`, `lease`, `release`, `tick` and `close`; `topics` includes subscriptions needed for both current mappings and outstanding older mappings. `lease({owner, until})` uses a stable unique episode owner and an absolute millisecond deadline. It resolves with `confirmed: true` only after all four outputs confirm. Disabled/uncommissioned activation throws `FLOOR_DISABLED`; a normal release with no obligation is a no-op. `close({restore: false})` stops without device writes and preserves outstanding obligations for the successor; normal close requests release before disconnecting.

Run `node --test test/floor-override.test.js test/floor-integration.test.js`. The tests execute the uploadable script against mocked official API shapes and independent native timers, alongside the host adapter. They establish software behavior, not equipment commissioning.

References: Shelly's [MQTT scripting API](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/MQTT/), [Switch configuration and timers](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/), [KVS storage](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/KVS/) and [system time/status](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Sys/).
