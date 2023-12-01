import Chart from 'chart.js/auto';
import Papa from 'papaparse';
import data from 'url:../workspace/easee.csv';
import data_ext from 'url:../../st-entsoe/workspace/heatoff.csv';

let chart, labels = [], heatOffTimes = [];
let ch_curr1 = [], ch_curr2 = [], ch_curr3 = [], eq_curr1 = [], eq_curr2 = [], eq_curr3 = [];

let shadedAreaData;
let maxYValue;
(async function () {
    // Parse the CSV file
    Papa.parse(data, {
        download: true,
        header: true,
        dynamicTyping: true,
        complete: function (results) {
            results.data.forEach(row => {
                labels.push(row['unix_time']);
                ch_curr1.push(row['ch_curr1']);
                ch_curr2.push(row['ch_curr2']);
                ch_curr3.push(row['ch_curr3']);
                eq_curr1.push(row['eq_curr1']);
                eq_curr2.push(row['eq_curr2']);
                eq_curr3.push(row['eq_curr3']);
            });

            // Parse the heatoff.csv file
            Papa.parse(data_ext, {
                download: true,
                header: true,
                dynamicTyping: true,
                complete: function (results) {
                    results.data.forEach(row => {
                        heatOffTimes.push(row['unix_time_heatoff']);
                    });

                    // Create the chart
                    const ctx = document.getElementById('acquisitions').getContext('2d');
                    chart = new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: labels,
                            datasets: [
                                { label: 'Charger 1', data: ch_curr1, borderColor: 'transparent', backgroundColor: 'rgba(0, 255, 255, 0.5)', fill: 'origin' },
                                { label: 'Charger 2', data: ch_curr2, borderColor: 'transparent', backgroundColor: 'rgba(255, 0, 255, 0.5)', fill: 'origin' },
                                { label: 'Charger 3', data: ch_curr3, borderColor: 'transparent', backgroundColor: 'rgba(255, 255, 0, 0.5)', fill: 'origin' },
                                { label: 'Equalizer 1', data: eq_curr1, borderColor: 'cyan', fill: false },
                                { label: 'Equalizer 2', data: eq_curr2, borderColor: 'magenta', fill: false },
                                { label: 'Equalizer 3', data: eq_curr3, borderColor: 'yellow', fill: false },
                                { label: 'Shaded Area', data: shadedAreaData, fill: 'origin', backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', pointRadius: 0 }
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
                    chart.update();

                    // After the chart has been updated, get the y-axis of the chart
                    let yAxis = chart.scales['y'];

                    // Get the maximum value of the y-axis
                    maxYValue = yAxis.max;
                    // Filter the data for the current day when the chart is first opened
                    const today = new Date().toISOString().split('T')[0];
                    filterData(today, today, maxYValue);
                }
            });
        }
    });

    // Set the default date of the date inputs to today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('dateInput').value = today;
    document.getElementById('endDateInput').value = today;

    // Add event listener to the range checkbox
    document.getElementById('rangeCheckbox').addEventListener('change', function () {
        // Show or hide the end date input based on the checkbox state
        document.getElementById('endDateInput').style.display = this.checked ? 'inline' : 'none';
    });

    function updateShadedArea(labels) {
        let filteredShadedAreaData = new Array(labels.length).fill(null);

        // Recalculate the start and end indices for the shaded area based on the filtered data
        heatOffTimes.forEach(time => {
            let timeStartOfHour = time - (time % 3600); // Round down to the start of the hour
            let timeStartOfNextHour = timeStartOfHour + 3600; // Start of the next hour
            let startIndex = labels.findIndex(label => label >= timeStartOfHour);
            let slicedLabels = labels.slice(startIndex);
            let endIndex = slicedLabels.findIndex(label => label > timeStartOfNextHour); // Change >= to >
            endIndex = endIndex === -1 ? slicedLabels.length - 1 : endIndex;
            endIndex += startIndex; // Adjust endIndex relative to the original labels array
            if (startIndex !== -1 && endIndex !== -1) {
                filteredShadedAreaData.fill(maxYValue, startIndex, endIndex); // Add 1 to endIndex
            }
        });
        return filteredShadedAreaData;
    }

    function filterData(startDate, endDate) {
        let filteredLabels = [];
        let filteredData1 = [], filteredData2 = [], filteredData3 = [], filteredData4 = [], filteredData5 = [], filteredData6 = [];
        for (let i = 0; i < labels.length; i++) {
            let date = new Date(labels[i] * 1000).toISOString().split('T')[0];
            if (date >= startDate && date <= endDate) {
                filteredLabels.push(labels[i]);
                filteredData1.push(ch_curr1[i]);
                filteredData2.push(ch_curr2[i]);
                filteredData3.push(ch_curr3[i]);
                filteredData4.push(eq_curr1[i]);
                filteredData5.push(eq_curr2[i]);
                filteredData6.push(eq_curr3[i]);
            }
        }

        // Update the chart
        chart.data.labels = filteredLabels;
        chart.data.datasets[0].data = filteredData1;
        chart.data.datasets[1].data = filteredData2;
        chart.data.datasets[2].data = filteredData3;
        chart.data.datasets[3].data = filteredData4;
        chart.data.datasets[4].data = filteredData5;
        chart.data.datasets[5].data = filteredData6;
        chart.data.datasets[6].data = updateShadedArea(filteredLabels); // Update the shaded area data
        chart.update();
    }

    // Get the selected date or date range
    document.getElementById('filterButton').addEventListener('click', function () {
        const startDate = new Date(document.getElementById('dateInput').value).toISOString().split('T')[0];
        const endDate = document.getElementById('rangeCheckbox').checked ? new Date(document.getElementById('endDateInput').value).toISOString().split('T')[0] : startDate;
        filterData(startDate, endDate);
    });

    // Reset the chart data to the original data
    document.getElementById('showAllButton').addEventListener('click', function () {
        chart.data.labels = labels;
        chart.data.datasets[0].data = ch_curr1;
        chart.data.datasets[1].data = ch_curr2;
        chart.data.datasets[2].data = ch_curr3;
        chart.data.datasets[3].data = eq_curr1;
        chart.data.datasets[4].data = eq_curr2;
        chart.data.datasets[5].data = eq_curr3;
        chart.data.datasets[6].data = updateShadedArea(filteredLabels);
        chart.update();
    });
})();
