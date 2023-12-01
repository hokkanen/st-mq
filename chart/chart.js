import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import data for the chart
import data from 'url:../workspace/easee.csv';

// Import data for optional shading (comment out to disable)
import data_ext from 'url:../../st-entsoe/workspace/heatoff.csv';


// ChartDrawer class
class ChartDrawer {
    constructor() {
        this.chart = null;
        this.labels = [];
        this.ch_curr1 = [];
        this.ch_curr2 = [];
        this.ch_curr3 = [];
        this.eq_curr1 = [];
        this.eq_curr2 = [];
        this.eq_curr3 = [];
        this.hourly_shade = [];
        this.max_y_val = null;
    }

    generateChart() {
        // Parse the optional background shading data
        try {
            Papa.parse(data_ext, {
                download: true,
                header: true,
                dynamicTyping: true,
                complete: (results) => {
                    // Clear the existing shading data
                    this.hourly_shade = [];

                    // Add the new shading data
                    results.data.forEach(row => {
                        this.hourly_shade.push(row['unix_time']);
                    });
                    // Update the chart
                    if (this.chart) 
                        this.chart.update();
                }
            });
        } catch {
            this.hourly_shade = [];
        }

        // Parse the main data
        Papa.parse(data, {
            download: true,
            header: true,
            dynamicTyping: true,
            complete: (results) => {
                results.data.forEach(row => {
                    this.labels.push(row['unix_time']);
                    this.ch_curr1.push(row['ch_curr1']);
                    this.ch_curr2.push(row['ch_curr2']);
                    this.ch_curr3.push(row['ch_curr3']);
                    this.eq_curr1.push(row['eq_curr1']);
                    this.eq_curr2.push(row['eq_curr2']);
                    this.eq_curr3.push(row['eq_curr3']);
                });

                // Create the chart
                const ctx = document.getElementById('acquisitions').getContext('2d');
                this.chart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: this.labels,
                        datasets: [
                            { label: 'Charger 1', data: this.ch_curr1, borderColor: 'transparent', backgroundColor: 'rgba(0, 255, 255, 0.5)', fill: 'origin' },
                            { label: 'Charger 2', data: this.ch_curr2, borderColor: 'transparent', backgroundColor: 'rgba(255, 0, 255, 0.5)', fill: 'origin' },
                            { label: 'Charger 3', data: this.ch_curr3, borderColor: 'transparent', backgroundColor: 'rgba(255, 255, 0, 0.5)', fill: 'origin' },
                            { label: 'Equalizer 1', data: this.eq_curr1, borderColor: 'cyan', fill: false },
                            { label: 'Equalizer 2', data: this.eq_curr2, borderColor: 'magenta', fill: false },
                            { label: 'Equalizer 3', data: this.eq_curr3, borderColor: 'yellow', fill: false },
                            { label: 'Heat Off', data: '', backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', fill: 'origin', pointRadius: 0 }
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
                                ticks: {
                                    // Include a title for the y-axis
                                    title: {
                                        display: true,
                                        text: 'Ampere (A)'
                                    }
                                }
                            }
                        }
                    }
                });

                // Update the chart to populate the scales object
                this.chart.update();

                // Get the maximum value of the y-axis
                this.max_y_val = this.chart.scales['y'].max;

                // Filter the data for the current day when the chart is first opened
                const today = new Date().toISOString().split('T')[0];
                this.filterData(today, today);
            }
        });
    }

    updateShadedArea(labels) {
        let ShadedAreaData = new Array(labels.length).fill(null);

        // Recalculate the start and end indices for the shaded area based on the filtered data
        this.hourly_shade.forEach(time => {
            let timeStartOfHour = time - (time % 3600); // Round down to the start of the hour
            let timeStartOfNextHour = timeStartOfHour + 3600; // Start of the next hour
            let startIndex = labels.findIndex(label => label >= timeStartOfHour);
            let slicedLabels = labels.slice(startIndex);
            let endIndex = slicedLabels.findIndex(label => label > timeStartOfNextHour); // Change >= to >
            endIndex = endIndex === -1 ? slicedLabels.length - 1 : endIndex;
            endIndex += startIndex; // Adjust endIndex relative to the original labels array
            if (startIndex !== -1 && endIndex !== -1) {
                ShadedAreaData.fill(this.max_y_val, startIndex, endIndex); // Add 1 to endIndex
            }
        });
        return ShadedAreaData;
    }

    filterData(startDate, endDate) {
        let filteredLabels = [];
        let filteredData1 = [], filteredData2 = [], filteredData3 = [], filteredData4 = [], filteredData5 = [], filteredData6 = [];
        for (let i = 0; i < this.labels.length; i++) {
            let date = new Date(this.labels[i] * 1000).toISOString().split('T')[0];
            if (date >= startDate && date <= endDate) {
                filteredLabels.push(this.labels[i]);
                filteredData1.push(this.ch_curr1[i]);
                filteredData2.push(this.ch_curr2[i]);
                filteredData3.push(this.ch_curr3[i]);
                filteredData4.push(this.eq_curr1[i]);
                filteredData5.push(this.eq_curr2[i]);
                filteredData6.push(this.eq_curr3[i]);
            }
        }
        // Update the chart's data
        this.chart.data.labels = filteredLabels;
        this.chart.data.datasets[0].data = filteredData1;
        this.chart.data.datasets[1].data = filteredData2;
        this.chart.data.datasets[2].data = filteredData3;
        this.chart.data.datasets[3].data = filteredData4;
        this.chart.data.datasets[4].data = filteredData5;
        this.chart.data.datasets[5].data = filteredData6;
        this.chart.data.datasets[6].data = this.updateShadedArea(filteredLabels); // Update the shaded area data

        // Redraw the chart
        this.chart.update();
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
        chart_drawer.filterData(startDate, endDate);
    });

    // Reset the chart data to the whole original data
    document.getElementById('showAllButton').addEventListener('click', function () {
        const startDate = new Date(0).toISOString().split('T')[0]; // Unix time = 0
        const endDate = new Date().toISOString().split('T')[0]; // Current time

        chart_drawer.filterData(startDate, endDate);
    });

    // Generate the chart
    await chart_drawer.generateChart();
})();
