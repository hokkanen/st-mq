# SmartThings MQTT tools with kWh spot price query (Nordic + Baltic)

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]
![Supports armhf Architecture][armhf-shield]
![Supports armv7 Architecture][armv7-shield]
![Supports i386 Architecture][i386-shield]


[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fhokkanen%2Fst-mq)

1. Install ST-MQ using the above button
2. Install MQTT broker (Mosquitto HASS add-on address is preconfigured in config, but can be changed)
3. In SmartThings, install [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver, set the correct IP for the device where the MQTT broker is running, and subscribe to `from_stmq/heat/action` topic and listen for `heaton`/`heatoff` messages
4. Set up ST-MQ configuration on the add-on's configuration tab
5. Start the ST-MQ add-on
6. Access html chart at http://homeassistant.local:1234 (default port)
7. The output files and the chart server log are in `/root/share/st-mq/` under HASS file system
8. The HASS add-on log tab shows MQTT controller output (blue) and Easee query output (green)

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
[armhf-shield]: https://img.shields.io/badge/armhf-yes-green.svg
[armv7-shield]: https://img.shields.io/badge/armv7-yes-green.svg
[i386-shield]: https://img.shields.io/badge/i386-yes-green.svg
