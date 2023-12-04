import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import easee consumption data for the chart (can be commented out)
import data_easee from 'url:../workspace/easee.csv';

// Import st-entsoe data for the chart (can be commented out)
import data_st from 'url:../workspace/st-entsoe.csv';

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
        let bod_date = new Date(start_date);
        // Set the beginning of the current day
        bod_date.setHours(0, 0, 0, 0);
        let eod_date = new Date(end_date);
        // Set the beginning of the next day
        eod_date.setDate(eod_date.getDate() + 1);
        // Add extra 1min to include the first point of the next day
        eod_date.setHours(0, 1, 0, 0);
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
                    { label: 'Price', yAxisID: 'y_right', data: this.#price, borderColor: 'black', borderDash: [1, 3], borderWidth: 1, fill: false, pointRadius: 1, stepped: 'before' },
                    { label: 'Temp In', yAxisID: 'y_right', data: this.#temp_in, borderColor: 'green', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Temp Out', yAxisID: 'y_right', data: this.#temp_out, borderColor: 'blue', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Heat Off', yAxisID: 'y_right', data: this.#heat_on, backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', fill: 'start', pointRadius: 0, stepped: 'before' }
                ]
            },
            options: {
                responsive: true,
                plugins: {
                    decimation: {
                        enabled: true,
                        algorithm: 'min-max', // or 'lttb'
                        samples: 288 // For 5 min data, 288 samples = 24 hours
                    },
                    title: {
                        display: true,
                        text: 'Home Monitor'
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
                                // Convert the Unix timestamp to a Date object and format the date
                                return new Date(value * 1000).toLocaleString('en-UK');
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
                            text: 'Current (A) / Power (kW)'
                        }
                    },
                    y_right: {
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Price (¢) / Temp (°C)'
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
                        this.#max_time_unix = Math.max(this.#max_time_unix, time_limits.eod);

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

        //Update the heat_on dataset to show correctly
        await this.#update_heat_on_data();

        // Update the chart to show heat_on correctly
        this.#chart.update();
    }

    // Choose between individual phases and total power layouts
    get_actions() {
        return [
            {
                name: 'Individual phases (A)',
                handler() {
                    this.#chart.data.datasets[0].hidden = false;
                    this.#chart.data.datasets[1].hidden = false;
                    this.#chart.data.datasets[2].hidden = false;
                    this.#chart.data.datasets[3].hidden = true;
                    this.#chart.data.datasets[4].hidden = false;
                    this.#chart.data.datasets[5].hidden = false;
                    this.#chart.data.datasets[6].hidden = false;
                    this.#chart.data.datasets[7].hidden = true;
                    this.#chart.update();
                }
            },
            {
                name: 'Total power (kW)',
                handler() {
                    this.#chart.data.datasets[0].hidden = true;
                    this.#chart.data.datasets[1].hidden = true;
                    this.#chart.data.datasets[2].hidden = true;
                    this.#chart.data.datasets[3].hidden = false;
                    this.#chart.data.datasets[4].hidden = true;
                    this.#chart.data.datasets[5].hidden = true;
                    this.#chart.data.datasets[6].hidden = true
                    this.#chart.data.datasets[7].hidden = false
                    this.#chart.update();
                }
            },
        ];
    }
    // Apply the action
    apply_action(action) {
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
