
# SmartThings MQTT tools with kWh spot price query (Nordic + Baltic)

This tool can be run as a standalone app (see below) or as a [Home Assistant add-on](DOCS.md). The tool uses MQTT communication, so it can be used with any home automation system that can receive MQTT messages, not just SmartThings. However, the setup instructions are provided only for SmartThings. 

## Nordpool kWh spot price control for SmartThings
The [mqtt-control.js](scripts/mqtt-control.js) nodejs script obtains Nordic and Baltic electricity prices from [Entso-E Transparency platform API](https://transparency.entsoe.eu/) or [Elering API](https://dashboard.elering.ee/assets/api-doc.html) backup API (Elering API works only for fi, ee, lt, and lv country codes), and publishes an MQTT message through an MQTT broker to the [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver installed on SmartThings. The script stores data in `./share/st-mq/st-mq.csv` which can be plotted with the [html chart tool](chart/index.html). The file `./share/st-mq/st-mq.csv` has the following format:

```
unix_time,price,heat_on,temp_in,temp_out
```

NOTE! The device running [mqtt-control.js](scripts/mqtt-control.js) should be connected to the same local area network as the MQTT broker and the SmartThings hub.

## Easee API query script
The Easee API query script stores the respective user's Easee Charger and Easee Equalizer data into `./share/st-mq/easee.csv`. The stored data contains electric current for three phases for Easee Charger (charger consumption) and Easee Equalizer (total home consumption). This data can also be plotted with the [html chart tool](chart/index.html). The `./share/st-mq/easee.csv` has the following format:

```
unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3
```

## Installation (standalone)
Install `mosquitto` MQTT broker, `npm`, `nodejs`, and `pm2` process manager (optional) if not already installed:
```
sudo apt update
sudo apt install -y mosquitto nodejs npm pm2
```

Clone this repo by
```
git clone https://github.com/hokkanen/st-mq.git
```

Install npm dependencies locally in the project folder by
```
cd st-mq
npm i
```

## Setup (standalone)

### SmartThings
In SmartThings, install [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver, set the correct IP for the device where the MQTT broker is running, and subscribe to `from_stmq/heat/action` topic and listen for `heaton`/`heatoff` messages.

### Config
The root directory contains [config.json](config.json) file in which the `options` section needs to be updated. In the config, fill in geolocation information, temperature-to-heating-hours mapping array, MQTT broker details, and the required API keys and SmartThings device IDs for the temperature sensors. For more information, check the [HASS translations file](translations/en.yaml).

To collect consumption data from local Easee devices, Easee authentication and device information are required as well. Giving either a username and password, or an access token and refresh token, is required. Providing tokens only should be a theoretically safer option since they provide limited access to Easee account. However, giving a username and password has turned out to be a more stable option, since the refresh token update procedure may in rare occasions fail (maybe a few times a year when running the tool 24/7). If neither of these authentication methods are provided, Easee consumption data is not collected.

The user-specific [Entso-E](https://transparency.entsoe.eu/), [OpenWeatherMap](https://home.openweathermap.org/), and [SmartThings](https://account.smartthings.com/tokens) API keys can be obtained freely by registering to these services. If the [OpenWeatherMap](https://home.openweathermap.org/) and [SmartThings](https://account.smartthings.com/tokens) API keys are not set (ie, these API queries fail), the inside and outside temperatures are simply set to `0` degrees Celsius. However, inside temperature is only used for csv logging, and does not impact the heat adjustment algorithm. 

### Mosquitto MQTT broker
Set up Mosquitto user name and password by creating a password file with
```
sudo mosquitto_passwd -c /etc/mosquitto/passwd <username>
```
Create a user config file with `micro` editor by
```
sudo micro /etc/mosquitto/conf.d/myconfig.conf
```
with the following contents:
```
# Allow connections from anywhere
listener 1883

# Require credentials for connections
allow_anonymous false
password_file /etc/mosquitto/passwd
```
Restart Mosquitto to apply the changes:
```
sudo systemctl restart mosquitto
```

## Running (standalone)
To start all required services, ie, [easee-query.js](scripts/easee-query.js) and [mqtt-control.js](scripts/mqtt-control.js) scripts, and a web server for [chart/index.html](chart/index.html), run [scheduler.js](scheduler.js) in the current terminal instance by
```
node scheduler.js
```
To run with `pm2` process manager without using the [scheduler.js](scheduler.js) script, use the following ([easee-query.js](scripts/easee-query.js) does not have an internal scheduler):
```
pm2 start ./scripts/mqtt-control.js
pm2 start ./scripts/easee-query.js --cron-restart="*/5 * * * *" --no-autorestart
pm2 start npm -- run dev
```
The console output uses blue color for [mqtt-control.js](scripts/mqtt-control.js) and green color for [easee-query.js](easee-query.js) (the [chart](chart/index.html) server log is stored in `./share/st-mq/chart-server.log`). The [chart](chart/index.html) itself can be accessed with browser at [http://localhost:1234](http://localhost:1234).

## Create persistent app list (standalone)
Make `pm2` restart automatically after reboot by
```
pm2 startup
```
and following the instructions. After all desired apps have been started, save the app list by

```
pm2 save
```
so the apps will respawn after reboot. After a `nodejs` upgrade the startup script should be updated by running `pm2 unstartup` and `pm2 startup`.
