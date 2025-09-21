import Chart from 'chart.js/auto';
import { loadEaseeData, loadStData, prefetchFullData } from './data-processor.js';
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
  // Button refs
  #totalBtn;
  #phasesBtn;
  #allStBtn;
  // Update chart theme based on dark mode
  updateTheme(isDark) {
    if (!this.#chart) return;
    const opts = this.#chart.options.scales;
    opts.x.grid.color = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    opts.x.ticks.color = isDark ? '#e0e0e0' : '#666666';
    opts.y_left.grid.color = isDark ? 'rgba(255, 0, 0, 0.1)' : 'rgba(255, 0, 0, 0.2)';
    opts.y_left.ticks.color = isDark ? 'rgba(255, 0, 0, 0.9)' : 'rgba(255, 0, 0, 1)';
    opts.y_left.title.color = isDark ? 'rgba(255, 0, 0, 0.9)' : 'rgba(255, 0, 0, 1)';
    opts.y_right.grid.color = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    opts.y_right.ticks.color = isDark ? '#e0e0e0' : '#666666';
    opts.y_right.title.color = isDark ? '#e0e0e0' : '#666666';
    const priceDataset = this.#chart.data.datasets[8];
    const priceColor = isDark ? 'white' : 'black';
    priceDataset.borderColor = priceColor;
    priceDataset.pointBackgroundColor = priceColor;
    priceDataset.pointBorderColor = priceColor;
    this.#chart.update();
  }
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
    const isDark = document.body.classList.contains('dark');
    const xGridColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const xTicksColor = isDark ? '#e0e0e0' : '#666666';
    const yLeftGridColor = isDark ? 'rgba(255, 0, 0, 0.1)' : 'rgba(255, 0, 0, 0.2)';
    const yLeftTicksColor = isDark ? 'rgba(255, 0, 0, 0.9)' : 'rgba(255, 0, 0, 1)';
    const yLeftTitleColor = isDark ? 'rgba(255, 0, 0, 0.9)' : 'rgba(255, 0, 0, 1)';
    const yRightGridColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const yRightTicksColor = isDark ? '#e0e0e0' : '#666666';
    const yRightTitleColor = isDark ? '#e0e0e0' : '#666666';
    const priceColor = isDark ? 'white' : 'black';
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
          { label: 'Price (¢/kWh)', yAxisID: 'y_right', data: this.#price, borderColor: priceColor, pointBackgroundColor: priceColor, pointBorderColor: priceColor, borderDash: [1, 3], borderWidth: 1, fill: false, pointRadius: 1, stepped: 'before' },
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
        maintainAspectRatio: false,
        plugins: {
          decimation: {
            enabled: true,
            algorithm: 'lttb',
            samples: 576,
            threshold: 576
          },
          title: {
            display: false
          },
          legend: {
            onClick: (e, legendItem, legend) => {
              Chart.defaults.plugins.legend.onClick.call(legend.chart, e, legendItem, legend);
              this.updateButtonStates();
            }
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
            grid: {
              color: xGridColor
            },
            ticks: {
              source: 'data',
              autoSkip: true,
              stepSize: (this.#max_time_unix - this.#min_time_unix) / 24,
              color: xTicksColor,
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
            grid: { color: yLeftGridColor },
            ticks: { color: yLeftTicksColor },
            title: { display: true, color: yLeftTitleColor, text: 'Power (kW) / Current (A)' }
          },
          y_right: {
            position: 'right',
            grid: { color: yRightGridColor },
            ticks: { color: yRightTicksColor },
            title: { display: true, color: yRightTitleColor, text: 'Price (¢/kWh) / Temp (°C)' }
          },
          y_shading: {
            display: false,
            min: 0,
            max: 1
          }
        }
      }
    });
  }
  // Update the heat_on and warm_water_pump datasets
  async #update_shading_data() {
    const max_y = this.#chart.scales['y_shading'].max;
    const min_y = this.#chart.scales['y_shading'].min;
    // Update Heat Off shading
    let has_heat_off = false;
    for (let i = 0; i < this.#heat_on.length; i++) {
      if (this.#heat_on[i].y === 0) {
        this.#heat_on[i].y = max_y;
        has_heat_off = true;
      } else {
        this.#heat_on[i].y = min_y;
      }
    }
    // Hide Heat Off dataset if no heat_off state
    this.#chart.data.datasets[12].hidden = !has_heat_off;
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
    this.#chart.update();
  }
  // Show total kW datasets and hide per-phase datasets
  showTotal() {
    if (!this.#chart || !this.#chart.data || !this.#chart.data.datasets) return;
    const ds = this.#chart.data.datasets;
    for (let i = 0; i < 8; i++) ds[i].hidden = ![3, 7].includes(i);
    this.#chart.update();
  }
  // Show individual phase datasets and hide total kW datasets
  showPhases() {
    if (!this.#chart || !this.#chart.data || !this.#chart.data.datasets) return;
    const ds = this.#chart.data.datasets;
    for (let i = 0; i < 8; i++) ds[i].hidden = [3, 7].includes(i);
    this.#chart.update();
  }
  // Toggle total power datasets
  toggleTotal() {
    if (!this.#chart || !this.#chart.data || !this.#chart.data.datasets) return;
    const ds = this.#chart.data.datasets;
    const totalIndices = [3, 7];
    const phasesIndices = [0, 1, 2, 4, 5, 6];
    const anyVisible = totalIndices.some(i => !ds[i].hidden);
    if (anyVisible) {
      totalIndices.forEach(i => ds[i].hidden = true);
    } else {
      totalIndices.forEach(i => ds[i].hidden = false);
      phasesIndices.forEach(i => ds[i].hidden = true);
    }
    this.#chart.update();
    this.updateButtonStates();
  }
  // Toggle individual phases datasets
  togglePhases() {
    if (!this.#chart || !this.#chart.data || !this.#chart.data.datasets) return;
    const ds = this.#chart.data.datasets;
    const phasesIndices = [0, 1, 2, 4, 5, 6];
    const totalIndices = [3, 7];
    const anyVisible = phasesIndices.some(i => !ds[i].hidden);
    if (anyVisible) {
      phasesIndices.forEach(i => ds[i].hidden = true);
    } else {
      phasesIndices.forEach(i => ds[i].hidden = false);
      totalIndices.forEach(i => ds[i].hidden = true);
    }
    this.#chart.update();
    this.updateButtonStates();
  }
  // Toggle all ST-MQ datasets
  toggleAllSt() {
    if (!this.#chart || !this.#chart.data || !this.#chart.data.datasets) return;
    const ds = this.#chart.data.datasets;
    const stIndices = [8, 9, 10, 11, 12, 13];
    const anyVisible = stIndices.some(i => !ds[i].hidden);
    stIndices.forEach(i => ds[i].hidden = anyVisible);
    this.#chart.update();
    this.updateButtonStates();
  }
  // Update button states based on dataset visibility
  updateButtonStates() {
    if (!this.#chart || !this.#chart.data || !this.#chart.data.datasets) return;
    const ds = this.#chart.data.datasets;
    // Total power
    const anyTotal = [3, 7].some(i => !ds[i].hidden);
    if (this.#totalBtn) this.#totalBtn.style.textDecoration = anyTotal ? 'none' : 'line-through';
    // Individual phases
    const anyPhases = [0, 1, 2, 4, 5, 6].some(i => !ds[i].hidden);
    if (this.#phasesBtn) this.#phasesBtn.style.textDecoration = anyPhases ? 'none' : 'line-through';
    // All ST-MQ
    const anySt = [8, 9, 10, 11, 12, 13].some(i => !ds[i].hidden);
    if (this.#allStBtn) this.#allStBtn.style.textDecoration = anySt ? 'none' : 'line-through';
  }
  // Create Easee buttons
  createEaseeButtons(container) {
    const totalBtn = document.createElement('button');
    totalBtn.innerText = 'Total power (kW)';
    totalBtn.addEventListener('click', () => this.toggleTotal());
    this.#totalBtn = totalBtn;
    container.appendChild(totalBtn);

    const phasesBtn = document.createElement('button');
    phasesBtn.innerText = 'Individual phases (A)';
    phasesBtn.addEventListener('click', () => this.togglePhases());
    this.#phasesBtn = phasesBtn;
    container.appendChild(phasesBtn);
  }
  // Create ST-MQ button
  createStmqButton(container) {
    const allStBtn = document.createElement('button');
    allStBtn.innerText = 'All datasets';
    allStBtn.addEventListener('click', () => this.toggleAllSt());
    this.#allStBtn = allStBtn;
    container.appendChild(allStBtn);
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
    console.log(`Cost Analysis finished at: ${new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}`);
    console.log('Cost Analysis Results (VAT 0%):', costs_vat0);
    console.log('Cost Analysis Results (VAT 25.5%):', costs_vat25_5);
    return costs_vat0;
  }
  // Generate the chart
  async generate_chart(start_date, end_date) {
    const loadingIndicator = document.getElementById('loadingIndicator');
    const chartWrapper = document.querySelector('.chart-wrapper');
    const chartTitle = document.getElementById('chartTitle');
    if (!loadingIndicator || !chartWrapper || !chartTitle) {
      console.error('Error: Required elements not found in DOM.');
      return;
    }
    const startTime = Date.now();
    loadingIndicator.style.display = 'block';
    loadingIndicator.innerText = 'Loading...';
    loadingIndicator.style.color = 'var(--text-color)';
    chartWrapper.style.position = 'relative';
    this.#initialize_chart();
    const limits = this.#date_lims(start_date, end_date);
    const start_time_unix = limits.bod;
    const end_time_unix = limits.eod;
    let otherCriticalErrors = [];
    const ctxElement = document.getElementById('acquisitions');
    if (!ctxElement || !ctxElement.getContext('2d')) {
      otherCriticalErrors.push('Chart canvas not found.');
    }
    // Load data from processor
    const [easee_result, st_result] = await Promise.all([
      loadEaseeData(start_time_unix, end_time_unix),
      loadStData(start_time_unix, end_time_unix)
    ]);
    const easeeErrorType = easee_result.error?.type || null;
    const stErrorType = st_result.error?.type || null;
    const hasEaseeData = !easee_result.error;
    const hasStData = !st_result.error;
    if (hasEaseeData) {
      this.#ch_curr1 = easee_result.data.ch_curr1;
      this.#ch_curr2 = easee_result.data.ch_curr2;
      this.#ch_curr3 = easee_result.data.ch_curr3;
      this.#ch_total = easee_result.data.ch_total;
      this.#eq_curr1 = easee_result.data.eq_curr1;
      this.#eq_curr2 = easee_result.data.eq_curr2;
      this.#eq_curr3 = easee_result.data.eq_curr3;
      this.#eq_total = easee_result.data.eq_total;
    }
    if (hasStData) {
      this.#price = st_result.data.price;
      // Deep copy for heat_on to ensure independent objects
      this.#heat_on = st_result.data.heat_on_raw.map(point => ({ x: point.x, y: point.y }));
      // Deep copy for warm_water_pump to ensure independent objects
      this.#warm_water_pump = st_result.data.heat_on_raw.map(point => ({ x: point.x, y: point.y }));
      this.#temp_in = st_result.data.temp_in;
      this.#temp_ga = st_result.data.temp_ga;
      this.#temp_out = st_result.data.temp_out;
    }
    this.#min_time_unix = Infinity;
    this.#max_time_unix = -Infinity;
    if (hasEaseeData && easee_result.min_time_unix !== null) {
      this.#min_time_unix = Math.min(this.#min_time_unix, easee_result.min_time_unix);
      this.#max_time_unix = Math.max(this.#max_time_unix, easee_result.max_time_unix);
    }
    if (hasStData && st_result.min_time_unix !== null) {
      this.#min_time_unix = Math.min(this.#min_time_unix, st_result.min_time_unix);
      this.#max_time_unix = Math.max(this.#max_time_unix, st_result.max_time_unix);
    }
    if (this.#min_time_unix === Infinity) {
      this.#min_time_unix = start_time_unix;
      this.#max_time_unix = end_time_unix - 60;
    }
    // Set up dataset controls
    const easeeActions = document.getElementById('easeeActions');
    const stmqActions = document.getElementById('stmqActions');
    const easeeSection = document.querySelector('.easee-section');
    const stmqSection = document.querySelector('.stmq-section');
    const easeeTitle = document.querySelector('.easee-title');
    const stmqTitle = document.querySelector('.stmq-title');
    easeeActions.innerHTML = '';
    stmqActions.innerHTML = '';
    if (easee_result.error) {
      const msgP = document.createElement('p');
      msgP.className = 'dataset-message';
      msgP.innerText = easee_result.error.message;
      easeeActions.appendChild(msgP);
      if (easeeErrorType === 'hasNoValidData') {
        const otherUnavailable = !!st_result.error;
        const color = otherUnavailable ? 'error' : 'warning';
        easeeSection.style.borderColor = `var(--${color}-color)`;
        msgP.style.color = `var(--${color}-color)`;
        easeeTitle.style.color = `var(--${color}-color)`;
      } else {
        easeeSection.style.borderColor = 'var(--border-color)';
        msgP.style.color = 'var(--text-color)';
        easeeTitle.style.color = 'var(--text-color)';
      }
    } else {
      this.createEaseeButtons(easeeActions);
      easeeSection.style.borderColor = 'var(--border-color)';
      easeeTitle.style.color = 'var(--text-color)';
    }
    if (st_result.error) {
      const msgP = document.createElement('p');
      msgP.className = 'dataset-message';
      msgP.innerText = st_result.error.message;
      stmqActions.appendChild(msgP);
      if (stErrorType === 'hasNoValidData') {
        const otherUnavailable = !!easee_result.error;
        const color = otherUnavailable ? 'error' : 'warning';
        stmqSection.style.borderColor = `var(--${color}-color)`;
        msgP.style.color = `var(--${color}-color)`;
        stmqTitle.style.color = `var(--${color}-color)`;
      } else {
        stmqSection.style.borderColor = 'var(--border-color)';
        msgP.style.color = 'var(--text-color)';
        stmqTitle.style.color = 'var(--text-color)';
      }
    } else {
      this.createStmqButton(stmqActions);
      stmqSection.style.borderColor = 'var(--border-color)';
      stmqTitle.style.color = 'var(--text-color)';
    }
    // Chart messages and colors
    let chartMessages = [];
    if (easeeErrorType === 'hasNoValidData') {
      chartMessages.push('No Easee data');
    }
    if (stErrorType === 'hasNoValidData') {
      chartMessages.push('No ST-MQ data');
    }
    if (!hasEaseeData && !hasStData) {
      chartMessages.push('No data available for the selected period');
    }
    const numErrors = (easee_result.error ? 1 : 0) + (st_result.error ? 1 : 0);
    const allMessages = [...chartMessages, ...otherCriticalErrors];
    loadingIndicator.style.display = 'none';
    if (allMessages.length > 0) {
      chartTitle.innerText = allMessages.join('; ');
      if (otherCriticalErrors.length > 0) {
        chartTitle.style.color = 'var(--error-color)';
        chartWrapper.style.borderColor = 'var(--error-color)';
      } else {
        const colorKey = numErrors > 0 ? (numErrors === 2 ? 'error' : 'warning') : 'text';
        const borderKey = numErrors > 0 ? (numErrors === 2 ? 'error' : 'warning') : 'border';
        chartTitle.style.color = `var(--${colorKey}-color)`;
        chartWrapper.style.borderColor = `var(--${borderKey}-color)`;
      }
      if (otherCriticalErrors.length > 0 || (!hasEaseeData && !hasStData)) {
        console.log('Chart rendering aborted: Critical Errors');
        return;
      }
    } else {
      chartTitle.innerText = 'Home Monitor Chart';
      chartTitle.style.color = 'var(--text-color)';
      chartWrapper.style.borderColor = 'var(--border-color)';
    }
    await this.#setup_chart();
    if (this.#chart) {
      await this.#update_shading_data();
      this.showTotal();
      this.updateButtonStates();
      const endTime = Date.now();
      const renderingTime = (endTime - startTime).toFixed(3);
      console.log(`Chart rendered at: ${new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })} in ${renderingTime} ms`);
      requestAnimationFrame(() => {
        this.#perform_cost_analysis().catch((error) => {
          console.error('Error in background cost analysis:', error);
        });
      });
    }
  }
}
// Begin execution
(async function () {
  // Initialize chart drawer
  const chart_drawer = new ChartDrawer();
  // Set default dates to today
  const today = new Date().toISOString().slice(0, 10);
  const dateInput = document.getElementById('dateInput');
  const endDateInput = document.getElementById('endDateInput');
  dateInput.value = endDateInput.value = today;
  // Toggle end date input, label visibility, and update start date label
  const useEndDateCheckbox = document.getElementById('useEndDateCheckbox');
  const dateLabel = document.getElementById('dateLabel');
  const endDateGroup = document.querySelector('.end-date-group');
  const toggleEndDate = () => {
    const isChecked = useEndDateCheckbox.checked;
    const endDateInput = document.getElementById('endDateInput');
    endDateInput.disabled = !isChecked;
    endDateGroup.classList.toggle('enabled', isChecked);
    dateLabel.innerText = isChecked ? 'Begin date:' : 'Date:';
  };
  useEndDateCheckbox.addEventListener('change', toggleEndDate);
  toggleEndDate(); // Apply initial state
  // Dark mode toggle
  const darkToggle = document.querySelector('.dark-mode-toggle');
  if (darkToggle) {
    const isDark = document.body.classList.contains('dark');
    darkToggle.innerHTML = isDark ? '☀️' : '🌙';
    darkToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark');
      const newDark = document.body.classList.contains('dark');
      darkToggle.innerHTML = newDark ? '☀️' : '🌙';
      // Update canvas background
      const canvas = document.getElementById('acquisitions');
      if (canvas) {
        canvas.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim();
      }
      // Update chart theme
      chart_drawer.updateTheme(newDark);
    });
  }
  // Predictive fetch setup
  const predictiveCheckbox = document.getElementById('predictiveCheckbox');
  const prefetchIfEnabled = () => {
    if (predictiveCheckbox.checked) {
      prefetchFullData().catch(error => {
        console.error('Error in predictive fetch:', error);
      });
    }
  };
  dateInput.addEventListener('focus', prefetchIfEnabled);
  endDateInput.addEventListener('focus', prefetchIfEnabled);
  // Update chart with selected date range
  document.getElementById('filterButton').addEventListener('click', () => {
    const start_date = new Date(dateInput.value);
    const end_date = useEndDateCheckbox.checked ? new Date(endDateInput.value) : new Date(start_date);
    chart_drawer.generate_chart(start_date, end_date);
  });
  // Show all historical data
  document.getElementById('showAllButton').addEventListener('click', () => {
    chart_drawer.generate_chart(new Date(0), new Date());
  });
  // Generate chart for current day
  chart_drawer.generate_chart(new Date(), new Date());
})();