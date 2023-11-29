# Easee equalizer current flow API query and html chart

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
to collect the data by querying Easee API. The user credentials are asked once and then stored folder in an `apikey` file in the [workspace](workspace) folder.

In Linux, starting with
```
(nohup node easee-query.js&)
```
allows the output to be directed to `nohup.out` file and the program to be kept running even if the terminal instance is closed. However, this cannot be used if user credentials are required.

## Plotting the Easee API data with chart.js (frontend)

Run a local web server in the current terminal instance by
```
npm run dev
```
and access the chart with browser at `http://localhost:1234`.

