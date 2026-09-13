# Direct Shelly MQTT

See [MQTT equipment](mqtt-equipment.md) for the explicit `shelly:<topic prefix>` /
`mqtt:<state topic>` configuration, device setup instructions, Home and Garage
monitoring, connection checks, timed switch tests and hourly energy recording.

Device connections and topics now have public defaults in `config.json`; broker
credentials remain in the private configuration. ST-MQ does not automatically
recognise or switch between the two connection formats.
