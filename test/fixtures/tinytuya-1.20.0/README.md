# Current TinyTuya producer fixture

`XenonDevice.py` is the exact public TinyTuya 1.20.0 source from
<https://raw.githubusercontent.com/jasonacox/tinytuya/v1.20.0/tinytuya/core/XenonDevice.py>.
SHA-256: `cd3a5f333eed39c55dafd821a01810ac824c74e6cbd330c9b863e43bf4b7963f`.
`Device.py` is the exact corresponding public command producer source from
<https://raw.githubusercontent.com/jasonacox/tinytuya/v1.20.0/tinytuya/core/Device.py>.
SHA-256: `7198545e788da17bce360999ece54e98d09a27d614f431adf62a1fc99c37c211`.
The upstream MIT license is retained in `LICENSE`.

Tests extract the current `status`, `receive`, `_send_receive`, `_process_message`
and return-code producers, plus the unchanged nowait command, heartbeat and
forced-DPS producers, using a controlled validated-frame/decoded-JSON
boundary. They do not open a network connection or exercise encryption in this
fixture. Native query sequence/command selection, first-frame acceptance and
continuous Tuya Local observation consumers execute unchanged. This is a pinned
external-protocol fixture, not another ST-MQ persisted format or runtime decoder.
