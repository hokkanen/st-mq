import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';
import mqtt from 'mqtt';
import schedule from 'node-schedule';
import { XMLParser } from 'fast-xml-parser';

// ### Global Variables ###
// Debugging settings and console colors
const DEBUG = true;
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

// Formats the current or given time into a UTC time string for logging
function date_string(date = null) {
    const momentDate = date ? moment(date).utc() : moment.utc();
    return momentDate.format('HH:mm:ss DD-MM-YYYY') + ' UTC';
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
    #broker_address;
    #logged_topics = [];
    #client;

    constructor(broker_address, username, password) {
        this.#broker_address = broker_address;
        // Enable auto-reconnect every 1 second if connection is lost
        const options = { username, password, reconnectPeriod: 1000 };
        this.#client = mqtt.connect(this.#broker_address, options);

        // Handle MQTT client events
        this.#client.on('error', (error) => {
            console.log(`${BLUE}[ERROR ${date_string()}] MQTT client error: ${error.toString()}${RESET}`);
        });

        this.#client.on('connect', () => {
            console.log(`${BLUE}[${date_string()}] MQTT client connected${RESET}`);
        });

        this.#client.on('offline', () => {
            console.log(`${BLUE}[${date_string()}] MQTT client offline${RESET}`);
        });

        this.#client.on('reconnect', () => {
            console.log(`${BLUE}[${date_string()}] MQTT client reconnecting${RESET}`);
        });

        this.#client.on('message', (topic, message) => {
            if (this.#logged_topics.includes(topic)) {
                console.log(`${BLUE}[${date_string()}] MQTT received ${topic}:${message}${RESET}`);
            }
        });
    }

    // Getter for broker_address (for potential external access)
    get broker_address() {
        return this.#broker_address;
    }

    // Getter for logged_topics (returns a copy to prevent modification)
    get logged_topics() {
        return [...this.#logged_topics];
    }

    // Subscribes to an MQTT topic with specified QoS
    async log_topic(topic, qos = 2) {
        // Check if client is connected before subscribing
        if (!this.#client.connected) {
            console.log(`${BLUE}[ERROR ${date_string()}] MQTT client not connected, cannot subscribe to ${topic}${RESET}`);
            return;
        }
        this.#logged_topics.push(topic);
        this.#client.subscribe(topic, { qos }, (err) => {
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
            // Check if client is connected before publishing
            if (!this.#client.connected) {
                console.log(`${BLUE}[ERROR ${date_string()}] MQTT client not connected, cannot publish ${topic}:${msg}${RESET}`);
                reject(new Error('MQTT client not connected'));
                return;
            }
            this.#client.publish(topic, msg, { qos }, (error) => {
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
    // Private fields
    #price_resolution = null;
    #prices = [];
    #price_start_time = null;
    #price_end_time = null;
    #inside_temp = null;
    #garage_temp = null;
    #outside_temp = null;

    constructor() {
        // No need to initialize private fields here since they are declared above
    }

    // Public getters
    get price_resolution() {
        return this.#price_resolution;
    }

    get inside_temp() {
        return this.#inside_temp;
    }

    get garage_temp() {
        return this.#garage_temp;
    }

    get outside_temp() {
        return this.#outside_temp;
    }

    // Returns prices sliced from the current time, handling outdated data without modifying internal state
    get slice_prices() {
        if (!this.#price_start_time || !this.#price_end_time || this.#prices.length === 0 || !this.#price_resolution) {
            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (no valid prices or time data)${RESET}`);
            }
            return [];
        }

        const now = moment.tz('Europe/Berlin');
        const current_day = now.clone().startOf('day');
        const price_day = this.#price_start_time.clone().startOf('day');
        const interval_minutes = this.#price_resolution === 'PT15M' ? 15 : 60;

        let past_day_prices_sliced = 0;

        // If price data starts on a past day, skip all past days
        if (price_day.isBefore(current_day, 'day')) {
            // Calculate the number of sliced prices needed to reach the beginning of the current day
            past_day_prices_sliced = Math.floor(current_day.diff(this.#price_start_time, 'minutes', true) / interval_minutes);
            if (past_day_prices_sliced >= this.#prices.length) {
                if (DEBUG) {
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (all prices are before current day, past_day_prices_sliced=${past_day_prices_sliced}, length=${this.#prices.length})${RESET}`);
                }
                return [];
            }
        }

        // Further slice to the current time within the current day
        const total_prices_sliced = Math.floor(now.diff(this.#price_start_time, 'minutes', true) / interval_minutes);
        if (total_prices_sliced < past_day_prices_sliced) {
            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (total_prices_sliced ${total_prices_sliced} less than past_day_prices_sliced ${past_day_prices_sliced})${RESET}`);
            }
            return [];
        }
        if (total_prices_sliced >= this.#prices.length) {
            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (total_prices_sliced ${total_prices_sliced} exceeds length ${this.#prices.length})${RESET}`);
            }
            return [];
        }

        const remaining_prices = this.#prices.slice(total_prices_sliced);
        if (DEBUG) {
            console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices (${remaining_prices.length}/${this.#prices.length}): ${JSON.stringify(remaining_prices)}, Total prices sliced: ${total_prices_sliced}, Past-day-prices sliced: ${past_day_prices_sliced}${RESET}`);
        }
        return remaining_prices;
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
        } else {
            console.log(`${BLUE}[ERROR ${date_string()}] ${type} query failed!${RESET}`);
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
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            const json_data = new XMLParser().parse(await response.text());

            if (DEBUG) {
                //console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E JSON data:\n${JSON.stringify(json_data, null, 2)}\n${RESET}`);
            }

            if (json_data.Acknowledgement_MarketDocument) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E API error: ${json_data.Acknowledgement_MarketDocument.Reason?.text || 'Unknown error'}${RESET}`);
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            const doc_time_interval = json_data?.Publication_MarketDocument?.['period.timeInterval'];
            if (!doc_time_interval?.start || !doc_time_interval?.end) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: Invalid or missing period.timeInterval${RESET}`);
                return { prices: [], resolution: null, start_time: null, end_time: null };
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
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            let resolution = null;
            let full_prices = [];

            for (const [index, ts] of time_series.entries()) {
                const ts_resolution = ts?.Period?.resolution || null;

                if (index === 0) {
                    resolution = ts_resolution;
                    if (!resolution) {
                        console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: No resolution in TimeSeries[${index}]${RESET}`);
                        return { prices: [], resolution: null, start_time: null, end_time: null };
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
                    //console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E TimeSeries[${index}] Points:\n${JSON.stringify(points, null, 2)}\n${RESET}`);
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
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            const total_slots = Math.floor(duration_minutes / (resolution === 'PT15M' ? 15 : 60));
            full_prices = full_prices.slice(0, total_slots);

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E Prices:\n${JSON.stringify(full_prices)}\nResolution: ${resolution}, Start: ${date_string(doc_start)}, End: ${date_string(doc_end)}${RESET}`);
            }

            return { prices: full_prices, resolution, start_time: doc_start, end_time: doc_end };
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Entso-E query failed: ${error.toString()}${RESET}`);
            return { prices: [], resolution: null, start_time: null, end_time: null };
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
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            const json_data = await response.json();

            if (DEBUG) {
                //console.log(`${YELLOW}[DEBUG ${date_string()}] Elering JSON data:\n${JSON.stringify(json_data, null, 2)}\n${RESET}`);
            }

            if (!json_data.success || !json_data.data || !json_data.data[config().country_code]) {
                console.log(`${BLUE}[ERROR ${date_string()}] Elering API error: No valid data for country code ${config().country_code}${RESET}`);
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            const entries = json_data.data[config().country_code] || [];
            if (entries.length === 0) {
                console.log(`${BLUE}[ERROR ${date_string()}] Elering: No price data found for ${config().country_code}${RESET}`);
                return { prices: [], resolution: null, start_time: null, end_time: null };
            }

            const first_timestamp = moment.unix(entries[0].timestamp);
            const last_timestamp = moment.unix(entries[entries.length - 1].timestamp);
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

            // Calculate duration including the full last slot
            const interval_minutes = resolution === 'PT15M' ? 15 : 60;
            const end_of_last_slot = last_timestamp.clone().add(interval_minutes, 'minutes');
            const duration_minutes = end_of_last_slot.diff(first_timestamp, 'minutes', true);
            const slots_per_hour = resolution === 'PT15M' ? 4 : 1;
            const total_slots = Math.floor(duration_minutes / interval_minutes);

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

            // Adjust end time to include the full last interval
            const end_time = last_timestamp.clone().add(interval_minutes, 'minutes');

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Elering Prices:\n${JSON.stringify(full_prices)}\nResolution: ${resolution}, Start: ${date_string(first_timestamp)}, End: ${date_string(end_time)}${RESET}`);
            }

            return { prices: full_prices, resolution, start_time: first_timestamp, end_time };
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Elering query failed: ${error.toString()}${RESET}`);
            return { prices: [], resolution: null, start_time: null, end_time: null };
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

    // Fetches electricity prices for the next 48 hours, updating only if 12 or fewer hours remain
    async fetch_prices() {
        try {
            const now = moment.tz('Europe/Berlin');
            const start_of_period = now.clone().startOf('day');
            const end_of_period = start_of_period.clone().add(2, 'days').startOf('day');

            // Check if sufficient prices remain using slice_prices
            let should_fetch = true;
            if (this.#price_start_time && this.#price_end_time && this.#prices.length > 0 && this.#price_resolution) {
                const remaining_slots = this.slice_prices.length;
                const slots_per_hour = this.#price_resolution === 'PT15M' ? 4 : 1;
                const remaining_hours = remaining_slots / slots_per_hour;

                if (remaining_hours > 12) {
                    should_fetch = false;
                    if (DEBUG) {
                        console.log(`${YELLOW}[DEBUG ${date_string()}] Skipping price fetch: ${remaining_hours.toFixed(2)} hours remain (>= 12, ${remaining_slots} slots)${RESET}`);
                    }
                } else {
                    if (DEBUG) {
                        console.log(`${YELLOW}[DEBUG ${date_string()}] Fetching prices: ${remaining_hours.toFixed(2)} hours remain (< 12, ${remaining_slots} slots)${RESET}`);
                    }
                }
            }

            if (!should_fetch) {
                return;
            }

            let { prices: new_prices, resolution: new_resolution, start_time, end_time } = await this.query_entsoe_prices(start_of_period.toISOString(), end_of_period.toISOString());
            let full_prices = new_prices;

            if (full_prices.length === 0) {
                const elering_result = await this.query_elering_prices(start_of_period.toISOString(), end_of_period.toISOString());
                full_prices = elering_result.prices;
                new_resolution = elering_result.resolution;
                start_time = elering_result.start_time;
                end_time = elering_result.end_time;
            }

            // Update prices only if they differ or resolution/period changes
            if (full_prices.length > 0 && (!this.are_prices_equal(full_prices, this.#prices) || this.#price_resolution !== new_resolution || !this.#price_start_time || !this.#price_start_time.isSame(start_time))) {
                this.#prices = full_prices;
                this.#price_resolution = new_resolution;
                this.#price_start_time = start_time;
                this.#price_end_time = end_time;
                if (DEBUG) {
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Updated Prices:\n${JSON.stringify(this.#prices)}\nResolution: ${new_resolution}, Start: ${date_string(start_time)}, End: ${date_string(end_time)}${RESET}`);
                }
            } else if (full_prices.length === 0) {
                if (DEBUG) {
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Both API calls failed, retaining existing prices${RESET}`);
                }
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] fetch_prices failed: ${error.toString()}, retaining existing prices${RESET}`);
        }
    }

    // Fetches current temperatures from SmartThings devices
    async fetch_temperatures() {
        try {
            const new_inside_temp = await this.query_st_temp(config().st_temp_in_id);
            const new_garage_temp = await this.query_st_temp(config().st_temp_ga_id);
            const new_outside_temp = await this.query_st_temp(config().st_temp_out_id, config().country_code, config().postal_code);

            // Update only if new values are valid and different
            if (new_inside_temp !== null && new_inside_temp !== this.#inside_temp) {
                this.#inside_temp = new_inside_temp;
            }
            if (new_garage_temp !== null && new_garage_temp !== this.#garage_temp) {
                this.#garage_temp = new_garage_temp;
            }
            if (new_outside_temp !== null && new_outside_temp !== this.#outside_temp) {
                this.#outside_temp = new_outside_temp;
            }

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Temperatures: inside=${this.#inside_temp}, garage=${this.#garage_temp}, outside=${this.#outside_temp}${RESET}`);
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] fetch_temperatures failed: ${error.toString()}${RESET}`);
        }
    }
}

// ### Heating Adjustment Class ###

// Controls heating based on electricity prices and temperatures
class HeatAdjustment {
    // Tracks the last time heaton60 was triggered (private, no getter needed as only used internally)
    #last_heaton60_time = null;

    constructor() {
        // No need to initialize private fields here since they are declared above
    }

    // Calculates the threshold price below which heating should be activated
    async calc_threshold_price(outside_temp, prices, resolution) {
        const temp_to_hours = config().temp_to_hours;

        let hours;
        if (!temp_to_hours?.length) {
            hours = 24; // Default to 24 hours if data is invalid
        } else if (!outside_temp || outside_temp <= temp_to_hours[temp_to_hours.length - 1].temp) {
            hours = temp_to_hours[temp_to_hours.length - 1].hours;
        } else if (outside_temp >= temp_to_hours[0].temp) {
            hours = temp_to_hours[0].hours;
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

        console.log(`${BLUE}[${date_string()}] HeatedHours=${hours.toFixed(2)}/24 (${heating_percentage.toFixed(1)}%) @ ${outside_temp}C, TargetPeriods=${target_elements}/${prices.length} (${resolution}), Price=${(prices[0] / 10.0).toFixed(3)}, Threshold=${(threshold_price / 10.0).toFixed(3)}${RESET}`);

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
    async adjust(mqtt_client, fetch_data_instance, write_out_csv = true) {
        try {
            await fetch_data_instance.fetch_prices();
            await fetch_data_instance.fetch_temperatures();

            const remaining_prices = fetch_data_instance.slice_prices;
            const current_price = remaining_prices[0] ?? null;
            const inside_temp = fetch_data_instance.inside_temp;
            const garage_temp = fetch_data_instance.garage_temp;
            const outside_temp = fetch_data_instance.outside_temp;
            const threshold_price = await this.calc_threshold_price(outside_temp, remaining_prices, fetch_data_instance.price_resolution);

            let heaton_value;
            const now = moment();
            const heat_on = current_price === null || current_price <= threshold_price || current_price <= 30;

            if (heat_on) {
                if (!this.#last_heaton60_time || now.diff(this.#last_heaton60_time, 'hours', true) >= 1) {
                    await mqtt_client.post_trigger('from_stmq/heat/action', 'heaton60');
                    await mqtt_client.post_trigger('from_stmq/heat/action', 'heaton15');
                    this.#last_heaton60_time = now;
                    heaton_value = 60;
                } else {
                    await mqtt_client.post_trigger('from_stmq/heat/action', 'heaton15');
                    heaton_value = 15;
                }
            } else {
                await mqtt_client.post_trigger('from_stmq/heat/action', 'heatoff');
                heaton_value = 0;
            }

            const price_for_csv = current_price !== null ? (current_price / 10.0).toFixed(3) : 'NaN';
            const temp_in_for_csv = inside_temp !== null ? inside_temp.toFixed(1) : 'NaN';
            const temp_ga_for_csv = garage_temp !== null ? garage_temp.toFixed(1) : 'NaN';
            const temp_out_for_csv = outside_temp !== null ? outside_temp.toFixed(1) : 'NaN';

            if (write_out_csv)
                await this.write_csv(price_for_csv, heaton_value, temp_in_for_csv, temp_ga_for_csv, temp_out_for_csv);

            if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] Used vals: price = ${current_price !== null ? (current_price / 10.0).toFixed(3) : 'NaN'}, threshold_price = ${threshold_price !== null ? (threshold_price / 10.0).toFixed(3) : 'NaN'}, heaton_value = ${heaton_value}, temp_in = ${temp_in_for_csv}, temp_ga = ${temp_ga_for_csv}, temp_out = ${temp_out_for_csv}${RESET}`);
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] HeatAdjustment.adjust failed: ${error.toString()}${RESET}`);
        }
    }
}

// ### Main Execution ###

(async () => {
    try {
        // Validate required configuration fields before proceeding
        const cfg = config();
        const requiredFields = ['country_code', 'postal_code', 'mqtt_address', 'mqtt_user', 'mqtt_pw'];
        const missingFields = requiredFields.filter(field => !cfg[field]);
        if (missingFields.length > 0 || !Array.isArray(cfg.temp_to_hours) || cfg.temp_to_hours.length === 0) {
            throw new Error(`Missing required configuration fields: ${missingFields.concat(cfg.temp_to_hours.length === 0 ? ['temp_to_hours'] : []).join(', ')}`);
        }

        const mqtt_client = new MqttHandler(cfg.mqtt_address, cfg.mqtt_user, cfg.mqtt_pw);
        const fetch_data_instance = new FetchData();
        const heat_adjust_instance = new HeatAdjustment();

        await mqtt_client.log_topic('to_stmq/heat/receipt');
        await heat_adjust_instance.adjust(mqtt_client, fetch_data_instance, false);

        // Schedule heat adjustment and logging to occur every 15 minutes of an hour
        schedule.scheduleJob('*/15 * * * *', async () => {
            await heat_adjust_instance.adjust(mqtt_client, fetch_data_instance, true);
        });
    } catch (error) {
        console.log(`${BLUE}[ERROR ${date_string()}] Main execution failed: ${error.toString()}${RESET}`);
        process.exit(1); // Exit with error code
    }
})();
