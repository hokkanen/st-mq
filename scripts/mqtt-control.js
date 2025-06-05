import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';
import mqtt from 'mqtt';
import schedule from 'node-schedule';
import { XMLParser } from 'fast-xml-parser';

// Debugging settings and console colors
const debug = true;
const reset = '\x1b[0m';
const blue = '\x1b[34m';
const green = '\x1b[32m';
const red = '\x1b[31m';
const yellow = '\x1b[33m';

// Configuration and CSV paths
let config_path = './config.json';
if (fs.existsSync('./data/options.json')) {
    config_path = './data/options.json';
}
const csv_file_path = './share/st-mq/st-mq.csv';

// Utility function for formatting time strings
function date_string() {
    return moment.utc().format('HH:mm:ss DD-MM-YYYY') + ' UTC';
}

// Configuration loader
function config() {
    let config_data = {
        country_code: '',
        entsoe_token: '',
        mqtt_address: '',
        mqtt_user: '',
        mqtt_pw: '',
        postal_code: '',
        st_temp_in_id: '',
        st_temp_ga_id: '',
        st_temp_out_id: '',
        st_token: '',
        temp_to_hours: [],
        weather_token: ''
    };
    if (fs.existsSync(config_path)) {
        try {
            const file_data = JSON.parse(fs.readFileSync(config_path, 'utf8'));
            const options = file_data.options || file_data;
            Object.assign(config_data, {
                country_code: options.geoloc.country_code,
                entsoe_token: options.entsoe.token,
                mqtt_address: options.mqtt.address,
                mqtt_user: options.mqtt.user,
                mqtt_pw: options.mqtt.pw,
                postal_code: options.geoloc.postal_code,
                st_temp_in_id: options.smartthings.inside_temp_dev_id,
                st_temp_ga_id: options.smartthings.garage_temp_dev_id,
                st_temp_out_id: options.smartthings.outside_temp_dev_id,
                st_token: options.smartthings.token,
                temp_to_hours: options.temp_to_hours,
                weather_token: options.openweathermap.token
            });
        } catch (error) {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Failed to parse ${config_path}: ${error.toString()}`);
        }
    }
    return config_data;
}

// MQTT handler class
class mqtt_handler {
    constructor(broker_address, username, password) {
        this.broker_address = broker_address;
        this.logged_topics = [];
        const options = { username, password };
        this.client = mqtt.connect(this.broker_address, options);

        this.client.on('error', (error) => {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] MQTT: client error: ${error.toString()}`);
        });

        this.client.on('connect', () => {
            console.log(`${blue}%s${reset}`, `[${date_string()}] MQTT: client connected.`);
        });

        this.client.on('offline', () => {
            console.log(`${blue}%s${reset}`, `[${date_string()}] MQTT: client offline!`);
        });

        this.client.on('reconnect', () => {
            console.log(`${blue}%s${reset}`, `[${date_string()}] MQTT: client reconnecting.`);
        });

        this.client.on('message', (topic, message) => {
            if (this.logged_topics.includes(topic)) {
                console.log(`${blue}%s${reset}`, `[${date_string()}] MQTT: received ${topic}:${message}`);
            }
        });
    }

    async log_topic(topic, qos = 2) {
        this.logged_topics.push(topic);
        this.client.subscribe(topic, { qos }, (err) => {
            if (err) {
                console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] MQTT: failed to subscribe to ${topic}: ${err.toString()}`);
            } else {
                console.log(`${blue}%s${reset}`, `[${date_string()}] MQTT: subscribed to ${topic} with QoS ${qos}.`);
            }
        });
    }

    async post_trigger(topic, msg, qos = 1) {
        return new Promise((resolve, reject) => {
            this.client.publish(topic, msg, { qos }, (error) => {
                if (error) {
                    console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] MQTT: failed to publish ${topic}:${msg}`);
                    console.error(`${blue}%s${reset}`, error.toString());
                    reject(error);
                } else {
                    console.log(`${blue}%s${reset}`, `[${date_string()}] MQTT: published ${topic}:${msg} with QoS ${qos}.`);
                    resolve();
                }
            });
        });
    }
}

// Data fetching class
class fetch_data {
    constructor() {
        this.price_resolution = null;
        this.prices = [];
        this.inside_temp = null;
        this.garage_temp = null;
        this.outside_temp = null;
    }

    // Check API response
async check_response(response, type) {
    if (!response) {
        console.log(`${blue}%s${reset}`, `[ERROR ${date_string()}] ${type} query failed: No response`);
        return null;
    }
    console.log(`${blue}%s${reset}`, `[${date_string()}] ${type} query status: ${response.status}`);
    return response.status;
}

    // Query Entso-E prices
    async query_entsoe_prices(start_date, end_date) {
        const api_key = config().entsoe_token;
        const period_start = moment(start_date).utc().format('YYYYMMDDHHmm');
        const period_end = moment(end_date).utc().format('YYYYMMDDHHmm');
        const document_type = 'A44';
        const process_type = 'A01';
        const location_codes = {
            'fi': '10YFI-1--------U',
            'ee': '10Y1001A1001A39I',
            'se': '10YSE-1--------K',
            'no': '10YNO-0--------C',
            'dk': '10Y1001A1001A65H',
            'is': 'IS',
            'lt': '10YLT-1001A0008Q',
            'lv': '10YLV-1001A00074'
        };
        const url = `https://web-api.tp.entsoe.eu/api?securityToken=${api_key}&documentType=${document_type}&processType=${process_type}&in_Domain=${location_codes[config().country_code]}&out_Domain=${location_codes[config().country_code]}&periodStart=${period_start}&periodEnd=${period_end}`;
    
        try {
            const response = await fetch(url);
            if (await this.check_response(response, `Entsoe-E (${config().country_code})`) !== 200) {
                return { prices: [], resolution: null };
            }
    
            const json_data = new XMLParser().parse(await response.text());
    
            // Debug: Print JSON data
            if (debug) {
                console.log(`${blue}%s${reset}`, `[${date_string()}] Entsoe-E JSON data:`, JSON.stringify(json_data, null, 2));
            }
    
            // Check for error response
            if (json_data.Acknowledgement_MarketDocument) {
                console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E API error: ${json_data.Acknowledgement_MarketDocument.Reason?.text || 'Unknown error'}`);
                return { prices: [], resolution: null };
            }
    
            // Get document-level time interval
            const doc_time_interval = json_data?.Publication_MarketDocument?.['period.timeInterval'];
            if (!doc_time_interval?.start || !doc_time_interval?.end) {
                console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E: Invalid or missing period.timeInterval`);
                return { prices: [], resolution: null };
            }
    
            // Calculate total period
            const doc_start = moment(doc_time_interval.start);
            const doc_end = moment(doc_time_interval.end);
            const duration_minutes = doc_end.diff(doc_start, 'minutes', true);
    
            // Get TimeSeries array
            const time_series = Array.isArray(json_data?.Publication_MarketDocument?.TimeSeries)
                ? json_data.Publication_MarketDocument.TimeSeries
                : json_data?.Publication_MarketDocument?.TimeSeries
                    ? [json_data.Publication_MarketDocument.TimeSeries]
                    : [];
    
            if (time_series.length === 0) {
                console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E: No TimeSeries found`);
                return { prices: [], resolution: null };
            }
    
            // Initialize variables
            let resolution = null;
            let full_prices = [];
            let current_slot_offset = 0;
    
            // Process each TimeSeries
            time_series.forEach((ts, index) => {
                const ts_resolution = ts?.Period?.resolution || null;
    
                // Set resolution for first TimeSeries
                if (index === 0) {
                    resolution = ts_resolution;
                    if (!resolution) {
                        console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E: No resolution in TimeSeries[${index}]`);
                        return;
                    }
                    if (debug) {
                        console.log(`${blue}%s${reset}`, `[${date_string()}] Entsoe-E Resolution: ${resolution}`);
                    }
                } else if (ts_resolution !== resolution) {
                    console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E: Resolution mismatch in TimeSeries[${index}]: expected ${resolution}, got ${ts_resolution}`);
                }
    
                // Get TimeSeries time interval
                const time_interval = ts?.Period?.timeInterval;
                if (!time_interval?.start || !time_interval?.end) {
                    console.warn(`${blue}%s${reset}`, `[WARN ${date_string()}] Entsoe-E: No timeInterval in TimeSeries[${index}], skipping`);
                    return;
                }
    
                const ts_start = moment(time_interval.start);
                const ts_end = moment(time_interval.end);
                const ts_duration_minutes = ts_end.diff(ts_start, 'minutes', true);
                const slots_per_hour = resolution === 'PT15M' ? 4 : 1;
                const ts_slots = Math.floor(ts_duration_minutes / (resolution === 'PT15M' ? 15 : 60));
    
                if (debug) {
                    console.log(`${blue}%s${reset}`, `[${date_string()}] Entsoe-E TimeSeries[${index}] Duration: ${ts_duration_minutes} minutes, Slots: ${ts_slots}`);
                }
    
                // Initialize prices for this TimeSeries
                let ts_prices = Array(ts_slots).fill(null);
    
                // Process Points
                const points = Array.isArray(ts?.Period?.Point) ? ts.Period.Point : ts?.Period?.Point ? [ts.Period.Point] : [];
                if (debug) {
                    console.log(`${blue}%s${reset}`, `[${date_string()}] Entsoe-E TimeSeries[${index}] Points:`, JSON.stringify(points, null, 2));
                }
                points.forEach(entry => {
                    const position = parseInt(entry.position) - 1; // 1-based to 0-based
                    const price = parseFloat(entry['price.amount']);
                    if (!isNaN(price) && position >= 0 && position < ts_slots) {
                        ts_prices[position] = price;
                    }
                });
    
                // Fill omitted entries within TimeSeries
                for (let i = 1; i < ts_prices.length; i++) {
                    if (ts_prices[i] === null && ts_prices[i - 1] !== null) {
                        ts_prices[i] = ts_prices[i - 1];
                    }
                }
    
                // Append to full prices
                full_prices = full_prices.concat(ts_prices);
                current_slot_offset += ts_slots;
            });
    
            // Validate resolution
            if (!resolution) {
                console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E: No valid resolution`);
                return { prices: [], resolution: null };
            }
    
            // Trim prices to document-level period
            const total_slots = Math.floor(duration_minutes / (resolution === 'PT15M' ? 15 : 60));
            full_prices = full_prices.slice(0, total_slots);
    
            if (debug) {
                console.log(`${blue}%s${reset}`, `[${date_string()}] Entso-E Prices:`, full_prices, `Resolution: ${resolution}`);
            }
    
            return { prices: full_prices, resolution };
        } catch (error) {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Entsoe-E query failed: ${error.toString()}`);
            return { prices: [], resolution: null };
        }
    }

// Query Elering prices
async query_elering_prices(period_start, period_end) {
    const encoded_start = encodeURIComponent(period_start);
    const encoded_end = encodeURIComponent(period_end);
    const url = `https://dashboard.elering.ee/api/nps/price?start=${encoded_start}&end=${encoded_end}`;

    try {
        const response = await fetch(url);
        if (await this.check_response(response, 'Elering') !== 200) {
            return { prices: [], resolution: null };
        }

        const json_data = await response.json();

        // Debug: Print JSON data
        if (debug) {
            console.log(`${blue}%s${reset}`, `[${date_string()}] Elering JSON data:`, JSON.stringify(json_data, null, 2));
        }

        // Check for error response
        if (!json_data.success || !json_data.data || !json_data.data[config().country_code]) {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Elering API error: No valid data for country code ${config().country_code}`);
            return { prices: [], resolution: null };
        }

        // Get price entries
        const entries = json_data.data[config().country_code] || [];
        if (entries.length === 0) {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Elering: No price data found for ${config().country_code}`);
            return { prices: [], resolution: null };
        }

        // Calculate resolution
        let resolution = 'PT60M'; // Default to hourly
        if (entries.length >= 2) {
            const time_diff = entries[1].timestamp - entries[0].timestamp; // In seconds
            if (time_diff === 900) {
                resolution = 'PT15M'; // 15 minutes
            } else if (time_diff === 3600) {
                resolution = 'PT60M'; // 1 hour
            } else {
                console.warn(`${blue}%s${reset}`, `[WARN ${date_string()}] Elering: Unexpected timestamp difference ${time_diff}s, assuming PT60M`);
            }
        }
        if (debug) {
            console.log(`${blue}%s${reset}`, `[${date_string()}] Elering Resolution: ${resolution}`);
        }

        // Determine time period covered by API data
        const first_timestamp = moment.unix(entries[0].timestamp);
        const last_timestamp = moment.unix(entries[entries.length - 1].timestamp);
        const duration_minutes = last_timestamp.diff(first_timestamp, 'minutes', true);
        const slots_per_hour = resolution === 'PT15M' ? 4 : 1;
        const total_slots = Math.floor(duration_minutes / (resolution === 'PT15M' ? 15 : 60)) + 1; // Include last slot

        if (debug) {
            console.log(`${blue}%s${reset}`, `[${date_string()}] Elering: Duration ${duration_minutes} minutes, Total Slots: ${total_slots}`);
        }

        // Initialize prices array
        let full_prices = Array(total_slots).fill(null);

        // Map prices to slots
        entries.forEach(entry => {
            const timestamp = moment.unix(entry.timestamp);
            const position = resolution === 'PT15M'
                ? Math.floor(timestamp.diff(first_timestamp, 'minutes', true) / 15)
                : Math.floor(timestamp.diff(first_timestamp, 'hours', true));
            const price = parseFloat(entry.price);
            if (!isNaN(price) && position >= 0 && position < total_slots) {
                full_prices[position] = price;
            }
        });

        // Fill gaps within the data period (for missing data)
        for (let i = 1; i < full_prices.length; i++) {
            if (full_prices[i] === null && full_prices[i - 1] !== null) {
                full_prices[i] = full_prices[i - 1];
            }
        }

        if (debug) {
            console.log(`${blue}%s${reset}`, `[${date_string()}] Elering Prices:`, full_prices, `Resolution: ${this.price_resolution}`);
        }

        return { prices: full_prices, resolution };
    } catch (error) {
        console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] Elering query failed: ${error.toString()}`);
        return { prices: [], resolution: null };
    }
}



// Get OpenWeatherMap temperature
async query_owm_temp(country_code, postal_code) {
    try {
        const response = await fetch(`http://api.openweathermap.org/data/2.5/weather?zip=${postal_code},${country_code}&appid=${config().weather_token}&units=metric`);
        if (await this.check_response(response, `OpenWeatherMap (${country_code}-${postal_code})`) !== 200) return null;
        return (await response.json()).main.temp;
    } catch (error) {
        console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] OpenWeatherMap failed: ${error.toString()}`);
        return null;
    }
}

// Get SmartThings temperature
async query_st_temp(st_dev_id, country_code = '', postal_code = '') {
    const options = {
        method: 'GET',
        headers: { Authorization: `Bearer ${config().st_token}`, 'Content-Type': 'application/json' }
    };
    try {
        const response = await fetch(`https://api.smartthings.com/v1/devices/${st_dev_id}/status`, options);
        if (await this.check_response(response, `SmartThings (${st_dev_id.substring(0, 8)})`) === 200) {
            return (await response.json()).components.main.temperatureMeasurement.temperature.value;
        }
        if (country_code && postal_code) return await this.query_owm_temp(country_code, postal_code);
        return null;
    } catch (error) {
        console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] SmartThings failed: ${error.toString()}`);
        return null;
    }
}

async fetch_prices() {
    try {
        // Define period (2 days starting at midnight Europe/Berlin)
        const start_of_period = moment.tz('Europe/Berlin').startOf('day');
        const end_of_period = start_of_period.clone().add(2, 'days').startOf('day');

        // Query Entso-E
        let { prices, resolution } = await this.query_entsoe_prices(start_of_period.toISOString(), end_of_period.toISOString());
        let full_prices = prices;
        this.price_resolution = resolution;

        // Fallback to Elering if Entso-E returns no prices
        //if (full_prices.length === 0) {
            const elering_result = await this.query_elering_prices(start_of_period.toISOString(), end_of_period.toISOString());
            full_prices = elering_result.prices;
            this.price_resolution = elering_result.resolution;
        //}

        // Calculate current index based on resolution
        let current_index;
        if (this.price_resolution === 'PT15M') {
            // Align to nearest 15-minute interval
            const current_time = moment().startOf('minute').subtract(moment().minute() % 15, 'minutes');
            current_index = Math.floor(current_time.diff(start_of_period, 'minutes', true) / 15);
        } else {
            // PT60M or default: Align to start of hour
            const current_time = moment().startOf('hour');
            current_index = Math.floor(current_time.diff(start_of_period, 'hours', true));
        }

        // Slice prices from current index
        this.prices = current_index >= 0 && current_index < full_prices.length
            ? full_prices.slice(current_index)
            : [];

        if (debug) {
            console.log(`${blue}%s${reset}`, `[${date_string()}] Sliced Prices:`, this.prices, `Current Index: ${current_index}`);
        }
    } catch (error) {
        console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] fetch_prices failed: ${error.toString()}`);
        this.prices = [];
        this.price_resolution = null;
    }
}

    async fetch_temperatures() {
        try {
            this.inside_temp = await this.query_st_temp(config().st_temp_in_id);
            this.garage_temp = await this.query_st_temp(config().st_temp_in_id);
            this.outside_temp = await this.query_st_temp(config().st_temp_out_id, config().country_code, config().postal_code);
        } catch (error) {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] fetch_temperatures failed: ${error.toString()}`);
        }
    }

    shift_prices() {
        if (this.prices.length > 0) {
            this.prices.shift();
        }
    }
}

class heat_adjust {
    constructor() {
        this.last_heaton2_time = null; // Store timestamp of last heaton2
    }

    // Calculate threshold price for heating
async calc_threshold_price(outside_temp, prices) {
    const temp_to_hours = config().temp_to_hours;

    // Step 1: Calculate heating hours (no rounding)
    let hours;
    if (!outside_temp || !temp_to_hours?.length) {
        hours = 24; // Default to 24 hours (100%) if no valid data
    } else if (outside_temp >= temp_to_hours[0].temp) {
        hours = temp_to_hours[0].hours;
    } else if (outside_temp <= temp_to_hours[temp_to_hours.length - 1].temp) {
        hours = temp_to_hours[temp_to_hours.length - 1].hours;
    } else {
        let i = 0;
        while (outside_temp < temp_to_hours[i].temp) i++;
        const x1 = temp_to_hours[i - 1].temp, y1 = temp_to_hours[i - 1].hours;
        const x2 = temp_to_hours[i].temp, y2 = temp_to_hours[i].hours;
        hours = y1 + ((y2 - y1) / (x2 - x1)) * (outside_temp - x1);
    }

    // Step 2: Convert hours to percentage
    const heating_percentage = (hours / 24) * 100;

    // Step 3: Handle prices array
    if (!Array.isArray(prices) || prices.length === 0) {
        if (debug) {
            console.log(`${blue}%s${reset}`, `[${date_string()}] calc_threshold_price: Empty or invalid prices array, returning Infinity`);
        }
        return Infinity;
    }

    // Step 4: Calculate target number of prices to be below threshold
    const target_elements = Math.round((heating_percentage / 100) * prices.length);

    // Step 5: Sort prices and find threshold
    const sorted_prices = [...prices].sort((a, b) => a - b);
    const threshold_index = Math.min(target_elements, sorted_prices.length - 1);
    const threshold_price = sorted_prices[threshold_index] || Infinity;

    if (debug) {
        console.log(`${blue}%s${reset}`, `[${date_string()}] calc_threshold_price: Temp=${outside_temp}, Hours=${hours.toFixed(2)}, Percentage=${heating_percentage.toFixed(1)}%, PricesLength=${prices.length}, TargetElements=${target_elements}, Threshold=${threshold_price}`);
    }

    return threshold_price;
}

// Initialize CSV file
async init_csv() {
    const csv_dir = dirname(csv_file_path);
    if (!fs.existsSync(csv_dir)) fs.mkdirSync(csv_dir, { recursive: true });
    if (!fs.existsSync(csv_file_path) || fs.statSync(csv_file_path).size === 0) {
        fs.writeFileSync(csv_file_path, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n');
    }
}

// Write to CSV
async write_csv(price, heat_on, temp_in, temp_ga, temp_out) {
    await this.init_csv();
    const unix_time = moment().unix();
    const price_str = typeof price === 'string' ? price : price.toFixed(3);
    const temp_in_str = typeof temp_in === 'string' ? temp_in : temp_in.toFixed(1);
    const temp_ga_str = typeof temp_ga === 'string' ? temp_ga : temp_ga.toFixed(1);
    const temp_out_str = typeof temp_out === 'string' ? temp_out : temp_out.toFixed(1);
    fs.appendFileSync(csv_file_path, `${unix_time},${price_str},${heat_on},${temp_in_str},${temp_ga_str},${temp_out_str}\n`);
}

    async adjust(mqtt_client, fetch_data_instance) {
        try {
            await fetch_data_instance.fetch_prices();
            await fetch_data_instance.fetch_temperatures();

            // get fetched data
            const current_price = fetch_data_instance.prices[0];
            const inside_temp = fetch_data_instance.inside_temp;
            const garage_temp = fetch_data_instance.garage_temp;
            const outside_temp = fetch_data_instance.outside_temp;
            const threshold_price = await this.calc_threshold_price(outside_temp, fetch_data_instance.prices);

            // Determine heating action
            let action;
            let heaton_value; // For CSV: 0 (heatoff), 1 (heaton1), 2 (heaton2)
            const now = moment();
            const heat_on = current_price === null || current_price <= threshold_price || current_price <= 40;

            if (heat_on) {
                // Check if last heaton2 was more than 1 hour ago or never set
                if (!this.last_heaton2_time || now.diff(this.last_heaton2_time, 'hours', true) >= 1) {
                    action = 'heaton2';
                    heaton_value = 2;
                    this.last_heaton2_time = now; // Update last heaton2 time
                } else {
                    action = 'heaton1';
                    heaton_value = 1;
                }
            } else {
                action = 'heatoff';
                heaton_value = 0;
            }

            await mqtt_client.post_trigger('from_stmq/heat/action', action);

            const price_for_csv = current_price !== null ? (current_price / 10.0).toFixed(3) : 'NaN';
            const temp_in_for_csv = inside_temp !== null ? inside_temp.toFixed(1) : 'NaN';
            const temp_ga_for_csv = garage_temp !== null ? garage_temp.toFixed(1) : 'NaN';
            const temp_out_for_csv = outside_temp !== null ? outside_temp.toFixed(1) : 'NaN';
            await this.write_csv(price_for_csv, heaton_value, temp_in_for_csv, temp_ga_for_csv, temp_out_for_csv);

            fetch_data_instance.shift_prices();

            if (debug) {
                console.log(`${blue}%s${reset}`, `[${date_string()}] heat_adjust = ${action}, price = ${current_price}, threshold = ${threshold_price}`);
                console.log(`${blue}%s${reset}`, `[${date_string()}] Remaining price slots: `, fetch_data_instance.prices);
            }
        } catch (error) {
            console.error(`${blue}%s${reset}`, `[ERROR ${date_string()}] heat_adjust.adjust failed: ${error.toString()}`);
        }
    }
}

// Main execution
(async () => {
    const mqtt_client = new mqtt_handler(config().mqtt_address, config().mqtt_user, config().mqtt_pw);
    const fetch_data_instance = new fetch_data();
    const heat_adjust_instance = new heat_adjust();
    
    await mqtt_client.log_topic('to_stmq/heat/receipt');
    await heat_adjust_instance.adjust(mqtt_client, fetch_data_instance);
    schedule.scheduleJob('*/15 * * * *', async () => {
        await heat_adjust_instance.adjust(mqtt_client, fetch_data_instance);
        console.log(`${blue}%s${reset}`, `[${date_string()}] scheduled heat_adjust executed.`);
    });
})();