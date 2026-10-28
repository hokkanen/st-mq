# Tuya Local source contract fixture

These are unmodified public **Tuya Local 2026.10.0** `device.py` and `entity.py`
sources, retained for offline adapter validation. They contain no installation
configuration or household telemetry. The upstream MIT license is preserved in
`LICENSE.md`.

Upstream: <https://github.com/make-all/tuya-local/tree/2026.10.0/custom_components/tuya_local>

Exact original and patched hashes are in
`integrations/homeassistant/tuya-local-observation.json`. Tests execute selected
patched upstream methods with synthetic transports and TinyTuya 1.20.0 producers.
They do not start Home Assistant or connect to devices. The test parser restores
parentheses around Python 3.14 exception tuples for older development Python.
Installation retains upstream syntax and line endings.
