
# SmartThings tools with MQTT

## Nordpool electricity price control for SmartThings
The [mqtt_control.js](scripts/mqtt_control.js) nodejs script obtains Finnish electricity prices from [Entso-E Transparency platform API](https://transparency.entsoe.eu/) or [Elering API](https://dashboard.elering.ee/assets/api-doc.html) (backup), and published an MQTT message through an MQTT broker to the [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver installed on SmartThings. The script stores data in [workspace/mqtt.csv](workspace/mqtt.csv) which can be plotted with the [html chart tool](chart/index.html). The file [workspace/mqtt.csv](workspace/mqtt.csv) has the following format:

```
unix_time,price,heat_on,temp_in,temp_out
```

NOTE! The device running [mqtt_control.js](scripts/mqtt_control.js) should be connected to the same local area network as the SmartThings hub.

## Easee API query script
The Easee API query script ([easee-query.js](scripts/easee-query.js)) asks for user credentials and then stores the respective user's Easee Charger and Easee Equalizer data into [workspace/easee.csv](workspace/easee.csv). The stored data contains electric current for three phases for Easee Charger (charger consumption) and Easee Equalizer (total home consumption). This data can also be plotted with the [html chart tool](chart/index.html). The [workspace/easee.csv](workspace/easee.csv) has the following format:

```
unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3
```

## Installation
Install `mosquitto` MQTT broker, `npm`, `nodejs`, and `pm2` process managed (optional) if not already installed:
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

## Setup

### SmartThings
In SmartThigns, install the [MQTTDevices](https://github.com/toddaustin07/MQTTDevices) edge driver, and set the correct IP for the device where the MQTT broker is running.

### Api keys
The [work directory](workspace) should contain an [API key file](workspace/apikey) with the user-specific [Entso-E](https://transparency.entsoe.eu/), [OpenWeatherMap](https://home.openweathermap.org/), and [SmartThings](https://account.smartthings.com/tokens) API keys, which can be obtained freely by registering to these services. If the [OpenWeatherMap](https://home.openweathermap.org/) and [SmartThings](https://account.smartthings.com/tokens) API keys are not set (ie, these API queries fail), the inside and outside temperatures are simply set to `0` degrees Celsius. However, inside temperature is only used for csv logging, and does not impact the heat adjustment algorithm. The [API key file](workspace/apikey) uses the json format and has the following structure:

```
{
    "easee": {
        "access_token": "<key>",
        "refresh_token": "<key>"
    },
    "entsoe": {
        "token": "<key>"
    },
    "mqtt": {
        "user": "<user>",
        "pw": "<pw>"
    },
    "openweathermap": {
        "token": "<key>"
    },
    "smartthings": {
        "token": "<key>"
    }
}
```
The easee keys are populated automatically when the user runs [easee-query.js](easee-query.js) and provides their login credentials.


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
allow_anonymous false
password_file /etc/mosquitto/passwd
```
Restart Mosquitto to apply the changes:
```
sudo systemctl restart mosquitto
```

## Running nordpool electricity price control for SmartThings
Run [mqtt_control.js](scripts/mqtt_control.js) in the current terminal instance by
```
node scripts/mqtt_control.js
```
to publish 'ON' and 'OFF' messages to MQTT 'st/heat' topic depending on the hourly electricity spot price. The outputted hourly data is automatically stored in [workspace/mqtt.csv](workspace/mqtt.csv).

To run with `pm2` process manager, use
```
pm2 start scripts/mqtt_control.js
```

## Running Easee API query script
Run [easee-query.js](easee-query.js) in the current terminal instance by
```
node scripts/easee-query.js
```
to collect the Easee Charger and Equalizer data into [workspace/easee.csv](workspace/easee.csv). The user credentials are asked once and then stored into [workspace/apikey](workspace/apikey).

To run with `pm2` process manager, use
```
pm2 start scripts/easee-query.js
```
However, this can be used only after the user credentials have been provided by first successfully running [easee-query.js](easee-query.js) at least once on an interactive session (which then stores the API keys for any subsequent execution).

## Plotting the csv data with chart.js

Run a local web server in the current terminal instance by
```
npm run dev
```
To run with `pm2` process manager, use
```
pm2 start npm -- run dev
```
Access the chart with browser at [http://localhost:1234](http://localhost:1234).

## Create persistent app list
Make `pm2` restart automatically after reboot by
```
pm2 startup
```
and following the instructions. After all desired apps have been started, save the app list by

```
pm2 save
```
so the apps will respawn after reboot. After a `nodejs` upgrade the startup script should be updated by running `pm2 unstartup` and `pm2 startup`.
