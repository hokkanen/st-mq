import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';
import mqtt from 'mqtt';
import schedule from 'node-schedule';
import { XMLParser, XMLBuilder, XMLValidator } from "fast-xml-parser";

// Set debugging settings and prints
const DEBUG = false;

// Set console colors
export const RESET = '\x1b[0m';
export const BLUE = '\x1b[34m';
export const GREEN = '\x1b[32m';
export const RED = '\x1b[31m';
export const YELLOW = '\x1b[33m';

// Check if a config file is found
let config_path = './config.json'; // default path
if (fs.existsSync('./data/options.json'))
    config_path = './data/options.json'; // HASS path

// Set csv output file path
const csv_path = './share/st-mq/st-mq.csv';

// Aux function for formatting a time string
function date_string() {
    return moment.utc().format('HH:mm:ss DD-MM-YYYY') + ' UTC';
}

// Mqtt handler
class MqttHandler {

    #broker_address = null;
    #client = null;
    #logged_topics = [];

    // Create a new mqtt client and connect to the broker
    constructor(broker_address, username, password) {
        this.#broker_address = broker_address;
        const options = {
            username: username,
            password: password
        };
        this.#client = mqtt.connect(this.#broker_address, options);

        this.#client.on('error', (error) => {
            console.error(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] MQTT: client encountered error: ${error.toString()}`);
        });

        this.#client.on('connect', () => {
            console.log(`${BLUE}%s${RESET}`, `[${date_string()}] MQTT: client connected.`);
        });

        this.#client.on('offline', () => {
            console.log(`${BLUE}%s${RESET}`, `[${date_string()}] MQTT: client is offline!`);
        });

        this.#client.on('reconnect', () => {
            console.log(`${BLUE}%s${RESET}`, `[${date_string()}] MQTT: client is reconnecting.`);
        });

        this.#client.on('message', (topic, message) => {
            if (this.#logged_topics.includes(topic)) {
                console.log(`${BLUE}%s${RESET}`, `[${date_string()}] MQTT: received receipt ${topic}:${message}`);
            }
        });
    }

    // Log messages on the given topic
    async log_topic(topic, qos = 2) {
        this.#logged_topics.push(topic);

        this.#client.subscribe(topic, { qos }, (err) => {
            if (err) {
                console.error(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] MQTT: failed to subscribe to ${topic}: ${err.toString()}`);
            } else {
                console.log(`${BLUE}%s${RESET}`, `[${date_string()}] MQTT: subscribed to topic ${topic} with QoS ${qos}.`);
            }
        });
    }

    // Publish a message on the given topic
    async post_trigger(topic, msg, qos = 1) {
        this.#client.publish(topic, msg, { qos }, function (error) {
            if (error) {
                console.log(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] MQTT: failed to publish ${topic}:${msg}`);
                console.log(`${BLUE}%s${RESET}`, error);
            } else {
                console.log(`${BLUE}%s${RESET}`, `[${date_string()}] MQTT: published ${topic}:${msg} with QoS ${qos} successfully!`);
            }
        });
    }
}

// Get keys from the apikey file
function config() {
    // Initialize tokens
    let configdata = {
        'country_code': '',
        'entsoe_token': '',
        'mqtt_address': '',
        'mqtt_user': '',
        'mqtt_pw': '',
        'postal_code': '',
        'st_temp_in_id': '',
        'st_temp_out_id': '',
        'st_token': '',
        'temp_to_hours': [],
        'weather_token': ''
    };
    // Try to get the keys from the apikey file
    if (fs.existsSync(config_path)) {
        try {
            const filedata = JSON.parse(fs.readFileSync(config_path, 'utf8'));

            // When using options.json (HASS), filedata is the whole object
            let options = filedata;
            // When using config.json (standalone), options is a separate object
            if (filedata.hasOwnProperty('options'))
                options = filedata.options;

            // Parse the received json into the configdata object
            configdata.country_code = options.geoloc.country_code;
            configdata.entsoe_token = options.entsoe.token;
            configdata.mqtt_address = options.mqtt.address;
            configdata.mqtt_user = options.mqtt.user;
            configdata.mqtt_pw = options.mqtt.pw;
            configdata.postal_code = options.geoloc.postal_code;
            configdata.st_temp_in_id = options.smartthings.inside_temp_dev_id;
            configdata.st_temp_out_id = options.smartthings.outside_temp_dev_id;
            configdata.st_token = options.smartthings.token;
            configdata.temp_to_hours = options.temp_to_hours;
            configdata.weather_token = options.openweathermap.token;
        } catch (error) {
            console.error(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] Cannot parse API tokens from ${config_path}`);
            console.error(`${BLUE}%s${RESET}`, error);
        }
    }
    return configdata;
}

// Check the fetch response status
async function check_response(response, type) {
    if (!response) {
        console.log(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] ${type} query failed!`)
        console.log(`${BLUE}%s${RESET}`, ` API status: null`);
        console.log(`${BLUE}%s${RESET}`, ` API response: No response received`);
        return null; 
    }
    if (response.status === 200) {
        console.log(`${BLUE}%s${RESET}`, `[${date_string()}] ${type} query successful!`);
    }
    else {
        console.log(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] ${type} query failed!`)
        console.log(`${BLUE}%s${RESET}`, ` API status: ${response.status}`);
        console.log(`${BLUE}%s${RESET}`, ` API response: ${response.statusText}`);
    }
    return response.status;
}

// Electricity prices follow the 'Europe/Berlin' time zone
async function get_day_time_bounds_in_utc() {
    // First second of the current day (00:00:00) in 'Europe/Berlin' timezone
    const start_date = moment.tz('Europe/Berlin').startOf('day');
    // Last second of the current day (23:59:59) in 'Europe/Berlin' timezone
    const end_date = moment.tz('Europe/Berlin').endOf('day');

    // Convert to UTC time string
    const start_date_utc = start_date.clone().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
    const end_date_utc = end_date.clone().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');

    return { start_date_utc, end_date_utc };
}

// Query Ensto-E API directly to get the daily spot prices
async function query_entsoe_prices(start_date, end_date) {

    // Get Entso-E API key
    const api_key = config().entsoe_token;

    // Format the dates into the required string format at 23:00 UTC
    const period_start = `${start_date.replace(/[-:T.]/g, '').slice(0, 12)}`;
    const period_end = `${end_date.replace(/[-:T.]/g, '').slice(0, 12)}`;

    // Set additional compulsory strings for the API call
    const document_type = `A44`;
    const process_type = `A01`;
    const location_codes = {
        'fi': '10YFI-1--------U',
        'se': '10YSE-1--------K',
        'no': '10YNO-0--------C',
        'dk': '10Y1001A1001A65H',
        'is': 'IS',
        'ee': '10Y1001A1001A39I',
        'lt': '10YLT-1001A0008Q',
        'lv': '10YLV-1001A00074'
    };

    // Send API get request to Entso-E
    const request = `https://web-api.tp.entsoe.eu/api?securityToken=${api_key}` +
        `&documentType=${document_type}&processType=${process_type}&in_Domain=${location_codes[config().country_code]}` +
        `&out_Domain=${location_codes[config().country_code]}&periodStart=${period_start}&periodEnd=${period_end}`
    const response = await fetch(request).catch(error => console.log(`${BLUE}%s${RESET}`, error));

    // Get prices (if query fails, empty array is returned)
    let prices = [];
    if (await check_response(response, `Entsoe-E (${config().country_code})`) === 200) {
        // Parse the received xml into json and store price information into the returned prices array
        let json_data;
        try {
            // Hours in day may differ from 23 to 25 due to DST changes
            const hours_in_day = moment().tz('Europe/Berlin').startOf('day').add(1, 'day').diff(moment().tz('Europe/Berlin').startOf('day'), 'hours');
            prices = Array(hours_in_day); 
            json_data = new XMLParser().parse(await response.text());
            let points = json_data.Publication_MarketDocument.TimeSeries.Period.Point;
            points.forEach(function (entry) {
                let position = parseInt(entry.position) - 1; // 0-based index
                let price = parseFloat(entry['price.amount']);
                // Fill all upcoming positions to include potential duplicates omitted from the dataset
                for (let i = position; i < prices.length; i++) {
                    prices[i] = price;
                }
            });
        } catch {
            console.log(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] Cannot parse prices from the Entsoe-E API response!`)
            try {
                console.log(`${BLUE}%s${RESET}`, ` Code: ${json_data.Acknowledgement_MarketDocument.Reason.code}\n Message: ${json_data.Acknowledgement_MarketDocument.Reason.text}`);
            } catch {
                console.log(`${BLUE}%s${RESET}`, ` Cannot find error code or message!`);
            }
        }
    }

    return prices;
}

// Query Elering API directly to get the daily spot prices
async function query_elering_prices(period_start, period_end) {

    // Encode the ISO strings for the API call
    const encoded_period_start = encodeURIComponent(period_start);
    const encoded_period_end = encodeURIComponent(period_end);

    // Send API get request to Elering
    const response = await fetch(`https://dashboard.elering.ee/api/nps/price?start=${encoded_period_start}&end=${encoded_period_end}`)
        .catch(error => console.log(`${BLUE}%s${RESET}`, error));

    // Get prices (if query fails, empty array is returned)
    let prices = [];
    if (await check_response(response, 'Elering') === 200)
        try {
            let json_data = await response.json();
            json_data.data[config().country_code].forEach(function (entry) {
                prices.push(parseFloat(entry['price']));
            });
        } catch {
            console.log(`${BLUE}%s${RESET}`, `[ERROR ${date_string()}] Cannot parse prices from the Elering API response!`);
        }

    return prices;
}


// Get daily sport prices from Entso-E API or Elering API (backup)
async function get_prices() {
    // Get the bounds of the day in 'Europe/Berlin' time zone in UTC format
    const date_bounds = await get_day_time_bounds_in_utc();

    // Query Entso-E API for the daily sport prices
    let prices = await query_entsoe_prices(date_bounds.start_date_utc, date_bounds.end_date_utc);

    // If Entso-E API fails, use Elering API as a backup
    if (prices.length === 0)
        prices = await query_elering_prices(date_bounds.start_date_utc, date_bounds.end_date_utc);

    return prices;
}

async function get_heating_hours(temp) {
    // Get the temperature to hours mapping
    const temp_to_hours = config().temp_to_hours;
    // If the temperature is above the highest point or below the lowest point, return the corresponding hours
    if (temp >= temp_to_hours[0].temp) return temp_to_hours[0].hours;
    if (temp <= temp_to_hours[temp_to_hours.length - 1].temp) return temp_to_hours[temp_to_hours.length - 1].hours;

    // Find the two points between which the temperature falls
    let i = 0;
    while (temp < temp_to_hours[i].temp) i++;

    // Perform linear interpolation between the two points
    const x1 = temp_to_hours[i - 1].temp, y1 = temp_to_hours[i - 1].hours;
    const x2 = temp_to_hours[i].temp, y2 = temp_to_hours[i].hours;
    const hours = y1 + ((y2 - y1) / (x2 - x1)) * (temp - x1);

    return Math.round(hours);;
}

async function get_owm_temp(country_code, postal_code) {
    // Send API get request
    const response = await fetch(
        `http://api.openweathermap.org/data/2.5/weather?zip=${postal_code},${country_code}&appid=${config().weather_token}&units=metric`)
        .catch(error => console.log(`${BLUE}%s${RESET}`, error));
    // Return 0C if the query failed, else return true outside temperature
    if (await check_response(response, `OpenWeatherMap (${country_code}-${postal_code})`) !== 200)
        return 0.0;
    else
        return (await response.json()).main.temp;
}

async function get_st_temp(st_dev_id, country_code = '', postal_code = '') {
    // Set API request options
    const options = {
        method: 'GET',
        headers: { Authorization: `Bearer ${config().st_token}`, 'Content-Type': 'application/json' },
    };
    // Send API get request
    const response = await fetch(`https://api.smartthings.com/v1/devices/${st_dev_id}/status`, options).catch(err => console.error(`${BLUE}%s${RESET}`, err));
    // Return temperature (use OpenWeatherMap as backup if geolocation info is provided)
    if (await check_response(response, `SmartThings (${st_dev_id.substring(0, 8)})`) === 200)
        return (await response.json()).components.main.temperatureMeasurement.temperature.value;
    else if (country_code !== '' && postal_code !== '')
        return await get_owm_temp(country_code, postal_code);
    else
        return 0.0;
}

async function init_csv() {
    // Create the csv directory if it does not exist
    const csv_dir = dirname(csv_path);
    if (!fs.existsSync(csv_dir)) {
        fs.mkdirSync(csv_dir, { recursive: true });
    }

    // Check if the file already exists and is not empty
    const csv_append = fs.existsSync(csv_path) && !(fs.statSync(csv_path).size === 0);

    // If the file does not exists, create file and add first line
    if (!csv_append)
        fs.writeFileSync(csv_path, 'unix_time,price,heat_on,temp_in,temp_out\n');
}

async function write_csv(price, heaton, temp_in, temp_out) {
    // Initialize the csv directory and file if necessary
    await init_csv();

    // Append data to the file
    const unix_time = moment().unix();
    fs.appendFileSync(csv_path, `${unix_time},${price.toFixed(3)},${heaton},${temp_in.toFixed(1)},${temp_out.toFixed(1)}\n`);
}

// Control heating by publishing a message through MQTT
async function adjust_heat(mq) {

    // Get daily spot prices
    const prices = await get_prices();

    // Get the current inside temperature
    const inside_temp = await get_st_temp(config().st_temp_in_id);

    // Get the current outside temperature
    const outside_temp = await get_st_temp(config().st_temp_out_id, config().country_code, config().postal_code);

    // Calculate the number of heating hours based on the outside temperature
    const heating_hours = await get_heating_hours(outside_temp);

    // Sort the prices array
    const sorted_prices = [...prices].sort((a, b) => a - b);

    // Get the price of the threshold heating hour (most expensive hour with heating on)
    const threshold_price = sorted_prices[heating_hours - 1];

    // Index is the current ongoing hour (n-th hour of the day) in 'Europe/Berlin' time zone accounting for DST
    const index = moment().tz('Europe/Berlin').diff(moment().tz('Europe/Berlin').startOf('day'), 'hours');

    // Status print
    console.log(`${BLUE}%s${RESET}`, `[${date_string()}] heating_hours: ${heating_hours} (${outside_temp}C), price[${index}]: ${prices[index]}, threshold_price: ${threshold_price}`);

    // Publish HeatOff request if price higher than threshold and the hourly price is over 4cnt/kWh, else HeatOn
    if (prices[index] > threshold_price && prices[index] > 40) {
        await mq.post_trigger("from_stmq/heat/action", "heatoff");
        await write_csv(prices[index] / 10.0, 0, inside_temp, outside_temp);
    } else {
        await mq.post_trigger("from_stmq/heat/action", "heaton");
        await write_csv(prices[index] / 10.0, 1, inside_temp, outside_temp);
    }

    // Debugging prints
    if (DEBUG) {
        console.log(`${BLUE}%s${RESET}`, prices);
    }
}

// Begin execution here
(async () => {
    // Initialize the csv directory and file if necessary
    await init_csv();

    // Create mqtt client and log messages on topic "st/receipt"
    const mq = new MqttHandler(config().mqtt_address, config().mqtt_user, config().mqtt_pw);
    mq.log_topic('to_stmq/heat/receipt');

    // Run once and then control heating with set schedule
    adjust_heat(mq);
    schedule.scheduleJob('0 * * * *', () => adjust_heat(mq));
})();
