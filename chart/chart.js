import Chart from 'chart.js/auto';
import Papa from 'papaparse';
import data from 'url:../workspace/consumption.csv';

var labels = [], ch_curr1 = [], chart;

(async function () {
    // Parse the CSV file
    Papa.parse(data, {
        download: true,
        header: true,
        dynamicTyping: true,
        complete: function (results) {
            var ch_curr2 = [], ch_curr3 = [], eq_curr1 = [], eq_curr2 = [], eq_curr3 = [];
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
                        { label: 'Charger 1', data: ch_curr1, borderColor: 'red', backgroundColor: 'rgba(255, 0, 0, 0.5)', fill: 'origin' },
                        { label: 'Charger 2', data: ch_curr2, borderColor: 'green', backgroundColor: 'rgba(0, 255, 0, 0.5)', fill: 'origin' },
                        { label: 'Charger 3', data: ch_curr3, borderColor: 'blue', backgroundColor: 'rgba(0, 0, 255, 0.5)', fill: 'origin' },
                        { label: 'Equalizer 1', data: eq_curr1, borderColor: 'red', fill: false },
                        { label: 'Equalizer 2', data: eq_curr2, borderColor: 'green', fill: false },
                        { label: 'Equalizer 3', data: eq_curr3, borderColor: 'blue', fill: false }
                    ]
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Current flow by phase (A)'
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
        var filteredData = [];
        for (var i = 0; i < labels.length; i++) {
            var date = new Date(labels[i] * 1000).toISOString().split('T')[0];
            if (date >= startDate && date <= endDate) {
                filteredLabels.push(labels[i]);
                filteredData.push(ch_curr1[i]); // Replace with the appropriate data array
            }
        }
        // Update the chart
        chart.data.labels = filteredLabels;
        chart.data.datasets[0].data = filteredData;
        chart.update();
    });
})();