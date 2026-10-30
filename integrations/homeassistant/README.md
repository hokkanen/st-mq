# Home Assistant companion integrations

These files provide Home Assistant automations and component configuration for
MQTT-connected household systems.

| Integration | Setup |
| --- | --- |
| Meross MSG200 and SmartThings | [Installation and operation](meross-msg200.md) |
| BMW CarData MQTT feed | [Vehicle feed configuration](../../docs/charging/integrations/bmw.md) |
| Caravan dehumidifier | [Device configuration](../../docs/caravan-dehumidifier.md) |
| Tuya observation adapter | [Installation and updates](tuya-local-observation.md) |

## Installing automations

Generated automations are ordinary Home Assistant automation objects. Each needs
a unique ID and privately maintained source entity mappings. The MQTT integration
is connected to the broker used by the relevant publishers and consumers.

In **Settings → Automations & scenes**, create an automation, open **Edit in YAML**,
and paste one complete automation object. JSON objects are valid YAML. An array
of several objects is not one automation. Save and inspect the automation trace.
Alternatively, merge individual entries into the existing `automations.yaml` list
and reload automations, preserving unrelated entries.

The feed generators retain original source report timestamps. A requested snapshot
reads the available source cache; it does not establish a new physical measurement.
Generated mappings and backups remain outside Git, in private directories with
mode `0700` and files with mode `0600`.
