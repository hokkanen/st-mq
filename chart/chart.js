import Chart from 'chart.js/auto';
import Papa from 'papaparse';

// Import easee consumption data for the chart (can be commented out)
import data_easee from 'url:/share/st-mq/easee.csv';

// Import st-mq data for the chart (can be commented out)
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
    #warm_water_pump;
    #temp_in;
    #temp_ga;
    #temp_out;

    // Initialize chart vars
    #initialize_chart() {
        if (this.#chart) this.#chart.destroy();

        this.#chart = null;
        this.#max_time_unix = -Infinity;
        this.#min_time_unix = Infinity;

        this.#ch_curr1 = [];
        this.#ch_curr2 = [];
        this.#ch_curr3 = [];
        this.#ch_total = [];
        this.#eq_curr1 = [];
        this.#eq_curr2 = [];
        this.#eq_curr3 = [];
        this.#eq_total = [];

        this.#price = [];
        this.#heat_on = [];
        this.#warm_water_pump = [];
        this.#temp_in = [];
        this.#temp_ga = [];
        this.#temp_out = [];
    }

    // Get the beginning and end of the day
    #date_lims(start_date, end_date) {
        let bod_date = new Date(start_date);
        bod_date.setHours(0, 0, 0, 0);
        let eod_date = new Date(end_date);
        eod_date.setHours(24, 1, 0, 0);
        const bod = Math.floor(bod_date.getTime() / 1000);
        const eod = Math.floor(eod_date.getTime() / 1000);
        return { bod, eod };
    }

    // Setup the chart
    async #setup_chart() {
        const ctx = document.getElementById('acquisitions').getContext('2d');
        if (!ctx) {
            document.getElementById('errorMessage').innerText = 'Error: Chart canvas not found.';
            return;
        }
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
                    { label: 'Temp Garage (°C)', yAxisID: 'y_right', data: this.#temp_ga, borderColor: 'orange', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Temp Out (°C)', yAxisID: 'y_right', data: this.#temp_out, borderColor: 'blue', borderDash: [4, 4], borderWidth: 1, fill: false, pointRadius: 1, tension: 0.4 },
                    { label: 'Heat Off', yAxisID: 'y_shading', data: this.#heat_on, backgroundColor: 'rgba(0, 255, 0, 0.1)', borderColor: 'rgba(0, 255, 0, 0)', fill: 'start', pointRadius: 0, stepped: 'before', skipNull: true },
                    { label: 'Warm Water Pump', yAxisID: 'y_shading', data: this.#warm_water_pump, backgroundColor: 'rgba(255, 165, 0, 0.15)', borderColor: 'rgba(255, 165, 0, 0)', fill: 'start', pointRadius: 0, stepped: 'before', skipNull: true }
                ]
            },
            options: {
                normalized: false,
                parsing: false,
                responsive: true,
                plugins: {
                    decimation: {
                        enabled: true,
                        algorithm: 'lttb',
                        samples: 576,
                        threshold: 576
                    },
                    title: {
                        display: true,
                        text: 'Home Monitor Chart'
                    },
                    tooltip: {
                        callbacks: {
                            title: function (context) {
                                return new Date(context[0].parsed.x * 1000).toLocaleString('en-UK');
                            }
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
                            callback: function (value) {
                                const date = new Date(value * 1000);
                                const date_string = date.toLocaleDateString('en-UK');
                                const time_string = date.toLocaleTimeString('en-UK', { hour: '2-digit', minute: '2-digit' });
                                return time_string === '00:00' ? `${date_string} ${time_string}` : time_string;
                            }
                        }
                    },
                    y_left: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255, 0, 0, 0.2)' },
                        ticks: { color: 'rgba(255, 0, 0, 1)' },
                        title: { display: true, color: 'rgba(255, 0, 0, 1)', text: 'Power (kW) / Current (A)' }
                    },
                    y_right: {
                        position: 'right',
                        title: { display: true, text: 'Price (¢/kWh) / Temp (°C)' }
                    },
                    y_shading: {
                        display: false // Hidden axis for shading datasets
                    }
                }
            }
        });
    }

    // Update the heat_on and warm_water_pump datasets
    async #update_shading_data() {
        const max_y = this.#chart.scales['y_right'].max;
        const min_y = this.#chart.scales['y_right'].min;

        // Update Heat Off shading
        let last_non_null_index_heat = null;
        for (let i = 0; i < this.#heat_on.length; i++) {
            if (this.#heat_on[i].y === 0) {
                this.#heat_on[i].y = max_y;
            } else {
                this.#heat_on[i].y = min_y;
            }
            if (this.#heat_on[i].x !== null) {
                last_non_null_index_heat = i;
            }
        }
        if (last_non_null_index_heat !== null && this.#heat_on[last_non_null_index_heat].y === max_y) {
            const date = new Date(this.#heat_on[last_non_null_index_heat].x * 1000);
            date.setMinutes(0, 0, 0);
            date.setHours(date.getHours() + 1);
            const x_next_hour = date.getTime() / 1000;
            if (last_non_null_index_heat === this.#heat_on.length - 1) {
                this.#heat_on.push({ x: x_next_hour, y: max_y });
            } else {
                this.#heat_on[last_non_null_index_heat + 1] = { x: x_next_hour, y: max_y };
            }
        }

        // Update Warm Water Pump shading
        for (let i = 0; i < this.#warm_water_pump.length; i++) {
            if (this.#warm_water_pump[i].y === 60) {
                this.#warm_water_pump[i].y = max_y;
                const end_time = this.#warm_water_pump[i].x + 15 * 60; // 15 minutes later
                if (i + 1 < this.#warm_water_pump.length) {
                    this.#warm_water_pump[i + 1] = { x: end_time, y: min_y };
                } else {
                    this.#warm_water_pump.push({ x: end_time, y: min_y });
                }
            } else {
                this.#warm_water_pump[i].y = min_y;
            }
        }
    }

    // Parse data using PapaParse
    async #parse_data(data, start_time_unix, end_time_unix, callback) {
        return new Promise((resolve, reject) => {
            let max_time = -Infinity;
            let min_time = Infinity;

            Papa.parse(data, {
                download: true,
                header: true,
                dynamicTyping: true,
                step: (results) => {
                    const row = results.data;
                    if (row['unix_time'] >= start_time_unix && row['unix_time'] < end_time_unix) {
                        callback(row);
                        if (row['unix_time'] !== null) {
                            min_time = Math.min(min_time, row['unix_time']);
                            max_time = Math.max(max_time, row['unix_time']);
                        }
                    }
                },
                complete: (results) => {
                    if (results.errors.length > 0) reject(results.errors);
                    else {
                        const time_limits = this.#date_lims(new Date(min_time * 1000), new Date((max_time - 60) * 1000));
                        this.#min_time_unix = Math.min(this.#min_time_unix, time_limits.bod);
                        this.#max_time_unix = Math.max(this.#max_time_unix, time_limits.eod - 60);
                        resolve();
                    }
                },
                error: (error) => reject(error)
            });
        });
    }

    // Compare realized cost (€) vs reference cost (daily average)
    async #perform_cost_analysis() {
        let realized_cost_ch = 0;
        let realized_cost_eq = 0;
        let reference_cost_ch = 0;
        let reference_cost_eq = 0;
        if (this.#price.length > 1) {
            let day = Math.floor((this.#price[0].x + 3600) / 86400);
            let average_kwh_price_24h = 0;
            let reference_kwh_ch_24h = 0;
            let reference_kwh_eq_24h = 0;
            let total_hours = 0;
            let j = 0;
            for (let i = 0; i < this.#price.length - 1; i++) {
                let ch_kw = 0;
                let eq_kw = 0;
                let n_kw_datapoints = 0;
                while (j < this.#eq_total.length && this.#eq_total[j].x < this.#price[i + 1].x) {
                    if (this.#eq_total[j].x > this.#price[i].x) {
                        ch_kw += this.#ch_total[j].y;
                        eq_kw += this.#eq_total[j].y;
                        n_kw_datapoints += 1;
                    }
                    j++;
                }
                const hour_weight = (this.#price[i + 1].x - this.#price[i].x) / 3600;
                total_hours += hour_weight;
                const hourly_kwh_ch = n_kw_datapoints > 0 ? (ch_kw / n_kw_datapoints) * hour_weight : 0;
                const hourly_kwh_eq = n_kw_datapoints > 0 ? (eq_kw / n_kw_datapoints) * hour_weight : 0;
                reference_kwh_ch_24h += hourly_kwh_ch;
                reference_kwh_eq_24h += hourly_kwh_eq;
                average_kwh_price_24h += this.#price[i].y / 100 * hour_weight;
                if (Math.floor((this.#price[i + 1].x + 3600) / 86400) !== day || i === this.#price.length - 2) {
                    if (total_hours > 0) {
                        average_kwh_price_24h /= total_hours;
                    } else {
                        average_kwh_price_24h = 0;
                    }
                    reference_cost_ch += average_kwh_price_24h * reference_kwh_ch_24h;
                    reference_cost_eq += average_kwh_price_24h * reference_kwh_eq_24h;
                    average_kwh_price_24h = 0;
                    reference_kwh_ch_24h = 0;
                    reference_kwh_eq_24h = 0;
                    total_hours = 0;
                    day = Math.floor((this.#price[i + 1].x + 3600) / 86400);
                }
                realized_cost_ch += hourly_kwh_ch * this.#price[i].y / 100;
                realized_cost_eq += hourly_kwh_eq * this.#price[i].y / 100;
            }
        }
        const costs_vat0 = {
            realized_cost_ch,
            realized_cost_eq,
            reference_cost_ch,
            reference_cost_eq,
            savings_without_ch: (reference_cost_eq - reference_cost_ch) - (realized_cost_eq - realized_cost_ch)
        };
        const costs_vat25_5 = Object.fromEntries(
            Object.entries(costs_vat0).map(([key, value]) => [
                key === 'savings_without_ch' ? key : key.replace('cost', 'vat25_5'),
                value * 1.255
            ])
        );
        console.log(costs_vat0);
        console.log(costs_vat25_5);
        return costs_vat0;
    }

    // Generate the chart
    async generate_chart(start_date, end_date) {
        const loadingIndicator = document.getElementById('loadingIndicator');
        const errorMessage = document.getElementById('errorMessage');
        if (!loadingIndicator || !errorMessage) {
            console.error('Error: Loading indicator or error message element not found in DOM.');
            return;
        }

        loadingIndicator.style.display = 'block';
        errorMessage.innerText = '';
        this.#initialize_chart();
        const limits = this.#date_lims(start_date, end_date);
        const start_time_unix = limits.bod;
        const end_time_unix = limits.eod;

        const [easee_result, st_result] = await Promise.allSettled([
            this.#parse_data(data_easee, start_time_unix, end_time_unix, (row) => {
                if (!isNaN(row['ch_curr1'])) this.#ch_curr1.push({ x: row['unix_time'], y: row['ch_curr1'] });
                if (!isNaN(row['ch_curr2'])) this.#ch_curr2.push({ x: row['unix_time'], y: row['ch_curr2'] });
                if (!isNaN(row['ch_curr3'])) this.#ch_curr3.push({ x: row['unix_time'], y: row['ch_curr3'] });
                if (!isNaN(row['ch_curr1']) && !isNaN(row['ch_curr2']) && !isNaN(row['ch_curr3'])) {
                    this.#ch_total.push({ x: row['unix_time'], y: VOLTAGE * (row['ch_curr1'] + row['ch_curr2'] + row['ch_curr3']) / 1000 });
                }
                if (!isNaN(row['eq_curr1'])) this.#eq_curr1.push({ x: row['unix_time'], y: row['eq_curr1'] });
                if (!isNaN(row['eq_curr2'])) this.#eq_curr2.push({ x: row['unix_time'], y: row['eq_curr2'] });
                if (!isNaN(row['eq_curr3'])) this.#eq_curr3.push({ x: row['unix_time'], y: row['eq_curr3'] });
                if (!isNaN(row['eq_curr1']) && !isNaN(row['eq_curr2']) && !isNaN(row['eq_curr3'])) {
                    this.#eq_total.push({ x: row['unix_time'], y: VOLTAGE * (row['eq_curr1'] + row['eq_curr2'] + row['eq_curr3']) / 1000 });
                }
            }),
            this.#parse_data(data_st, start_time_unix, end_time_unix, (row) => {
                if (!isNaN(row['price'])) this.#price.push({ x: row['unix_time'], y: row['price'] });
                if (!isNaN(row['heat_on'])) {
                    this.#heat_on.push({ x: row['unix_time'], y: row['heat_on'] });
                    this.#warm_water_pump.push({ x: row['unix_time'], y: row['heat_on'] });
                }
                if (!isNaN(row['temp_in'])) this.#temp_in.push({ x: row['unix_time'], y: row['temp_in'] });
                if (!isNaN(row['temp_ga'])) this.#temp_ga.push({ x: row['unix_time'], y: row['temp_ga'] });
                if (!isNaN(row['temp_out'])) this.#temp_out.push({ x: row['unix_time'], y: row['temp_out'] });
            })
        ]);

        if (easee_result.status === 'rejected') {
            console.log('Error parsing Easee data:', easee_result.reason);
            errorMessage.innerText += 'Error loading Easee data: ' + easee_result.reason.message + '\n';
        }

        if (st_result.status === 'rejected') {
            console.log('Error parsing ST data:', st_result.reason);
            errorMessage.innerText += 'Error loading ST data: ' + st_result.reason.message + '\n';
        }

        if (
            this.#ch_curr1.length === 0 &&
            this.#ch_curr2.length === 0 &&
            this.#ch_curr3.length === 0 &&
            this.#eq_curr1.length === 0 &&
            this.#eq_curr2.length === 0 &&
            this.#eq_curr3.length === 0 &&
            this.#price.length === 0 &&
            this.#heat_on.length === 0 &&
            this.#temp_in.length === 0 &&
            this.#temp_ga.length === 0 &&
            this.#temp_out.length === 0
        ) {
            errorMessage.innerText = 'No data available for the selected period.';
            loadingIndicator.style.display = 'none';
            return;
        }

        await this.#setup_chart();
        if (this.#chart) {
            await this.#update_shading_data();
            await this.#perform_cost_analysis();
            await this.apply_action(this.get_actions()[0]);
        }
        loadingIndicator.style.display = 'none';
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
            }
        ];
    }

    // Apply the action
    async apply_action(action) {
        action.handler.call(this);
    }
}

// Begin execution
(async function () {
    const chart_drawer = new ChartDrawer();
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('dateInput').value = today;
    document.getElementById('endDateInput').value = today;

    document.getElementById('rangeCheckbox').addEventListener('change', function () {
        document.getElementById('endDateInput').style.display = this.checked ? 'inline' : 'none';
    });

    document.getElementById('filterButton').addEventListener('click', function () {
        let start_date = new Date(document.getElementById('dateInput').value);
        let end_date = document.getElementById('rangeCheckbox').checked
            ? new Date(document.getElementById('endDateInput').value)
            : new Date(start_date.getTime());
        chart_drawer.generate_chart(start_date, end_date);
    });

    document.getElementById('showAllButton').addEventListener('click', function () {
        chart_drawer.generate_chart(new Date(0), new Date());
    });

    const chartActions = document.getElementById('chartActions');
    chart_drawer.get_actions().forEach(action => {
        const button = document.createElement('button');
        button.innerText = action.name;
        button.addEventListener('click', () => chart_drawer.apply_action(action));
        chartActions.appendChild(button);
    });

    chart_drawer.generate_chart(new Date(), new Date());
})();