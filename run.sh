#!/usr/bin/with-contenv bashio

# Set config file path
CONFIG_PATH=/data/options.json

# Launch the services
npm run dev &> ./share/st-mq/chart-server.log &
node ./scripts/easee-query.js &> ./share/st-mq/easee-query.log &
node ./scripts/mqtt-control.js

# Keep script running
wait
