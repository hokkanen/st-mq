#!/usr/bin/with-contenv bashio

# Set config file path
CONFIG_PATH=./data/options.json

# Ensure the folder used for logging exists
mkdir -p ./share/st-mq

# Launch the services (mqtt-control.js logs into HASS log)
npm run dev &> ./share/st-mq/chart-server.log &
node ./scripts/easee-query.js &> ./share/st-mq/easee-query.log &
node ./scripts/mqtt-control.js

# Keep script running
wait
