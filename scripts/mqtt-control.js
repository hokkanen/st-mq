import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';
import mqtt from 'mqtt';
import schedule from 'node-schedule';
import { XMLParser } from 'fast-xml-parser';

// ### Global Variables ###
// Debugging settings and console colors
const DEBUG = false;
const RESET = '\x1b[0m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

// Configuration and CSV paths
let CONFIG_PATH = './config.json'; // default path
if (fs.existsSync('./data/options.json')) {
    CONFIG_PATH = './data/options.json'; // HASS path
}
const CSV_FILE_PATH = './share/st-mq/st-mq.csv';

// ### Utility Functions ###

// Formats the current UTC time as a string for logging
function date_string() {
    return moment.utc().format('HH:mm:ss DD-MM-YYYY') + ' UTC';
}

// Loads configuration from a JSON file, falling back to defaults if the file is missing or invalid
function config() {
    const default_config = {
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

    if (!fs.existsSync(CONFIG_PATH)) {
        console.log(`${BLUE}[ERROR ${date_string()}] Config file not found at ${CONFIG_PATH}${RESET}`);
        return default_config;
    }

    try {
        const file_data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const options = file_data.options || file_data;
        return {
            ...default_config,
            country_code: options.geoloc?.country_code || '',
            entsoe_token: options.entsoe?.token || '',
            mqtt_address: options.mqtt?.address || '',
            mqtt_user: options.mqtt?.user || '',
            mqtt_pw: options.mqtt?.pw || '',
            postal_code: options.geoloc?.postal_code || '',
            st_temp_in_id: options.smartthings?.inside_temp_dev_id || '',
            st_temp_ga_id: options.smartthings?.garage_temp_dev_id || '',
            st_temp_out_id: options.smartthings?.outside_temp_dev_id || '',
            st_token: options.smartthings?.token || '',
            temp_to_hours: options.temp_to_hours || [],
            weather_token: options.openweathermap?.token || ''
        };
    } catch (error) {
        console.log(`${BLUE}[ERROR ${date_string()}] Failed to parse ${CONFIG_PATH}: ${error.toString()}${RESET}`);
        return default_config;
    }
}

// ### MQTT Handler Class ###

// Manages MQTT connections, subscriptions, and publications
class MqttHandler {
    constructor(broker_address, username, password) {
        this.broker_address = broker_address;
        this.logged_topics = [];
        const options = { username, password };
        this.client = mqtt.connect(this.broker_address, options);

        // Handle MQTT client events
        this.client.on('error', (error) => {
            console.log(`${BLUE}[ERROR ${date_string()}] MQTT client error: ${error.toString()}${RESET}`);
        });

        this.client.on('connect', () => {
            console.log(`${BLUE}[${date_string()}] MQTT client connected${RESET}`);
        });

        this.client.on('offline', () => {
            console.log(`${BLUE}[${date_string()}] MQTT client offline${RESET}`);
        });

        this.client.on('reconnect', () => {
            console.log(`${BLUE}[${date_string()}] MQTT client reconnecting${RESET}`);
        });

        this.client.on('message', (topic, message) => {
            if (this.logged_topics.includes(topic)) {
                console.log(`${BLUE}[${date_string()}] MQTT received ${topic}:${message}${RESET}`);
            }
        });
    }

    // Subscribes to an MQTT topic with specified QoS
    async log_topic(topic, qos = 2) {
        this.logged_topics.push(topic);
        this.client.subscribe(topic, { qos }, (err) => {
            if (err) {
                console.log(`${BLUE}[ERROR ${date_string()}] MQTT failed to subscribe to ${topic}: ${err.toString()}${RESET}`);
            } else {
                console.log(`${BLUE}[${date_string()}] MQTT subscribed to ${topic} with QoS ${qos}${RESET}`);
            }
        });
    }

    // Publishes a message to an MQTT topic with specified QoS
    async post_trigger(topic, msg, qos = 1) {
        return new Promise((resolve, reject) => {
            this.client.publish(topic, msg, { qos }, (error) => {
                if (error) {
                    console.log(`${BLUE}[ERROR ${date_string()}] MQTT failed to publish ${topic}:${msg}: ${error.toString()}${RESET}`);
                    reject(error);
                } else {
                    console.log(`${BLUE}[${date_string()}] MQTT published ${topic}:${msg} with QoS ${qos}${RESET}`);
                    resolve();
                }
            });
        });
    }
}

// ### Data Fetching Class ###

// Fetches electricity prices and temperatures from various APIs
class FetchData {
    constructor() {
        this.price_resolution = null;
        this.prices = [];
        this.inside_temp = null;
        this.garage_temp = null;
        this.outside_temp = null;
    }

    // Compares two price arrays for equality
    are_prices_equal(prices1, prices2) {
        if (!prices1 || !prices2 || prices1.length !== prices2.length) return false;
        return prices1.every((price, index) => price === prices2[index]);
    }

    // Checks the status of an API response and logs the result
    async check_response(response, type) {
        if (!response) {
            console.log(`${BLUE}[ERROR ${date_string()}] ${type} query failed: No response${RESET}`);
            return null;
        }
        if (response.status === 200) {
            console.log(`${BLUE}[${date_string()}] ${type} query successful!${RESET}`);
        }
        else {
            console.log(`${BLUE}[ERROR ${date_string()}] ${type} query failed!${RESET}`)
            console.log(`${BLUE} API status: ${response.status}${RESET}`);
            console.log(`${BLUE} API response: ${response.statusText}${RESET}`);
        }
        return response.status;
    }

    // Queries electricity prices from Entso-E API
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
            if (await this.check_response(response, `Entso-E (${config().country_code})`) !== 200) {
                return { prices: [], resolution: null };
            }

            const json_data = new XMLParser().parse(await response.text());

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E JSON data: ${JSON.stringify(json_data, null, 2)}${RESET}`);
            }

            if (json_data.Acknowledgement_MarketDocument) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E API error: ${json_data.Acknowledgement_MarketDocument.Reason?.text || 'Unknown error'}${RESET}`);
                return { prices: [], resolution: null };
            }

            const doc_time_interval = json_data?.Publication_MarketDocument?.['period.timeInterval'];
            if (!doc_time_interval?.start || !doc_time_interval?.end) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: Invalid or missing period.timeInterval${RESET}`);
                return { prices: [], resolution: null };
            }

            const doc_start = moment(doc_time_interval.start);
            const doc_end = moment(doc_time_interval.end);
            const duration_minutes = doc_end.diff(doc_start, 'minutes', true);

            const time_series = Array.isArray(json_data?.Publication_MarketDocument?.TimeSeries)
                ? json_data.Publication_MarketDocument.TimeSeries
                : json_data?.Publication_MarketDocument?.TimeSeries
                    ? [json_data.Publication_MarketDocument.TimeSeries]
                    : [];

            if (time_series.length === 0) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: No TimeSeries found${RESET}`);
                return { prices: [], resolution: null };
            }

            let resolution = null;
            let full_prices = [];

            for (const [index, ts] of time_series.entries()) {
                const ts_resolution = ts?.Period?.resolution || null;

                if (index === 0) {
                    resolution = ts_resolution;
                    if (!resolution) {
                        console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: No resolution in TimeSeries[${index}]${RESET}`);
                        return { prices: [], resolution: null };
                    }
                    if (DEBUG) {
                        console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E Resolution: ${resolution}${RESET}`);
                    }
                } else if (ts_resolution !== resolution) {
                    console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: Resolution mismatch in TimeSeries[${index}]: expected ${resolution}, got ${ts_resolution}${RESET}`);
                }

                const time_interval = ts?.Period?.timeInterval;
                if (!time_interval?.start || !time_interval?.end) {
                    console.log(`${BLUE}[${date_string()}] Entso-E: No timeInterval in TimeSeries[${index}], skipping${RESET}`);
                    continue;
                }

                const ts_start = moment(time_interval.start);
                const ts_end = moment(time_interval.end);
                const ts_duration_minutes = ts_end.diff(ts_start, 'minutes', true);
                const slots_per_hour = resolution === 'PT15M' ? 4 : 1;
                const ts_slots = Math.floor(ts_duration_minutes / (resolution === 'PT15M' ? 15 : 60));

                if (DEBUG) {
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E TimeSeries[${index}] Duration: ${ts_duration_minutes} minutes, Slots: ${ts_slots}${RESET}`);
                }

                let ts_prices = Array(ts_slots).fill(null);
                const points = Array.isArray(ts?.Period?.Point) ? ts.Period.Point : ts?.Period?.Point ? [ts.Period.Point] : [];

                if (DEBUG) {
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E TimeSeries[${index}] Points: ${JSON.stringify(points, null, 2)}${RESET}`);
                }

                points.forEach(entry => {
                    const position = parseInt(entry.position) - 1; // 1-based to 0-based
                    const price = parseFloat(entry['price.amount']);
                    if (!isNaN(price) && position >= 0 && position < ts_slots) {
                        ts_prices[position] = price;
                    }
                });

                for (let i = 1; i < ts_prices.length; i++) {
                    if (ts_prices[i] === null && ts_prices[i - 1] !== null) {
                        ts_prices[i] = ts_prices[i - 1];
                    }
                }

                full_prices = full_prices.concat(ts_prices);
            }

            if (!resolution) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: No valid resolution${RESET}`);
                return { prices: [], resolution: null };
            }

            const total_slots = Math.floor(duration_minutes / (resolution === 'PT15M' ? 15 : 60));
            full_prices = full_prices.slice(0, total_slots);

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E Prices: ${JSON.stringify(full_prices)}, Resolution: ${resolution}${RESET}`);
            }

            return { prices: full_prices, resolution };
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Entso-E query failed: ${error.toString()}${RESET}`);
            return { prices: [], resolution: null };
        }
    }

    // Queries electricity prices from Elering API
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

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Elering JSON data: ${JSON.stringify(json_data, null, 2)}${RESET}`);
            }

            if (!json_data.success || !json_data.data || !json_data.data[config().country_code]) {
                console.log(`${BLUE}[ERROR ${date_string()}] Elering API error: No valid data for country code ${config().country_code}${RESET}`);
                return { prices: [], resolution: null };
            }

            const entries = json_data.data[config().country_code] || [];
            if (entries.length === 0) {
                console.log(`${BLUE}[ERROR ${date_string()}] Elering: No price data found for ${config().country_code}${RESET}`);
                return { prices: [], resolution: null };
            }

            let resolution = 'PT60M';
            if (entries.length >= 2) {
                const time_diff = entries[1].timestamp - entries[0].timestamp;
                if (time_diff === 900) {
                    resolution = 'PT15M';
                } else if (time_diff === 3600) {
                    resolution = 'PT60M';
                } else {
                    console.log(`${BLUE}[${date_string()}] Elering: Unexpected timestamp difference ${time_diff}s, assuming PT60M${RESET}`);
                }
            }

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Elering Resolution: ${resolution}${RESET}`);
            }

            const first_timestamp = moment.unix(entries[0].timestamp);
            const last_timestamp = moment.unix(entries[entries.length - 1].timestamp);
            const duration_minutes = last_timestamp.diff(first_timestamp, 'minutes', true);
            const slots_per_hour = resolution === 'PT15M' ? 4 : 1;
            const total_slots = Math.floor(duration_minutes / (resolution === 'PT15M' ? 15 : 60)) + 1;

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Elering: Duration ${duration_minutes} minutes, Total Slots: ${total_slots}${RESET}`);
            }

            let full_prices = Array(total_slots).fill(null);

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

            for (let i = 1; i < full_prices.length; i++) {
                if (full_prices[i] === null && full_prices[i - 1] !== null) {
                    full_prices[i] = full_prices[i - 1];
                }
            }

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Elering Prices: ${JSON.stringify(full_prices)}, Resolution: ${resolution}${RESET}`);
            }

            return { prices: full_prices, resolution };
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Elering query failed: ${error.toString()}${RESET}`);
            return { prices: [], resolution: null };
        }
    }

    // Fetches temperature from OpenWeatherMap API
    async query_owm_temp(country_code, postal_code) {
        try {
            const response = await fetch(`http://api.openweathermap.org/data/2.5/weather?zip=${postal_code},${country_code}&appid=${config().weather_token}&units=metric`);
            if (await this.check_response(response, `OpenWeatherMap (${country_code}-${postal_code})`) !== 200) {
                return null;
            }
            const data = await response.json();
            return data.main?.temp ?? null;
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] OpenWeatherMap failed: ${error.toString()}${RESET}`);
            return null;
        }
    }

    // Fetches temperature from SmartThings API, falling back to OpenWeatherMap if specified
    async query_st_temp(st_dev_id, country_code = '', postal_code = '') {
        const options = {
            method: 'GET',
            headers: { Authorization: `Bearer ${config().st_token}`, 'Content-Type': 'application/json' }
        };
        try {
            const response = await fetch(`https://api.smartthings.com/v1/devices/${st_dev_id}/status`, options);
            if (await this.check_response(response, `SmartThings (${st_dev_id.substring(0, 8)})`) === 200) {
                const data = await response.json();
                return data.components?.main?.temperatureMeasurement?.temperature?.value ?? null;
            }
            if (country_code && postal_code) {
                return await this.query_owm_temp(country_code, postal_code);
            }
            return null;
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] SmartThings failed: ${error.toString()}${RESET}`);
            return country_code && postal_code ? await this.query_owm_temp(country_code, postal_code) : null;
        }
    }

    // Fetches electricity prices for the next 48 hours, updating only if prices or resolution change
    async fetch_prices() {
        try {
            const start_of_period = moment.tz('Europe/Berlin').startOf('day');
            const end_of_period = start_of_period.clone().add(2, 'days').startOf('day');

            let { prices: new_prices, resolution: new_resolution } = await this.query_entsoe_prices(start_of_period.toISOString(), end_of_period.toISOString());
            let full_prices = new_prices;

            if (full_prices.length === 0) {
                const elering_result = await this.query_elering_prices(start_of_period.toISOString(), end_of_period.toISOString());
                full_prices = elering_result.prices;
                new_resolution = elering_result.resolution;
            }

            // Update prices only if they differ or resolution changes
            if (full_prices.length > 0 && (!this.are_prices_equal(full_prices, this.prices) || this.price_resolution !== new_resolution)) {
                this.prices = full_prices;
                this.price_resolution = new_resolution;
            } else {
                if (DEBUG) {
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Prices unchanged or empty, retaining old prices${RESET}`);
                }
            }

            let current_index;
            if (this.price_resolution === 'PT15M') {
                const current_time = moment().startOf('minute').subtract(moment().minute() % 15, 'minutes');
                current_index = Math.floor(current_time.diff(start_of_period, 'minutes', true) / 15);
            } else {
                const current_time = moment().startOf('hour');
                current_index = Math.floor(current_time.diff(start_of_period, 'hours', true));
            }

            this.prices = current_index >= 0 && current_index < this.prices.length
                ? this.prices.slice(current_index)
                : [];

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Sliced Prices: ${JSON.stringify(this.prices)}, Current Index: ${current_index}${RESET}`);
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] fetch_prices failed: ${error.toString()}, retaining old prices${RESET}`);
            // Old prices are retained automatically as this.prices and this.price_resolution are not updated
        }
    }

    // Fetches current temperatures from SmartThings devices
    async fetch_temperatures() {
        try {
            this.inside_temp = await this.query_st_temp(config().st_temp_in_id);
            this.garage_temp = await this.query_st_temp(config().st_temp_ga_id);
            this.outside_temp = await this.query_st_temp(config().st_temp_out_id, config().country_code, config().postal_code);
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] fetch_temperatures failed: ${error.toString()}${RESET}`);
            this.inside_temp = null;
            this.garage_temp = null;
            this.outside_temp = null;
        }
    }

    // Removes the first price from the prices array
    shift_prices() {
        if (this.prices.length > 0) {
            this.prices.shift();
        }
    }
}

// ### Heating Adjustment Class ###

// Controls heating based on electricity prices and temperatures
class HeatAdjustment {
    constructor() {
        this.last_heaton60_time = null; // Tracks the last time heaton60 was triggered
    }

    // Calculates the threshold price below which heating should be activated
    async calc_threshold_price(outside_temp, prices, resolution) {
        const temp_to_hours = config().temp_to_hours;

        let hours;
        if (!outside_temp || !temp_to_hours?.length) {
            hours = 24; // Default to 24 hours if data is invalid
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

        const heating_percentage = (hours / 24) * 100;

        if (!Array.isArray(prices) || prices.length === 0) {
            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] calc_threshold_price: Empty or invalid prices array, returning Infinity${RESET}`);
            }
            return Infinity;
        }

        const target_elements = Math.round((heating_percentage / 100) * prices.length);
        const sorted_prices = [...prices].sort((a, b) => a - b);
        const threshold_index = Math.max(0, Math.min(target_elements - 1, sorted_prices.length - 1));
        const threshold_price = sorted_prices[threshold_index] || Infinity;

        console.log(`${BLUE}[${date_string()}] HeatedHours=${hours.toFixed(2)}/24 (${heating_percentage.toFixed(1)}%) @ ${outside_temp}C, TargetPeriods=${target_elements}/${prices.length} (${resolution}), Threshold=${threshold_price}${RESET}`);

        return threshold_price;
    }

    // Initializes the CSV file with headers if it doesn't exist or is empty
    async init_csv() {
        const csv_dir = dirname(CSV_FILE_PATH);
        try {
            if (!fs.existsSync(csv_dir)) {
                fs.mkdirSync(csv_dir, { recursive: true });
            }
            if (!fs.existsSync(CSV_FILE_PATH) || fs.statSync(CSV_FILE_PATH).size === 0) {
                fs.writeFileSync(CSV_FILE_PATH, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n');
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Failed to initialize CSV at ${CSV_FILE_PATH}: ${error.toString()}${RESET}`);
        }
    }

    // Appends heating data to the CSV file
    async write_csv(price, heat_on, temp_in, temp_ga, temp_out) {
        await this.init_csv();
        try {
            const unix_time = moment().unix();
            const price_str = typeof price === 'string' ? price : price.toFixed(3);
            const temp_in_str = typeof temp_in === 'string' ? temp_in : temp_in.toFixed(1);
            const temp_ga_str = typeof temp_ga === 'string' ? temp_ga : temp_ga.toFixed(1);
            const temp_out_str = typeof temp_out === 'string' ? temp_out : temp_out.toFixed(1);
            fs.appendFileSync(CSV_FILE_PATH, `${unix_time},${price_str},${heat_on},${temp_in_str},${temp_ga_str},${temp_out_str}\n`);
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Failed to write to CSV: ${error.toString()}${RESET}`);
        }
    }

    // Adjusts heating based on current prices and temperatures
    async adjust(mqtt_client, fetch_data_instance) {
        try {
            await fetch_data_instance.fetch_prices();
            await fetch_data_instance.fetch_temperatures();

            const current_price = fetch_data_instance.prices[0] ?? null;
            const inside_temp = fetch_data_instance.inside_temp;
            const garage_temp = fetch_data_instance.garage_temp;
            const outside_temp = fetch_data_instance.outside_temp;
            const threshold_price = await this.calc_threshold_price(outside_temp, fetch_data_instance.prices, fetch_data_instance.price_resolution);

            let action;
            let heaton_value;
            const now = moment();
            const heat_on = current_price === null || current_price <= threshold_price || current_price <= 30;

            if (heat_on) {
                if (!this.last_heaton60_time || now.diff(this.last_heaton60_time, 'hours', true) >= 1) {
                    action = 'heaton60';
                    heaton_value = 60;
                    this.last_heaton60_time = now;
                } else {
                    action = 'heaton15';
                    heaton_value = 15;
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

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Action = ${action}, Price = ${current_price}, Threshold = ${threshold_price}${RESET}`);
                console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining price slots: ${JSON.stringify(fetch_data_instance.prices)}${RESET}`);
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] HeatAdjustment.adjust failed: ${error.toString()}${RESET}`);
        }
    }
}

// ### Main Execution ###

(async () => {
    try {
        const mqtt_client = new MqttHandler(config().mqtt_address, config().mqtt_user, config().mqtt_pw);
        const fetch_data_instance = new FetchData();
        const heat_adjust_instance = new HeatAdjustment();

        await mqtt_client.log_topic('to_stmq/heat/receipt');
        await heat_adjust_instance.adjust(mqtt_client, fetch_data_instance);

        // Schedule heat adjustment and logging to occur every 15 minutes of an hour
        schedule.scheduleJob('*/15 * * * *', async () => {
            await heat_adjust_instance.adjust(mqtt_client, fetch_data_instance);
            console.log(`${BLUE}[${date_string()}] Scheduled heat_adjust executed${RESET}`);
        });
    } catch (error) {
        console.log(`${BLUE}[ERROR ${date_string()}] Main execution failed: ${error.toString()}${RESET}`);
    }
})();
