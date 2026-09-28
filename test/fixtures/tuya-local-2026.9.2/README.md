# Tuya Local source contract fixture

These are reviewed **Tuya Local 2026.9.2** Python sources, retained solely to test
the observation patch offline. They contain no installation configuration,
credentials, device identifiers or household telemetry. The upstream MIT license
is preserved in `LICENSE.md`.

Upstream: <https://github.com/make-all/tuya-local/tree/2026.9.2/custom_components/tuya_local>

The supported installed `device.py` build has SHA-256
`9ec422f63e53b5c366e5fd9b1abd886beaa5e7d27a1a631a48253b91148b3bdb`.
Its lock placement and disconnected-socket backoff differ from the source served
by the upstream tag at review time. The adapter retains that existing behavior;
it does not change native command locking or retries. The installer accepts only
the reviewed source bytes, not every installation bearing the same version label.
The complete original and patched hashes are in
`integrations/homeassistant/tuya-local-observation.json`.

The tests apply the real patch, compile the relevant methods from the patched
source, and execute them with synthetic transport and entity objects. The fixture
is never imported as an installed Home Assistant integration. One Python 3.14
exception-tuple spelling is normalized only in the test parser so these tests can
also run on Python 3.11. Installation preserves the original source syntax and
line endings.
