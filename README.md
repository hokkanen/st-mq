
# SmartThings MQTT tools with kWh spot price query

This tool can be run as a standalone app (see below) or as a [Home Assistant Add-On](DOCS.md).

## Nordpool kWh spot price control for SmartThings
The [mqtt-control.js](scripts/mqtt-control.js) nodejs script obtains Finnish electricity prices from [Entso-E Transparency platform API](https://transparency.entsoe.eu/) or [Elering API](https://dashboard.elering.ee/assets/api-doc.html) (backup), and publishes an MQTT message through an MQTT broker to the [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver installed on SmartThings. The script stores data in [share/st-mq/st-mq.csv](share/st-mq/st-mq.csv) which can be plotted with the [html chart tool](chart/index.html). The file [share/st-mq/st-mq.csv](share/st-mq/st-mq.csv) has the following format:

```
unix_time,price,heat_on,temp_in,temp_out
```

NOTE! The device running [mqtt-control.js](scripts/mqtt-control.js) should be connected to the same local area network as the MQTT broker and the SmartThings hub.

## Easee API query script
The Easee API query script stores the respective user's Easee Charger and Easee Equalizer data into [share/st-mq/easee.csv](share/st-mq/easee.csv). The stored data contains electric current for three phases for Easee Charger (charger consumption) and Easee Equalizer (total home consumption). This data can also be plotted with the [html chart tool](chart/index.html). The [share/st-mq/easee.csv](share/st-mq/easee.csv) has the following format:

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
In SmartThigns, install the [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver, and set the correct IP for the device where the MQTT broker is running.

### Config
The root directory contains [config.json](config.json) file which needs to be modified. In the config, fill in MQTT broker details, geolocation information, the required API keys, SmartThings device ID for the inside temperature sensor, and the temperature-to-heating-hours mapping array. For more information, check the HASS translations [file](translations/en.yaml).

To collect consumption data from local Easee devices, Easee authentication and device information is required as well. Giving Easee login credentials in place of the actual tokens works also, ie, "access_token" = "username" and "refresh_token" = "pw". If these authentication details are not provided, Easee features are disabled.

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
To start all required services, ie, a web server for [chart/index.html](chart/index.html), [easee-query.js](easee-query.js) and [mqtt-control.js](scripts/mqtt-control.js) scripts, run [scheduler.js](scheduler.js) in the current terminal instance by
```
node scheduler.js
```
To run with `pm2` process manager, use
```
pm2 start scheduler.js
```
Access the [chart](chart/index.html) with browser at [http://localhost:1234](http://localhost:1234).

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
