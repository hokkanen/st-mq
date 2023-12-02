import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import data for the chart
import data from 'url:../workspace/easee.csv';

// Import data for optional shading (comment out to disable)
import data_ext from 'url:../workspace/st-entsoe.csv';


// ChartDrawer class
class ChartDrawer {
    constructor() {
        this.chart = null;

        // Dataset 1 (data)
        this.x1_labels = [];
        this.ch_curr1 = [];
        this.ch_curr2 = [];
        this.ch_curr3 = [];
        this.eq_curr1 = [];
        this.eq_curr2 = [];
        this.eq_curr3 = [];

        // Dataset 2 (data_ext)
        this.x2_labels = [];
        this.price = [];
        this.heat_on = [];
        this.temp_in = [];
        this.temp_out = [];
        this.maxY = null;
    }

    createChart() {

        if (this.chart) {
            this.chart.destroy();
        }
        // Create the chart
        const ctx = document.getElementById('acquisitions').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    { label: 'Charger 1', data: this.ch_curr1, borderColor: 'transparent', backgroundColor: 'rgba(0, 255, 255, 0.5)', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger 2', data: this.ch_curr2, borderColor: 'transparent', backgroundColor: 'rgba(255, 0, 255, 0.5)', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Charger 3', data: this.ch_curr3, borderColor: 'transparent', backgroundColor: 'rgba(255, 255, 0, 0.5)', fill: 'origin', pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 1', data: this.eq_curr1, borderColor: 'cyan', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 2', data: this.eq_curr2, borderColor: 'magenta', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Equalizer 3', data: this.eq_curr3, borderColor: 'yellow', borderWidth: 1, fill: false, pointRadius: 0, stepped: 'middle' },
                    { label: 'Price', data: this.price, yAxisID: 'y2', borderColor: 'black', borderDash: [1, 3], borderWidth: 1, fill: false, pointRadius: 1, stepped: 'before' },
                    { label: 'Temp In', data: this.temp_in, yAxisID: 'y2', borderColor: 'green', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Temp Out', data: this.temp_out, yAxisID: 'y2', borderColor: 'blue', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Heat Off', data: this.heat_on, yAxisID: 'y2', backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', fill: 'start', pointRadius: 0 }
                ]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: 'Current flow by phase (A)'
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
                        ticks: {
                            // Include a callback function that formats the label
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
                            text: 'Price (¢) / Temp (°C)'
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

    async parseData(data, startTimestamp, endTimestamp, callback) {
        return new Promise((resolve, reject) => {
            Papa.parse(data, {
                download: true,
                header: true,
                dynamicTyping: true,
                step: (results) => {
                    const row = results.data;
                    const timestamp = row['unix_time'];
    
                    // Only add the row to the datasets if it's within the desired time range
                    if (timestamp >= startTimestamp && timestamp <= endTimestamp) {
                        callback(row, timestamp);
                    }
                },
                complete: resolve,
                error: reject
            });
        });
    }

    updateHeatOnData() {
        for (let i = 0; i < this.heat_on.length; i++) {
            if (this.heat_on[i].y === 10) {
                this.heat_on[i].y = this.maxY;
            }
        }
    }

    async generateChart(startDate, endDate) {


        // Convert the start and end dates to Unix timestamps
        const startTimestamp = new Date(startDate).getTime() / 1000;
        const endTimestamp = new Date(endDate).getTime() / 1000;

        try {
            await this.parseData(data, startTimestamp, endTimestamp, (row, timestamp) => {
                this.ch_curr1.push({ x: timestamp, y: row['ch_curr1'] });
                this.ch_curr2.push({ x: timestamp, y: row['ch_curr2'] });
                this.ch_curr3.push({ x: timestamp, y: row['ch_curr3'] });
                this.eq_curr1.push({ x: timestamp, y: row['eq_curr1'] });
                this.eq_curr2.push({ x: timestamp, y: row['eq_curr2'] });
                this.eq_curr3.push({ x: timestamp, y: row['eq_curr3'] });
            });

            
            await this.parseData(data_ext, startTimestamp, endTimestamp, (row, timestamp) => {
                this.price.push({ x: row['unix_time'], y: row['price'] });
                this.heat_on.push({ x: row['unix_time'], y: row['heat_on'] === '0' ? null : 10 });
                this.temp_in.push({ x: row['unix_time'], y: row['temp_in'] });
                this.temp_out.push({ x: row['unix_time'], y: row['temp_out'] });
            });
            
            this.createChart();
            
                            this.maxY = this.chart.scales['y2'].max;
                            console.log(this.maxY);
                            this.updateHeatOnData();
    
            this.chart.update();
        }





        // Update the chart to populate the scales object
        //  this.chart.update();

        // Get the maximum value of the y-axis
        //   this.max_y_val = this.chart.scales['y'].max;

        // Filter the data for the current day when the chart is first opened
        //const today = new Date().toISOString().split('T')[0];
        //  this.filterData(today, today);
    }


    getChart() {
        return this.chart;
    }
}

// Begin execution here
(async function () {

    // Instantiate the class
    const chart_drawer = new ChartDrawer(data, data_ext);

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
        const startDate = new Date(document.getElementById('dateInput').value).toISOString().split('T')[0];
        const endDate = document.getElementById('rangeCheckbox').checked ? new Date(document.getElementById('endDateInput').value).toISOString().split('T')[0] : startDate;
        chart_drawer.generateChart(startDate, endDate);
    });

    // Reset the chart data to the whole original data
    document.getElementById('showAllButton').addEventListener('click', function () {
        const startDate = new Date(0).toISOString().split('T')[0]; // Unix time = 0
        const endDate = new Date().toISOString().split('T')[0]; // Current time

        chart_drawer.generateChart(startDate, endDate);
    });

    // Generate the chart for the current day when the chart is first opened
    const startDate = new Date(0).toISOString().split('T')[0]; // Unix time = 0
    const endDate = new Date().toISOString().split('T')[0]; // Current time
    await chart_drawer.generateChart(startDate, endDate);
})();
