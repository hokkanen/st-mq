import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import data for the chart
import data from 'url:../workspace/easee.csv';

// Import data for optional shading (comment out to disable)
import data_ext from 'url:../workspace/st-entsoe.csv';
function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ChartDrawer class
class ChartDrawer {

    // Chart vars
    #chart = null;

    // Dataset 1 (data) vars
    #ch_curr1 = [];
    #ch_curr2 = [];
    #ch_curr3 = [];
    #eq_curr1 = [];
    #eq_curr2 = [];
    #eq_curr3 = [];

    // Dataset 2 (data_ext) vars
    #price = [];
    #heat_on = [];
    #temp_in = [];
    #temp_out = [];

    async #createChart(startTimestamp, endTimestamp) {

        if (this.#chart)
            this.#chart.destroy();

        // Create the chart
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
                    title: {
                        display: true,
                        text: 'Energy and temperature data'
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
                        min: startTimestamp,
                        max: endTimestamp,
                        ticks: {
                            // Generate a tick for each hour
                            source: 'data',
                            autoSkip: true,
                            maxTicksLimit: 24,
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
                            color: 'rgba(0, 128, 128, 0.2)',  // Change grid color here
                            //tickLength: 10,  // Make grid lines 10 pixels long
                        },
                        ticks: {
                            color: 'rgba(0, 128, 128, 1)',  // Change axis values color here
                            // Include a title for the y-axis

                        },
                        title: {
                            display: true,
                            color: 'rgba(0, 128, 128, 1)',  // Change axis values color here
                            text: 'Electric Current (A)'
                        }
                    },
                    y2: {
                        position: 'right',
                        grid: {
                            //color: 'rgba(255, 0, 0, 0.2)',  // Change grid color here
                            //tickLength: 10,  // Make grid lines 10 pixels long
                        },
                        ticks: {
                            //color: 'rgba(255, 0, 0, 1)',  // Change axis values color here
                            // Include a title for the y-axis

                        },
                        title: {
                            display: true,
                            //color: 'rgba(255, 0, 0, 1)',  // Change axis values color here
                            text: 'Price (¢) / Temp (°C)'
                        }
                    }
                }
            }
        });
    }

    async #parseData(data_, startTimestamp, endTimestamp, callback) {
        return new Promise((resolve, reject) => {
            Papa.parse(data_, {
                download: true,
                header: true,
                dynamicTyping: true,
                step: (results) => {
                    const row = results.data;

                    // Only add the row to the datasets if it's within the desired time range
                    if (row['unix_time'] >= startTimestamp && row['unix_time'] <= endTimestamp) {
                        callback(row);
                    }
                },
                complete: (results) => {
                    if (results.errors.length > 0) {
                        reject(results.errors);

                    } else {
                        resolve();
                    }
                },
                error: (error) => {
                    reject(error);
                }
            });
        });
    }

    async #updateHeatOnData() {
        let lastNonNullXIndex = null;
        let maxY = this.#chart.scales['y2'].max;
        let minY = this.#chart.scales['y2'].min;

        for (let i = 0; i < this.#heat_on.length; i++) {
            if (this.#heat_on[i].y === 0)
                this.#heat_on[i].y = maxY;
            else
                this.#heat_on[i].y = minY;

            if (this.#heat_on[i].x !== null)
                lastNonNullXIndex = i;
        }
        // Append a single value at the end of the array
        if (lastNonNullXIndex !== null && this.#heat_on[lastNonNullXIndex].y === maxY) {
            const date = new Date(this.#heat_on[lastNonNullXIndex].x * 1000);
            date.setMinutes(0, 0, 0);
            date.setHours(date.getHours() + 1);
            const x_next_hour = date.getTime() / 1000;
            if (lastNonNullXIndex === this.#heat_on.length - 1) {
                //const x_next_hour = this.#heat_on[this.#heat_on.length - 1].x + 3600;
                this.#heat_on.push({ x: x_next_hour, y: this.#heat_on[this.#heat_on.length - 1].y });
            } else {
                //const x_next_hour = this.#heat_on[lastNonNullXIndex].x + 3600;
                this.#heat_on[lastNonNullXIndex + 1] = { x: x_next_hour, y: this.#heat_on[lastNonNullXIndex].y };
            }
        }
    }

    async generateChart(startDate, endDate) {

        // Initialize all the datasets to empty arrays

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

        // Convert the start and end dates to Unix timestamps
        const startTimestamp = new Date(startDate).getTime() / 1000;
        const endTimestamp = new Date(endDate).getTime() / 1000;

        try {
            await this.#parseData(data, startTimestamp, endTimestamp, (row) => {
                this.#ch_curr1.push({ x: row['unix_time'], y: row['ch_curr1'] });
                this.#ch_curr2.push({ x: row['unix_time'], y: row['ch_curr2'] });
                this.#ch_curr3.push({ x: row['unix_time'], y: row['ch_curr3'] });
                this.#eq_curr1.push({ x: row['unix_time'], y: row['eq_curr1'] });
                this.#eq_curr2.push({ x: row['unix_time'], y: row['eq_curr2'] });
                this.#eq_curr3.push({ x: row['unix_time'], y: row['eq_curr3'] });
            }).catch((error) => console.log(error));

            await this.#parseData(data_ext, startTimestamp, endTimestamp, (row) => {
                this.#price.push({ x: row['unix_time'], y: row['price'] });
                this.#heat_on.push({ x: row['unix_time'], y: row['heat_on'] });
                this.#temp_in.push({ x: row['unix_time'], y: row['temp_in'] });
                this.#temp_out.push({ x: row['unix_time'], y: row['temp_out'] });
            }).catch((error) => console.log(error));
        } catch (error) {
            console.log(error);
        }

        await this.#createChart(startTimestamp,endTimestamp);
        await this.#updateHeatOnData();

        this.#chart.update();
    }
}

// Begin execution here
(async function () {

    // Aux function to get the beginning and end of the day
    const date_lims = (startDate, endDate) => {
        let bof = new Date(startDate);
        bof.setHours(0, 0, 0, 0);
        let eod = new Date(endDate);
        eod.setDate(eod.getDate() + 1); // Add one day
        eod.setHours(0, 0, 0, 0);
        return { bof, eod };
    };

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
        let startDate = new Date(document.getElementById('dateInput').value);
        let endDate = document.getElementById('rangeCheckbox').checked
            ? new Date(document.getElementById('endDateInput').value) : new Date(startDate.getTime());
        limits = date_lims(startDate, endDate);
        chart_drawer.generateChart(limits.bof, limits.eod);
    });

    // Reset the chart data to the whole original data
    document.getElementById('showAllButton').addEventListener('click', function () {
        limits = date_lims(new Date(0), new Date());
        chart_drawer.generateChart(limits.bof, limits.eod);
    });

    // Generate the chart for the current day when the chart is first opened
    limits = date_lims(new Date(), new Date());
    chart_drawer.generateChart(limits.bof, limits.eod);
})();
