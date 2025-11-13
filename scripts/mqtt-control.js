import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';
import mqtt from 'mqtt';
import schedule from 'node-schedule';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ### Global Variables ###
// Debugging settings and console colors
const DEBUG = false;
const RESET = '\x1b[0m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

// Configuration and CSV paths
let CONFIG_PATH = join(__dirname, '..', 'config.json'); // default path
if (fs.existsSync(join(__dirname, '..', 'data', 'options.json'))) {
    CONFIG_PATH = join(__dirname, '..', 'data', 'options.json'); // HASS path
}
const CSV_FILE_PATH = join(__dirname, '..', 'share', 'st-mq', 'st-mq.csv');

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
        lat: '',
        lon: '',
        mqtt_address: '',
        mqtt_user: '',
        mqtt_pw: '',
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
        // When using options.json (HASS), file_data is the whole object
        // When using config.json (standalone), options is a separate object
        const options = file_data.options || file_data;
        return {
            ...default_config,
            country_code: options.geoloc?.country_code || '',
            entsoe_token: options.entsoe?.token || '',
            lat: options.geoloc?.latitude || '',
            lon: options.geoloc?.longitude || '',
            mqtt_address: options.mqtt?.address || '',
            mqtt_user: options.mqtt?.user || '',
            mqtt_pw: options.mqtt?.pw || '',
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
        const options = { username, password, reconnectPeriod: 1000 };
        this.#client = mqtt.connect(this.#broker_address, options);

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

    get broker_address() {
        return this.#broker_address;
    }

    get logged_topics() {
        return [...this.#logged_topics];
    }

    async log_topic(topic, qos = 2) {
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

    async post_trigger(topic, msg, qos = 1) {
        return new Promise((resolve, reject) => {
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
    #prices = [];
    #price_slots = [];
    #price_start_time = null;
    #price_end_time = null;
    #inside_temp = null;
    #garage_temp = null;
    #outside_temp = null;

    constructor() { }

    get inside_temp() {
        return this.#inside_temp;
    }

    get garage_temp() {
        return this.#garage_temp;
    }

    get outside_temp() {
        return this.#outside_temp;
    }


    // Compares two price arrays for equality
    are_prices_equal(prices1, prices2) {
        if (!prices1 || !prices2 || prices1.length !== prices2.length) return false;
        return prices1.every((price, index) => price === prices2[index]);
    }

    // Checks the status of an API response and logs the result
    check_response(response, type) {
        if (!response) {
            console.log(`${BLUE}[ERROR ${date_string()}] ${type} query failed: No response${RESET}`);
            return null;
        }
        if (response.status === 200) {
            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] ${type} query successful!${RESET}`);
        } else {
            console.log(`${BLUE}[ERROR ${date_string()}] ${type} query failed!${RESET}`);
            console.log(`${BLUE} API status: ${response.status}${RESET}`);
            console.log(`${BLUE} API response: ${response.statusText}${RESET}`);
        }
        return response.status;
    }

    // Infer resolution from the number of slots
    infer_resolution(slots) {
        if ([23, 24, 25].includes(slots)) return 'PT60M';
        if ([92, 96, 100].includes(slots)) return 'PT15M';
        return 'Unknown';
    }

    // Get slot corresponding to current time
    get_current_slot() {
        const remaining = this.slice_prices();
        if (this.#prices.length === 0 || remaining.length === 0) return 0; // Fallback for empty data
        return this.#prices.length - remaining.length;
    }

    // Get resolution at specific slot
    get_resolution_at(slot) {
        if (!this.#price_start_time || this.#price_slots.length === 0) return null;
        let cumulative = 0;
        for (let d = 0; d < this.#price_slots.length; d++) {
            const slots = this.#price_slots[d];
            const inferred = this.infer_resolution(slots);
            if (inferred === 'Unknown') return null;
            if (slot >= cumulative && slot < cumulative + slots) {
                return inferred;
            }
            cumulative += slots;
        }
        return null;
    }

    // Returns prices sliced from the current time, handling outdated data without modifying internal state
    slice_prices(debug_success = false) {
        if (!this.#price_start_time || !this.#price_end_time || this.#prices.length === 0 || this.#price_slots.length === 0) {
            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (no valid prices or time data)${RESET}`);
            return [];
        }

        const now = moment.tz('Europe/Berlin');
        const current_day = now.clone().startOf('day');
        let total_sliced = 0;
        let past_sliced = 0;
        let current_time = this.#price_start_time.clone();

        for (let d = 0; d < this.#price_slots.length; d++) {
            const slots = this.#price_slots[d];
            const inferred = this.infer_resolution(slots);
            if (inferred === 'Unknown') {
                console.log(`${BLUE}[ERROR ${date_string()}] Unknown resolution for day ${d} (slots: ${slots})${RESET}`);
                return [];
            }
            const interval = inferred === 'PT15M' ? 15 : 60;
            const segment_end = current_time.clone().add(slots * interval, 'minutes');

            if (segment_end.isSameOrBefore(now)) {
                total_sliced += slots;
                if (segment_end.isSameOrBefore(current_day)) {
                    past_sliced += slots;
                } else {
                    if (current_time.isBefore(current_day)) {
                        const min_to_day = current_day.diff(current_time, 'minutes', true);
                        const slots_to_day = Math.floor(min_to_day / interval);
                        past_sliced += slots_to_day;
                    }
                }
                current_time = segment_end;
                continue;
            }

            if (current_time.isBefore(current_day) && current_day.isBefore(segment_end)) {
                const min_to_day = current_day.diff(current_time, 'minutes', true);
                const slots_to_day = Math.min(slots, Math.floor(min_to_day / interval));
                past_sliced += slots_to_day;
                total_sliced += slots_to_day;
                current_time.add(slots_to_day * interval, 'minutes');
            }

            const passed_min = now.diff(current_time, 'minutes', true);
            if (passed_min < 0) {
                if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (now before segment start)${RESET}`);
                return [];
            }
            const passed_slots = Math.floor(passed_min / interval);
            total_sliced += passed_slots;

            if (total_sliced >= this.#prices.length) {
                if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (total_sliced ${total_sliced} exceeds length ${this.#prices.length})${RESET}`);
                return [];
            }

            const remaining_prices = this.#prices.slice(total_sliced);
            if (DEBUG && debug_success) console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices (${remaining_prices.length}/${this.#prices.length}): ${JSON.stringify(remaining_prices)}, Total prices sliced: ${total_sliced}, Past-day-prices sliced: ${past_sliced}${RESET}`);
            return remaining_prices;
        }

        if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Remaining prices: Empty (after all segments)${RESET}`);
        return [];
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
            if (this.check_response(response, `Entso-E (${config().country_code})`) !== 200) return { prices: [], price_slots: [], start_time: null, end_time: null };

            const json_data = new XMLParser().parse(await response.text());

            if (DEBUG) {
                //console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E JSON data:\n${JSON.stringify(json_data, null, 2)}\n${RESET}`);
            }

            if (json_data.Acknowledgement_MarketDocument) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E API error: ${json_data.Acknowledgement_MarketDocument.Reason?.text || 'Unknown error'}${RESET}`);
                return { prices: [], price_slots: [], start_time: null, end_time: null };
            }

            const doc_time_interval = json_data?.Publication_MarketDocument?.['period.timeInterval'];
            if (!doc_time_interval?.start || !doc_time_interval?.end) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: Invalid or missing period.timeInterval${RESET}`);
                return { prices: [], price_slots: [], start_time: null, end_time: null };
            }

            const doc_start = moment(doc_time_interval.start).tz('Europe/Berlin');
            const doc_end = moment(doc_time_interval.end).tz('Europe/Berlin');

            const time_series = Array.isArray(json_data?.Publication_MarketDocument?.TimeSeries)
                ? json_data.Publication_MarketDocument.TimeSeries
                : json_data?.Publication_MarketDocument?.TimeSeries
                    ? [json_data.Publication_MarketDocument.TimeSeries]
                    : [];

            if (time_series.length === 0) {
                console.log(`${BLUE}[ERROR ${date_string()}] Entso-E: No TimeSeries found${RESET}`);
                return { prices: [], price_slots: [], start_time: null, end_time: null };
            }

            let full_prices = [];
            let price_slots = [];
            let local_res_list = [];

            for (const [index, ts] of time_series.entries()) {
                const time_interval = ts?.Period?.timeInterval;
                if (!time_interval?.start || !time_interval?.end) {
                    console.log(`${BLUE}[${date_string()}] Entso-E: No timeInterval in TimeSeries[${index}], skipping${RESET}`);
                    continue;
                }

                const ts_start = moment(time_interval.start).tz('Europe/Berlin');
                const ts_end = moment(time_interval.end).tz('Europe/Berlin');
                const ts_duration_minutes = ts_end.diff(ts_start, 'minutes', true);
                const hours = ts_duration_minutes / 60;
                const ts_start_local = ts_start.format('DD-MM-YYYY');

                const resolution = ts?.Period?.resolution;
                if (!resolution) {
                    console.log(`${BLUE}[${date_string()}] Entso-E: No resolution in TimeSeries[${index}], skipping${RESET}`);
                    continue;
                }

                let interval;
                if (resolution === 'PT60M') interval = 60;
                else if (resolution === 'PT15M') interval = 15;
                else {
                    console.log(`${BLUE}[${date_string()}] Entso-E: Unsupported resolution ${resolution} in TimeSeries[${index}], skipping${RESET}`);
                    continue;
                }

                if (ts_duration_minutes % interval !== 0) {
                    console.log(`${BLUE}[${date_string()}] Entso-E: Duration ${ts_duration_minutes} not divisible by interval ${interval} in TimeSeries[${index}], skipping${RESET}`);
                    continue;
                }

                const ts_slots = ts_duration_minutes / interval;
                const points = Array.isArray(ts?.Period?.Point) ? ts.Period.Point : ts?.Period?.Point ? [ts.Period.Point] : [];
                if (points.length === 0) continue;

                let ts_prices = Array(ts_slots).fill(null);

                points.forEach(entry => {
                    const position = parseInt(entry.position, 10) - 1;
                    const price = parseFloat(entry['price.amount']);
                    if (isNaN(position) || position < 0 || position >= ts_slots || isNaN(price)) {
                        let logMsg = `${BLUE}[${date_string()}] Entso-E: `;
                        if (isNaN(position)) {
                            logMsg += `Invalid position value "${entry.position || 'missing'}" (parsed as NaN)`;
                        }
                        else if (position < 0 || position >= ts_slots) {
                            logMsg += `Out-of-bounds position ${position + 1} (expected from 1 to ${ts_slots})`;
                        }
                        else {
                            logMsg += `Invalid price value "${entry['price.amount'] || 'missing'}" (parsed as NaN) at position ${position + 1}`;
                        }
                        console.log(`${logMsg} in TimeSeries[${index}], skipping point${RESET}`);
                        return;
                    }
                    ts_prices[position] = price;
                });

                for (let i = 1; i < ts_prices.length; i++) {
                    if (ts_prices[i] === null && ts_prices[i - 1] !== null) ts_prices[i] = ts_prices[i - 1];
                }

                if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E TimeSeries[${index}] for ${ts_start_local} (Europe/Berlin time); Duration: ${ts_duration_minutes} minutes (${hours} hours); Slots: ${ts_slots} (${resolution})${RESET}`);
                local_res_list.push(`${resolution} for ${ts_start_local} (${hours}-hour-data)`);

                full_prices = full_prices.concat(ts_prices);
                price_slots.push(ts_slots);
            }

            if (DEBUG) {
                const start_str = doc_start.utc().format('HH:mm:ss DD-MM-YYYY');
                const end_str = doc_end.utc().format('HH:mm:ss DD-MM-YYYY');
                console.log(`${YELLOW}[DEBUG ${date_string()}] Entso-E Prices (from ${start_str} to ${end_str} in UTC):\n   ${JSON.stringify(full_prices)}\n   Resolution(s): ${local_res_list.join(', ')}${RESET}`);
            }

            return { prices: full_prices, price_slots, start_time: doc_start, end_time: doc_end };
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Entso-E query failed: ${error.toString()}${RESET}`);
            return { prices: [], price_slots: [], start_time: null, end_time: null };
        }
    }

    async query_elering_prices(period_start, period_end) {
        const encoded_start = encodeURIComponent(period_start);
        const encoded_end = encodeURIComponent(period_end);
        const url = `https://dashboard.elering.ee/api/nps/price?start=${encoded_start}&end=${encoded_end}`;

        try {
            const response = await fetch(url);
            if (this.check_response(response, 'Elering') !== 200) return { prices: [], price_slots: [], start_time: null, end_time: null };

            const json_data = await response.json();

            if (DEBUG) {
                //console.log(`${YELLOW}[DEBUG ${date_string()}] Elering JSON data:\n${JSON.stringify(json_data, null, 2)}\n${RESET}`);
            }

            if (!json_data.success || !json_data.data || !json_data.data[config().country_code]) {
                console.log(`${BLUE}[ERROR ${date_string()}] Elering API error: No valid data for country code ${config().country_code}${RESET}`);
                return { prices: [], price_slots: [], start_time: null, end_time: null };
            }

            const entries = json_data.data[config().country_code] || [];
            if (entries.length === 0) {
                console.log(`${BLUE}[ERROR ${date_string()}] Elering: No price data found for ${config().country_code}${RESET}`);
                return { prices: [], price_slots: [], start_time: null, end_time: null };
            }

            let resolution = 'PT60M';
            if (entries.length >= 2) {
                const time_diff = entries[1].timestamp - entries[0].timestamp;
                if (time_diff === 900) resolution = 'PT15M';
                else if (time_diff === 3600) resolution = 'PT60M';
                else console.log(`${BLUE}[${date_string()}] Elering: Unexpected timestamp difference ${time_diff}s, assuming PT60M${RESET}`);
            }

            const interval_minutes = resolution === 'PT15M' ? 15 : 60;
            const first_timestamp = moment.unix(entries[0].timestamp).tz('Europe/Berlin');
            const last_timestamp = moment.unix(entries[entries.length - 1].timestamp).tz('Europe/Berlin');
            const end_time = last_timestamp.clone().add(interval_minutes, 'minutes');

            let full_prices = [];
            let price_slots = [];
            let local_res_list = [];
            let current_day = first_timestamp.clone().startOf('day');
            let day_prices = [];
            let day_index = 0;

            const processDayPrices = () => {
                if (day_prices.length > 0) {
                    full_prices = full_prices.concat(day_prices);
                    price_slots.push(day_prices.length);
                    const slots = day_prices.length;
                    const hours = resolution === 'PT15M' ? slots / 4 : slots;
                    const duration_minutes = hours * 60;
                    const day_local = current_day.format('DD-MM-YYYY');
                    if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Elering Day[${day_index}] for ${day_local} (Europe/Berlin time); Duration: ${duration_minutes} minutes (${hours} hours); Slots: ${slots} (${resolution})${RESET}`);
                    local_res_list.push(`${resolution} for ${day_local} (${hours}-hour-data)`);
                    day_index++;
                    day_prices = [];
                }
            };

            entries.forEach(entry => {
                const ts = moment.unix(entry.timestamp).tz('Europe/Berlin');
                while (ts.isSameOrAfter(current_day.clone().add(1, 'day'))) {
                    processDayPrices();
                    current_day.add(1, 'day');
                }
                day_prices.push(parseFloat(entry.price));
            });

            processDayPrices();

            if (DEBUG) {
                const start_str = first_timestamp.utc().format('HH:mm:ss DD-MM-YYYY');
                const end_str = end_time.utc().format('HH:mm:ss DD-MM-YYYY');
                console.log(`${YELLOW}[DEBUG ${date_string()}] Elering Prices (from ${start_str} to ${end_str} in UTC):\n   ${JSON.stringify(full_prices)}\n   Resolution(s): ${local_res_list.join(', ')}${RESET}`);
            }

            return { prices: full_prices, price_slots, start_time: first_timestamp, end_time };
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] Elering query failed: ${error.toString()}${RESET}`);
            return { prices: [], price_slots: [], start_time: null, end_time: null };
        }
    }

    // Fetches temperature from FMI API
    async query_fmi_temp(lat, lon) {
        const num_lat = parseFloat(lat), num_lon = parseFloat(lon);
        const delta = 20 / 111, bbox = `${num_lon - delta},${num_lat - delta},${num_lon + delta},${num_lat + delta}`;
        const query_window_minutes = 30;
        const starttime = moment.utc().subtract(query_window_minutes, 'minutes').format('YYYY-MM-DDTHH:mm:ss') + 'Z';
        const endtime = moment.utc().format('YYYY-MM-DDTHH:mm:ss') + 'Z';
        const url = `https://opendata.fmi.fi/wfs?request=getFeature&storedquery_id=fmi::observations::weather::simple&bbox=${bbox}&parameters=t2m&starttime=${starttime}&endtime=${endtime}&timestep=10`;

        try {
            const response = await fetch(url);
            if (this.check_response(response, `FMI (${lat},${lon})`) !== 200) {
                if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] FMI full URL: ${url}${RESET}`);
                return null;
            }
            const json_data = new XMLParser().parse(await response.text());
            let members = json_data['wfs:FeatureCollection']?.['wfs:member'] || [];
            if (!Array.isArray(members)) members = [members];

            const stationMap = new Map();
            members.forEach(member => {
                const element = member['BsWfs:BsWfsElement'];
                if (element?.['BsWfs:ParameterName'] === 't2m') {
                    const [stationLat, stationLon] = (element['BsWfs:Location']?.['gml:Point']?.['gml:pos'] || '').split(' ').map(parseFloat);
                    const time = moment(element['BsWfs:Time']);
                    const value = parseFloat(element['BsWfs:ParameterValue']);
                    if (stationLat && time && !isNaN(value)) {
                        // Calculates the haversine distance between two coordinates in kilometers
                        const R = 6371, dLat = (stationLat - num_lat) * Math.PI / 180, dLon = (stationLon - num_lon) * Math.PI / 180;
                        const a = Math.sin(dLat / 2) ** 2 + Math.cos(num_lat * Math.PI / 180) * Math.cos(stationLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
                        const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

                        if (distance <= 20) {
                            const coords = `${stationLat.toFixed(5)},${stationLon.toFixed(5)}`;
                            if (!stationMap.has(coords)) stationMap.set(coords, { coords, distance, measurements: [] });
                            stationMap.get(coords).measurements.push({ temp: value, time, minutesAgo: moment().diff(time, 'minutes') });
                        }
                    }
                }
            });

            const stations = Array.from(stationMap.values()).sort((a, b) => a.distance - b.distance);

            if (DEBUG && stations.length > 0) {
                const stationLines = stations.map((s, index) => {
                    const measurements = s.measurements.sort((a, b) => b.time - a.time)
                        .map(m => `${m.temp.toFixed(1)}°C ${m.minutesAgo}mins ago`).join('; ');
                    return `   Station ${index + 1} at ${s.coords} (${s.distance.toFixed(1)}km away): ${measurements}`;
                }).join('\n');
                console.log(`${YELLOW}[DEBUG ${date_string()}] Found ${stations.length} FMI stations (data for ${query_window_minutes} min query window):\n${stationLines}${RESET}`);
            }

            const closestStation = stations[0];
            const fmiTemp = closestStation?.measurements.sort((a, b) => b.time - a.time)[0]?.temp ?? null;

            if (fmiTemp === null) {
                console.log(`${BLUE}[ERROR ${date_string()}] FMI: No valid t2m temperature data found within 20km${RESET}`);
                if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] FMI full URL: ${url}${RESET}`);
            } else if (DEBUG) {
                console.log(`${YELLOW}[DEBUG ${date_string()}] FMI Temperature: ${fmiTemp.toFixed(1)}°C${RESET}`);
            }
            return fmiTemp;
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] FMI failed: ${error.toString()}${RESET}`);
            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] FMI full URL: ${url}${RESET}`);
            return null;
        }
    }

    // Fetches temperature from OpenWeatherMap API
    async query_owm_temp(lat, lon) {
        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${config().weather_token}&units=metric`;
            const response = await fetch(url);
            if (this.check_response(response, `OpenWeatherMap (${lat},${lon})`) !== 200) return null;
            const temp = (await response.json()).main?.temp ?? null;
            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] OpenWeatherMap Temperature: ${temp?.toFixed(1) ?? 'No valid data'}°C${RESET}`);
            return temp;
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] OpenWeatherMap failed: ${error.toString()}${RESET}`);
            return null;
        }
    }

    // Fetches temperature from SmartThings API
    async query_st_temp(st_dev_id) {
        if (!st_dev_id || st_dev_id.trim() === "" || typeof st_dev_id !== 'string') {
            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Skipped query_st_temp: invalid st_dev_id="${st_dev_id}" (type: ${typeof st_dev_id})${RESET}`);
            return null;
        }
        try {
            const response = await fetch(`https://api.smartthings.com/v1/devices/${st_dev_id}/status`, {
                method: 'GET', headers: { Authorization: `Bearer ${config().st_token}`, 'Content-Type': 'application/json' }
            });
            if (this.check_response(response, `SmartThings (${st_dev_id.substring(0, 8)})`) !== 200) return null;
            const temp = (await response.json()).components?.main?.temperatureMeasurement?.temperature?.value ?? null;
            if (DEBUG && temp !== null) console.log(`${YELLOW}[DEBUG ${date_string()}] SmartThings Temperature: ${temp.toFixed(1)}°C${RESET}`);
            return temp;
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] SmartThings failed: ${error.toString()}${RESET}`);
            return null;
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
            if (this.#price_start_time && this.#price_end_time && this.#prices.length > 0 && this.#price_slots.length > 0) {
                const remaining_slots = this.slice_prices().length;
                const remaining_hours = this.#price_end_time.diff(now, 'hours', true);
                if (remaining_hours > 12) {
                    should_fetch = false;
                    if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Skipping price fetch: ${remaining_hours.toFixed(2)} hours remain (> 12, ${remaining_slots} slots)${RESET}`);
                } else {
                    if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Fetching prices: ${remaining_hours.toFixed(2)} hours remain (<= 12, ${remaining_slots} slots)${RESET}`);
                }
            }

            if (!should_fetch) return;

            let { prices: new_prices, price_slots: new_price_slots, start_time, end_time } = await this.query_entsoe_prices(start_of_period.toISOString(), end_of_period.toISOString());

            if (new_prices.length === 0 || DEBUG) {
                const elering_result = await this.query_elering_prices(start_of_period.toISOString(), end_of_period.toISOString());
                if (new_prices.length === 0) {
                    new_prices = elering_result.prices;
                    new_price_slots = elering_result.price_slots;
                    start_time = elering_result.start_time;
                    end_time = elering_result.end_time;
                }
            }

            // Update prices only if they differ or resolution/period changes
            if (new_prices.length > 0 && (!this.are_prices_equal(new_prices, this.#prices) || !this.are_prices_equal(new_price_slots, this.#price_slots) || !this.#price_start_time || !this.#price_start_time.isSame(start_time))) {
                this.#prices = new_prices;
                this.#price_slots = new_price_slots;
                this.#price_start_time = start_time;
                this.#price_end_time = end_time;
                if (DEBUG) {
                    const [start_str, end_str] = [this.#price_start_time, this.#price_end_time].map(t => t.utc().format('HH:mm:ss DD-MM-YYYY'));
                    console.log(`${YELLOW}[DEBUG ${date_string()}] Updated Prices (from ${start_str} to ${end_str} in UTC):\n   ${JSON.stringify(this.#prices)}${RESET}`);
                }
            } else if (new_prices.length === 0) {
                if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Both API calls failed, retaining existing prices${RESET}`);
            }
        } catch (error) {
            console.log(`${BLUE}[ERROR ${date_string()}] fetch_prices failed: ${error.toString()}, retaining existing prices${RESET}`);
        }
    }

    async fetch_temperatures() {
        try {
            const cfg = config();
            const new_inside_temp = await this.query_st_temp(cfg.st_temp_in_id);
            const new_garage_temp = await this.query_st_temp(cfg.st_temp_ga_id);
            let new_outside_temp = await this.query_st_temp(cfg.st_temp_out_id);
            let outside_source = new_outside_temp !== null ? 'local' : 'No data';

            if (new_outside_temp === null) {
                let fmi_temp = null;
                let owm_temp = null;
                if (cfg.country_code === 'fi') fmi_temp = await this.query_fmi_temp(cfg.lat, cfg.lon);
                if (cfg.weather_token) owm_temp = await this.query_owm_temp(cfg.lat, cfg.lon);
                new_outside_temp = fmi_temp ?? owm_temp ?? null;
                if (new_outside_temp !== null) {
                    outside_source = fmi_temp !== null ? 'FMI' : 'OWM';
                    if (fmi_temp !== null && owm_temp !== null) outside_source = `FMI, OWM gives ${owm_temp.toFixed(1)}°C`;
                }
            }

            if (new_inside_temp !== null && new_inside_temp !== this.#inside_temp) this.#inside_temp = new_inside_temp;
            if (new_garage_temp !== null && new_garage_temp !== this.#garage_temp) this.#garage_temp = new_garage_temp;
            if (new_outside_temp !== null && new_outside_temp !== this.#outside_temp) this.#outside_temp = new_outside_temp;

            // Always print temperatures in the specified format
            const inside_str = this.#inside_temp !== null ? `${this.#inside_temp.toFixed(1)}°C (local)` : 'NaN (local)';
            const garage_str = this.#garage_temp !== null ? `${this.#garage_temp.toFixed(1)}°C (local)` : 'NaN (local)';
            const outside_str = this.#outside_temp !== null ? `${this.#outside_temp.toFixed(1)}°C (${outside_source})` : 'NaN (No data)';
            console.log(`${BLUE}[${date_string()}] Temperatures: In=${inside_str}, Garage=${garage_str}, Out=${outside_str}`);
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

    constructor() { }

    // Calculates the threshold price below which heating should be activated
    async calc_threshold_price(outside_temp, prices, resolution) {
        const temp_to_hours = config().temp_to_hours;
        let hours = 24;
        if (temp_to_hours?.length) {
            if (!outside_temp || outside_temp <= temp_to_hours[temp_to_hours.length - 1].temp) {
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
        }

        const heating_percentage = (hours / 24) * 100;

        if (!Array.isArray(prices) || prices.length === 0) {
            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] calc_threshold_price: Empty or invalid prices array, returning Infinity${RESET}`);
            return Infinity;
        }

        const target_slots = Math.round((heating_percentage / 100) * prices.length);
        const sorted_prices = [...prices].sort((a, b) => a - b);
        const threshold_index = Math.max(0, Math.min(target_slots - 1, sorted_prices.length - 1));
        const threshold_price = sorted_prices[threshold_index] ?? Infinity;

        console.log(`${BLUE}[${date_string()}] HeatedHours=${hours.toFixed(2)}/24 (${heating_percentage.toFixed(1)}%) @ ${outside_temp}C, TargetSlots=${target_slots}/${prices.length} (${resolution}), Price=${(prices[0] / 10.0).toFixed(3)}, Threshold=${(threshold_price / 10.0).toFixed(3)}${RESET}`);

        return threshold_price;
    }

    // Initializes the CSV file with headers if it doesn't exist or is empty
    async init_csv() {
        const csv_dir = dirname(CSV_FILE_PATH);
        try {
            if (!fs.existsSync(csv_dir)) fs.mkdirSync(csv_dir, { recursive: true });
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

            const remaining_prices = fetch_data_instance.slice_prices(true);
            const current_price = remaining_prices[0] ?? null;
            const inside_temp = fetch_data_instance.inside_temp ?? 'NaN';
            const garage_temp = fetch_data_instance.garage_temp ?? 'NaN';
            const outside_temp = fetch_data_instance.outside_temp ?? 'NaN';
            const resolution = fetch_data_instance.get_resolution_at(fetch_data_instance.get_current_slot()) || 'Unknown';
            const threshold_price = await this.calc_threshold_price(outside_temp !== 'NaN' ? outside_temp : null, remaining_prices, resolution);

            let heaton_value;
            const now = moment.tz('Europe/Berlin');
            const heat_on = current_price === null || current_price <= threshold_price || current_price <= 30;

            if (heat_on) {
                const heaton60_day_begin = moment.tz('Europe/Berlin').startOf('day').add({ hours: 4, minutes: 45 });
                const heaton60_day_end = moment.tz('Europe/Berlin').startOf('day').add({ hours: 18, minutes: 45 });
                if (
                    (!this.#last_heaton60_time || now.diff(this.#last_heaton60_time, 'minutes', true) >= 52.5) && now.isBetween(heaton60_day_begin, heaton60_day_end, null, '[]') // 'heaton60' may be published only during daytime
                ) {
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

            if (write_out_csv) await this.write_csv(price_for_csv, heaton_value, temp_in_for_csv, temp_ga_for_csv, temp_out_for_csv);

            if (DEBUG) console.log(`${YELLOW}[DEBUG ${date_string()}] Used vals: price = ${current_price !== null ? (current_price / 10.0).toFixed(3) : 'NaN'}, threshold_price = ${threshold_price !== null ? (threshold_price / 10.0).toFixed(3) : 'NaN'}, heaton_value = ${heaton_value}, temp_in = ${temp_in_for_csv}, temp_ga = ${temp_ga_for_csv}, temp_out = ${temp_out_for_csv}${RESET}`);
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
        const requiredFields = ['country_code', 'mqtt_address', 'mqtt_user', 'mqtt_pw'];
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
        process.exit(1);
    }
})();
