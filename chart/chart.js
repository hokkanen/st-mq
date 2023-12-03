import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import data for the chart
import data from 'url:../workspace/easee.csv';

// Import data for optional shading (comment out to disable)
import data_ext from 'url:../workspace/st-entsoe.csv';

// Aux function to get the beginning and end of the day
const date_lims = (start_date, end_date) => {
    let bod = new Date(start_date);
    bod.setHours(0, 0, 0, 0);
    let eod = new Date(end_date);
    eod.setDate(eod.getDate() + 1); // Add one day
    eod.setHours(0, 0, 0, 0);
    return { bod, eod };
};

// ChartDrawer class
class ChartDrawer {

    // Chart vars
    #chart;
    #max_time;
    #min_time;

    // Dataset 1 (data) vars
    #ch_curr1;
    #ch_curr2;
    #ch_curr3;
    #eq_curr1;
    #eq_curr2;
    #eq_curr3;

    // Dataset 2 (data_ext) vars
    #price;
    #heat_on;
    #temp_in;
    #temp_out;

    async #initialize_values() {
        // Destroy the chart if it already exists
        if (this.#chart)
            this.#chart.destroy();

        // Initialize all values
        this.#chart = null;
        this.#max_time = -Infinity;
        this.#min_time = Infinity;

        // Dataset 2 (data) vars
        this.#ch_curr1 = [];
        this.#ch_curr2 = [];
        this.#ch_curr3 = [];
        this.#eq_curr1 = [];
        this.#eq_curr2 = [];
        this.#eq_curr3 = [];

        // Dataset 2 (data_ext) vars
        this.#price = [];
        this.#heat_on = [];
        this.#temp_in = [];
        this.#temp_out = [];
    }

    // Setup the chart
    async #setup_chart() {

        // Use the date_lims function to get the beginning and end of the day
        const time_limits = date_lims(new Date(this.#min_time * 1000), new Date(this.#max_time * 1000));

        // Convert the time limits to Unix timestamps
        const time_min_unix = Math.floor(time_limits.bod.getTime() / 1000);
        const time_max_unix = Math.floor(time_limits.eod.getTime() / 1000);

        // Create new chart
        const ctx = document.getElementById('acquisitions').getContext('2d');
        this.#chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    { label: 'Charger 1', data: this.#ch_curr1, borderColor: 'transparent', backgroundColor: 'rgba(0, 255, 255, 0.5)', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger 2', data: this.#ch_curr2, borderColor: 'transparent', backgroundColor: 'rgba(255, 0, 255, 0.5)', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger 3', data: this.#ch_curr3, borderColor: 'transparent', backgroundColor: 'rgba(255, 255, 0, 0.5)', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 1', data: this.#eq_curr1, borderColor: 'cyan', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 2', data: this.#eq_curr2, borderColor: 'magenta', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 3', data: this.#eq_curr3, borderColor: 'yellow', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Price', data: this.#price, yAxisID: 'y2', borderColor: 'black', borderDash: [1, 3], borderWidth: 1, fill: false, pointRadius: 1, stepped: 'before' },
                    { label: 'Temp In', data: this.#temp_in, yAxisID: 'y2', borderColor: 'green', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Temp Out', data: this.#temp_out, yAxisID: 'y2', borderColor: 'blue', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Heat Off', data: this.#heat_on, yAxisID: 'y2', backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', fill: 'start', pointRadius: 0, stepped: 'before' }
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
                                const date = new Date(context[0].parsed.x * 1000).toLocaleString('en-UK');
                                return date;
                            },
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        beginAtZero: false,
                        min: time_min_unix,
                        max: time_max_unix,
                        ticks: {
                            source: 'data',
                            autoSkip: true,
                            stepSize: (time_max_unix - time_min_unix) / 24,
                            callback: function (value, index, values) {
                                // Convert the Unix timestamp to a Date object
                                const date = new Date(value * 1000);
                                // Format the date
                                return date.toLocaleString('en-UK');
                            }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 128, 128, 0.2)',
                        },
                        ticks: {
                            color: 'rgba(0, 128, 128, 1)',
                        },
                        title: {
                            display: true,
                            color: 'rgba(0, 128, 128, 1)',
                            text: 'Electric Current (A)'
                        }
                    },
                    y2: {
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
                            this.#min_time = Math.min(this.#min_time, row['unix_time']);
                            this.#max_time = Math.max(this.#max_time, row['unix_time']);
                        }
                    }
                },
                complete: (results) => {
                    if (results.errors.length > 0)
                        reject(results.errors);
                    else
                        resolve();
                },
                error: (error) => {
                    reject(error);
                }
            });
        });
    }

    // Update the heat_on dataset based on max and min values of the y2 axis
    async #update_heat_on_data() {
        let last_non_null_index = null;
        let max_y = this.#chart.scales['y2'].max;
        let min_y = this.#chart.scales['y2'].min;

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
    async generateChart(start_date, end_date) {

        // Destroy any existing charts and initialize all vars
        this.#initialize_values();

        // Convert the start and end dates to Unix timestamps
        const start_time_unix = new Date(start_date).getTime() / 1000;
        const end_time_unix = new Date(end_date).getTime() / 1000;

        // Parse data and update the datasets
        try {
            await this.#parse_data(data, start_time_unix, end_time_unix, (row) => {
                this.#ch_curr1.push({ x: row['unix_time'], y: row['ch_curr1'] });
                this.#ch_curr2.push({ x: row['unix_time'], y: row['ch_curr2'] });
                this.#ch_curr3.push({ x: row['unix_time'], y: row['ch_curr3'] });
                this.#eq_curr1.push({ x: row['unix_time'], y: row['eq_curr1'] });
                this.#eq_curr2.push({ x: row['unix_time'], y: row['eq_curr2'] });
                this.#eq_curr3.push({ x: row['unix_time'], y: row['eq_curr3'] });
            }).catch((error) => console.log(error));

            await this.#parse_data(data_ext, start_time_unix, end_time_unix, (row) => {
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
        limits = date_lims(start_date, end_date);
        chart_drawer.generateChart(limits.bod, limits.eod);
    });

    // Reset the chart data to the whole original data
    document.getElementById('showAllButton').addEventListener('click', function () {
        limits = date_lims(new Date(0), new Date());
        chart_drawer.generateChart(limits.bod, limits.eod);
    });

    // Generate the chart for the current day when the chart is first opened
    limits = date_lims(new Date(), new Date());
    chart_drawer.generateChart(limits.bod, limits.eod);
})();
