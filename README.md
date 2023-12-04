# Easee Equalizer current flow API query and html chart

## Installation
Clone repo by
```
git clone https://github.com/hokkanen/easee-query.git
```

Install npm dependencies by running
```
npm i
```

## Running Easee API query script (backend)
Run [easee-query.js](easee-query.js) in the current terminal instance by
```
node easee-query.js
```
to collect the data into `workspace/easee.csv` by querying the Easee API. The user credentials are asked once and then stored into `workspace/apikey`.

To run with `pm2` process manager, use
```
pm2 start easee-query.js
```
However, this can be used only after the API keys are already stored.

## Plotting the Easee API data with chart.js (frontend)

Run a local web server in the current terminal instance by
```
npm run dev
```
Set server to restart 1 minute past every even hour using `pm2`:
```
pm2 start --cron-restart="1 */1 * * *" npm -- run dev
```
Access the chart with browser at [http://localhost:1234](http://localhost:1234).

