import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import easee consumption data for the chart (can be commented out)
import data_easee from 'url:/share/st-mq/easee.csv';

// Import st-entsoe data for the chart (can be commented out)
import data_st from 'url:/share/st-mq/st-mq.csv';

// The local electric grid voltage for all phases
const VOLTAGE = 230;

// ChartDrawer class
class ChartDrawer {

    // Chart vars
    #chart;
    #max_time_unix;
    #min_time_unix;

    // Dataset 1 (data_easee) vars
    #ch_curr1;
    #ch_curr2;
    #ch_curr3;
    #ch_total;
    #eq_curr1;
    #eq_curr2;
    #eq_curr3;
    #eq_total;

    // Dataset 2 (data_st) vars
    #price;
    #heat_on;
    #temp_in;
    #temp_out;

    // Initialize chart vars
    #initialize_chart() {
        // Destroy the chart if it already exists
        if (this.#chart)
            this.#chart.destroy();

        // Initialize all values
        this.#chart = null;
        this.#max_time_unix = -Infinity;
        this.#min_time_unix = Infinity;

        // Dataset 2 (data_easee) vars
        this.#ch_curr1 = [];
        this.#ch_curr2 = [];
        this.#ch_curr3 = [];
        this.#ch_total = [];
        this.#eq_curr1 = [];
        this.#eq_curr2 = [];
        this.#eq_curr3 = [];
        this.#eq_total = [];

        // Dataset 2 (data_st) vars
        this.#price = [];
        this.#heat_on = [];
        this.#temp_in = [];
        this.#temp_out = [];
    }

    // Get the beginning and end of the day
    #date_lims(start_date, end_date) {
        // Set the beginning of the current day
        let bod_date = new Date(start_date);
        bod_date.setHours(0, 0, 0, 0);
        // Add 24 hours + 1min to include the first point of the next day
        let eod_date = new Date(end_date);
        eod_date.setHours(24, 1, 0, 0);
        // Return the Unix timestamps
        const bod = Math.floor(new Date(bod_date.getTime()) / 1000);
        const eod = Math.floor(new Date(eod_date.getTime()) / 1000);
        return { bod, eod };
    }

    // Setup the chart
    async #setup_chart() {
        // Create a new chart
        const ctx = document.getElementById('acquisitions').getContext('2d');
        this.#chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    { label: 'Charger 1 (A)', yAxisID: 'y_left', data: this.#ch_curr1, backgroundColor: 'rgba(0, 255, 255, 0.5)', borderColor: 'transparent', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger 2 (A)', yAxisID: 'y_left', data: this.#ch_curr2, backgroundColor: 'rgba(255, 0, 255, 0.5)', borderColor: 'transparent', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger 3 (A)', yAxisID: 'y_left', data: this.#ch_curr3, backgroundColor: 'rgba(255, 255, 0, 0.5)', borderColor: 'transparent', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger Total (kW)', yAxisID: 'y_left', data: this.#ch_total, backgroundColor: 'rgba(255, 0, 0, 0.5)', borderColor: 'transparent', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 1 (A)', yAxisID: 'y_left', data: this.#eq_curr1, borderColor: 'cyan', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 2 (A)', yAxisID: 'y_left', data: this.#eq_curr2, borderColor: 'magenta', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 3 (A)', yAxisID: 'y_left', data: this.#eq_curr3, borderColor: 'yellow', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer Total (kW)', yAxisID: 'y_left', data: this.#eq_total, borderColor: 'rgba(255, 0, 0, 1)', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Price (¢/kWh)', yAxisID: 'y_right', data: this.#price, borderColor: 'black', borderDash: [1, 3], borderWidth: 1, fill: false, pointRadius: 1, stepped: 'before' },
                    { label: 'Temp In (°C)', yAxisID: 'y_right', data: this.#temp_in, borderColor: 'green', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Temp Out (°C)', yAxisID: 'y_right', data: this.#temp_out, borderColor: 'blue', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Heat Off', yAxisID: 'y_right', data: this.#heat_on, backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', fill: 'start', pointRadius: 0, stepped: 'before' }
                ]
            },
            options: {
                normalized: false, // If true, data must be unique, sorted, and consistent across datasets (improved performance)
                parsing: false, // If false, data must be sorted and match the internal data format (required if decimation enabled)
                responsive: true, // Automatically resize the chart canvas with its container
                plugins: {
                    decimation: {
                        enabled: true,
                        algorithm: 'lttb', // 'min-max' or 'lttb'
                        samples: 576, // For 5 min data, 576 samples = 48 hours
                        threshold: 576 // Decimation activation threshold (samples)
                    },
                    title: {
                        display: true,
                        text: 'Home Monitor Chart'
                    },
                    tooltip: {
                        callbacks: {
                            title: function (context) {
                                // Convert the Unix timestamp to a Date object and format the date
                                return new Date(context[0].parsed.x * 1000).toLocaleString('en-UK');
                            },
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        beginAtZero: false,
                        min: this.#min_time_unix,
                        max: this.#max_time_unix,
                        ticks: {
                            source: 'data',
                            autoSkip: true,
                            stepSize: (this.#max_time_unix - this.#min_time_unix) / 24,
                            callback: function (value, index, values) {
                                // Convert the Unix timestamp to a Date object
                                const date = new Date(value * 1000);
                                // Get the date and time parts of the date
                                const date_string = date.toLocaleDateString('en-UK');
                                const time_string = date.toLocaleTimeString('en-UK', { hour: '2-digit', minute: '2-digit' });
                                // Check if the time is '00:00'
                                if (time_string === '00:00')
                                    return date_string + ' ' + time_string; // Return date and time
                                else
                                    return time_string; // Return time only
                            }
                        }
                    },
                    y_left: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(255, 0, 0, 0.2)',
                        },
                        ticks: {
                            color: 'rgba(255, 0, 0, 1)',
                        },
                        title: {
                            display: true,
                            color: 'rgba(255, 0, 0, 1)',
                            text: 'Power (kW) / Current (A)'
                        }
                    },
                    y_right: {
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Price (¢/kWh) / Temp (°C)'
                        }
                    }
                }
            }
        });
    }

    // Parse data using PapaParse
    async #parse_data(data, start_time_unix, end_time_unix, callback) {
        return new Promise((resolve, reject) => {
            // Store the local min and max time values for the searched time period
            let max_time = -Infinity;
            let min_time = Infinity;

            // Parse data
            Papa.parse(data, {
                download: true,
                header: true,
                dynamicTyping: true,
                step: (results) => {
                    const row = results.data;

                    // Only add the row to the datasets if it's within the desired time range
                    if (row['unix_time'] >= start_time_unix && row['unix_time'] < end_time_unix) {
                        // Parse data from the callback
                        callback(row);
                        // Update min_time and max_time
                        if (row['unix_time'] !== null) {
                            min_time = Math.min(min_time, row['unix_time']);
                            max_time = Math.max(max_time, row['unix_time']);
                        }
                    }
                },
                complete: (results) => {
                    if (results.errors.length > 0)
                        reject(results.errors);
                    else {
                        // Get the beginning and end of the day for min_time and max_time (remove the extra 60 secs from eod)
                        const time_limits = this.#date_lims(new Date(min_time * 1000), new Date((max_time - 60) * 1000));

                        // Convert the time limits to Unix timestamps and check if global min and max time values need updating
                        this.#min_time_unix = Math.min(this.#min_time_unix, time_limits.bod);
                        this.#max_time_unix = Math.max(this.#max_time_unix, time_limits.eod - 60); // Remove the extra 60 secs from eod

                        // Resolve promise
                        resolve();
                    }
                },
                error: (error) => {
                    reject(error);
                }
            });
        });
    }

    // Update the heat_on dataset based on max and min values of the y_right axis
    async #update_heat_on_data() {
        let last_non_null_index = null;
        let max_y = this.#chart.scales['y_right'].max;
        let min_y = this.#chart.scales['y_right'].min;

        for (let i = 0; i < this.#heat_on.length; i++) {
            if (this.#heat_on[i].y === 0)
                this.#heat_on[i].y = max_y;
            else
                this.#heat_on[i].y = min_y;

            if (this.#heat_on[i].x !== null)
                last_non_null_index = i;
        }
        // Append a single value at the end of the array
        if (last_non_null_index !== null && this.#heat_on[last_non_null_index].y === max_y) {
            const date = new Date(this.#heat_on[last_non_null_index].x * 1000);
            date.setMinutes(0, 0, 0);
            date.setHours(date.getHours() + 1);
            const x_next_hour = date.getTime() / 1000;
            if (last_non_null_index === this.#heat_on.length - 1) {
                //const x_next_hour = this.#heat_on[this.#heat_on.length - 1].x + 3600;
                this.#heat_on.push({ x: x_next_hour, y: this.#heat_on[this.#heat_on.length - 1].y });
            } else {
                //const x_next_hour = this.#heat_on[last_non_null_index].x + 3600;
                this.#heat_on[last_non_null_index + 1] = { x: x_next_hour, y: this.#heat_on[last_non_null_index].y };
            }
        }
    }

    // Compare realized cost (€) vs reference cost (daily average) for the current period
    async #perform_cost_analysis() {
        // Initialize returned values
        let realized_cost_ch = 0; // accummulated realized total cost for charger
        let realized_cost_eq = 0; // accummulated realized total cost for equalizer
        let reference_cost_ch = 0; // accummulated reference total cost for charger
        let reference_cost_eq = 0; // accummulated reference total cost for equalizer
        // Make sure that enough price data is available (at least 2 data points)
        if(this.#price.length > 1){
            // Initialize auxialiry values
            let day = Math.floor((this.#price[0].x + 3600) / 86400); // int representing the current day
            let average_kwh_price_24h = 0; // reference price during the current day
            let reference_kwh_ch_24h = 0; // reference kwh during the current day for charger
            let reference_kwh_eq_24h = 0; // reference kwh during the current day for equalizer
            let total_hours = 0; // hours between consecutive days' first price data points
            // Evaluate loop over price datapoints
            let j = 0; // index for the inner loop (consumption dataset)
            for (let i = 0; i < this.#price.length - 1; i++) {
                let ch_kw = 0; // charger consumption
                let eq_kw = 0; // equalized consumption
                let n_kw_datapoints = 0; // the number of consumption datapoints
                // Evaluate the loop over consumption dataset
                while(j < this.#eq_total.length && this.#eq_total[j].x < this.#price[i + 1].x){
                    // If the consumption datapoint is within the current hourly price window
                    if (this.#eq_total[j].x > this.#price[i].x){
                        ch_kw += this.#ch_total[j].y;
                        eq_kw += this.#eq_total[j].y;
                        n_kw_datapoints += 1;
                    }
                    j++;
                }
                // The time in hours between price data points
                const hour_weight = (this.#price[i + 1].x - this.#price[i].x) / 3600;
                // Total hours between day's price data points (around 24 hours)
                total_hours += hour_weight;
                // The average kWh used during the time between price data points
                const hourly_kwh_ch = n_kw_datapoints === 0 ? 0 : ch_kw * hour_weight / n_kw_datapoints;
                const hourly_kwh_eq = n_kw_datapoints === 0 ? 0 : eq_kw * hour_weight / n_kw_datapoints;
                // Accummulate the sum of the kWh used during the day
                reference_kwh_ch_24h += hourly_kwh_ch;
                reference_kwh_eq_24h += hourly_kwh_eq;
                // Calculate the reference daily price (€) and the number of price datapoints
                average_kwh_price_24h += this.#price[i].y / 100 * hour_weight;
                // If the last price period of the day, update reference price and reset values
                if(Math.floor((this.#price[i + 1].x + 3600) / 86400) !== day || i === this.#price.length - 2){
                    // Add the reference cost of the day (assuming average consumption)
                    average_kwh_price_24h /= total_hours;
                    reference_cost_ch += average_kwh_price_24h * reference_kwh_ch_24h;
                    reference_cost_eq += average_kwh_price_24h * reference_kwh_eq_24h;
                    // Reset the accummulated daily values
                    average_kwh_price_24h = 0;
                    reference_kwh_ch_24h = 0;
                    reference_kwh_eq_24h = 0;
                    total_hours = 0;
                    // Set the new day value
                    day = Math.floor((this.#price[i + 1].x + 3600) / 86400); // the next day
                }
                // Accummulate the actual realized price (€)
                realized_cost_ch += hourly_kwh_ch * this.#price[i].y / 100;
                realized_cost_eq += hourly_kwh_eq * this.#price[i].y / 100;
            }
        }
        // Create an object for realized and reference costs for charger and equalizer
        const costs = {
            realized_cost_ch: realized_cost_ch, 
            realized_cost_eq: realized_cost_eq,
            reference_cost_ch: reference_cost_ch,
            reference_cost_eq: reference_cost_eq,
            savings_without_ch: (reference_cost_eq - reference_cost_ch) 
                                - (realized_cost_eq - realized_cost_ch)
        };
        // Print costs array into console (temporary hack to get it working)
        console.log(costs);
        // Return costs array
        return costs;
    }

    // Generate the chart
    async generate_chart(start_date, end_date) {

        // Destroy any existing charts and initialize all vars
        this.#initialize_chart();

        // Convert the start and end dates to Unix timestamps
        const limits = this.#date_lims(start_date, end_date);
        const start_time_unix = limits.bod;
        const end_time_unix = limits.eod;

        // Parse data_easee and populate the dataset
        try {
            await this.#parse_data(data_easee, start_time_unix, end_time_unix, (row) => {
                this.#ch_curr1.push({ x: row['unix_time'], y: row['ch_curr1'] });
                this.#ch_curr2.push({ x: row['unix_time'], y: row['ch_curr2'] });
                this.#ch_curr3.push({ x: row['unix_time'], y: row['ch_curr3'] });
                this.#ch_total.push({ x: row['unix_time'], y: VOLTAGE * (row['ch_curr1'] + row['ch_curr2'] + row['ch_curr3']) / 1000 });
                this.#eq_curr1.push({ x: row['unix_time'], y: row['eq_curr1'] });
                this.#eq_curr2.push({ x: row['unix_time'], y: row['eq_curr2'] });
                this.#eq_curr3.push({ x: row['unix_time'], y: row['eq_curr3'] });
                this.#eq_total.push({ x: row['unix_time'], y: VOLTAGE * (row['eq_curr1'] + row['eq_curr2'] + row['eq_curr3']) / 1000 });
            }).catch((error) => console.log(error));
        } catch (error) {
            console.log(error);
        }

        // Parse data_st and populate the dataset
        try {
            await this.#parse_data(data_st, start_time_unix, end_time_unix, (row) => {
                this.#price.push({ x: row['unix_time'], y: row['price'] });
                this.#heat_on.push({ x: row['unix_time'], y: row['heat_on'] });
                this.#temp_in.push({ x: row['unix_time'], y: row['temp_in'] });
                this.#temp_out.push({ x: row['unix_time'], y: row['temp_out'] });
            }).catch((error) => console.log(error));
        } catch (error) {
            console.log(error);
        }

        // Setup the chart
        await this.#setup_chart();

        // Update the heat_on dataset to show correctly
        await this.#update_heat_on_data();

        // Perform cost analysis between realized cost and reference cost estimate in €
        this.#perform_cost_analysis();

        // Use the first action layout as default (also updates chart)
        await this.apply_action(this.get_actions()[0]);
    }

    // Choose between individual phases and total power layouts
    get_actions() {
        return [
            {
                name: 'Total power (kW)',
                handler() {
                    this.#chart.data.datasets = this.#chart.data.datasets.map((dataset, i) =>
                        i < 8 ? { ...dataset, hidden: ![3, 7].includes(i) } : dataset
                    );
                    this.#chart.update();
                }
            },
            {
                name: 'Individual phases (A)',
                handler() {
                    this.#chart.data.datasets = this.#chart.data.datasets.map((dataset, i) =>
                        i < 8 ? { ...dataset, hidden: [3, 7].includes(i) } : dataset
                    );
                    this.#chart.update();
                }
            },
        ];
    }

    // Apply the action
    async apply_action(action) {
        action.handler.call(this);
    }
}

// Begin execution here
(async function () {

    // Instantiate the class
    const chart_drawer = new ChartDrawer();

    // Set the default date of the date inputs to today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('dateInput').value = today;
    document.getElementById('endDateInput').value = today;

    // Add event listener to the range checkbox
    document.getElementById('rangeCheckbox').addEventListener('change', function () {
        // Show or hide the end date input based on the checkbox state
        document.getElementById('endDateInput').style.display = this.checked ? 'inline' : 'none';
    });

    // Get the selected date or date range
    document.getElementById('filterButton').addEventListener('click', function () {
        let start_date = new Date(document.getElementById('dateInput').value);
        let end_date = document.getElementById('rangeCheckbox').checked
            ? new Date(document.getElementById('endDateInput').value) : new Date(start_date.getTime());
        chart_drawer.generate_chart(start_date, end_date);
    });

    // Reset the chart data to the whole original data
    document.getElementById('showAllButton').addEventListener('click', function () {
        chart_drawer.generate_chart(new Date(0), new Date());
    });

    // Switch between individual phases and total power layouts
    const chartActions = document.getElementById('chartActions');
    chart_drawer.get_actions().forEach(action => {
        const button = document.createElement('button');
        button.innerText = action.name;
        button.addEventListener('click', () => chart_drawer.apply_action(action));
        chartActions.appendChild(button);
    });

    // Generate the chart for the current day when the chart is first opened
    chart_drawer.generate_chart(new Date(), new Date());

})();
