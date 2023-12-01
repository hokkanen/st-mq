import Chart from 'chart.js/auto';
import Papa from 'papaparse';
import data from 'url:../workspace/consumption.csv';

let labels = [], chart;
let ch_curr1 = [], ch_curr2 = [], ch_curr3 = [], eq_curr1 = [], eq_curr2 = [], eq_curr3 = [];

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

            // Create the chart
            var ctx = document.getElementById('acquisitions').getContext('2d');
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        { label: 'Charger 1', data: ch_curr1, borderColor: 'cyan', backgroundColor: 'rgba(0, 255, 255, 0.5)', fill: 'origin' },
                        { label: 'Charger 2', data: ch_curr2, borderColor: 'magenta', backgroundColor: 'rgba(255, 0, 255, 0.5)', fill: 'origin' },
                        { label: 'Charger 3', data: ch_curr3, borderColor: 'yellow', backgroundColor: 'rgba(255, 255, 0, 0.5)', fill: 'origin' },
                        { label: 'Equalizer 1', data: eq_curr1, borderColor: 'cyan', fill: false },
                        { label: 'Equalizer 2', data: eq_curr2, borderColor: 'magenta', fill: false },
                        { label: 'Equalizer 3', data: eq_curr3, borderColor: 'yellow', fill: false }
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
                                title: function(context) {
                                    // Convert the Unix timestamp to a Date object and format the date
                                    var date = new Date(context[0].parsed.x * 1000).toLocaleString('en-UK');
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
                                    var date = new Date(value * 1000);
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
        }
    });

    // Set the default date of the date inputs to today
    var today = new Date().toISOString().split('T')[0];
    document.getElementById('dateInput').value = today;
    document.getElementById('endDateInput').value = today;

    // Add event listener to the range checkbox
    document.getElementById('rangeCheckbox').addEventListener('change', function () {
        // Show or hide the end date input based on the checkbox state
        document.getElementById('endDateInput').style.display = this.checked ? 'inline' : 'none';
    });

    // Add event listener to the filter button
    document.getElementById('filterButton').addEventListener('click', function () {
        // Get the selected date or date range
        var startDate = new Date(document.getElementById('dateInput').value).toISOString().split('T')[0];
        var endDate = document.getElementById('rangeCheckbox').checked ? new Date(document.getElementById('endDateInput').value).toISOString().split('T')[0] : startDate;
        // Filter the data
        var filteredLabels = [];
        var filteredData1 = [], filteredData2 = [], filteredData3 = [], filteredData4 = [], filteredData5 = [], filteredData6 = [];
        for (var i = 0; i < labels.length; i++) {
            var date = new Date(labels[i] * 1000).toISOString().split('T')[0];
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
        chart.update();
    });
})();
