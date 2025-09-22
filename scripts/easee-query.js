import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';

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
const CSV_FILE_PATH = join(__dirname, '..', 'share', 'st-mq', 'easee.csv');

// ### Utility Functions ###

// Formats the current or given time into a UTC time string for logging
function date_string(date = null) {
    const momentDate = date ? moment(date).utc() : moment.utc();
    return momentDate.format('HH:mm:ss DD-MM-YYYY') + ' UTC';
}

// Loads configuration from a JSON file, providing defaults if the file is missing or invalid
function config() {
    // Initialize tokens with default empty values
    const default_config = {
        user: '',
        pw: '',
        access_token: '',
        refresh_token: '',
        charger_id: '',
        equalizer_id: ''
    };

    // Check if a config file is found
    if (!fs.existsSync(CONFIG_PATH)) {
        console.log(`${GREEN}[ERROR ${date_string()}] Config file not found at ${CONFIG_PATH}${RESET}`);
        return default_config;
    }

    try {
        const file_data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        // When using options.json (HASS), file_data is the whole object
        // When using config.json (standalone), options is a separate object
        const options = file_data.options || file_data;
        return {
            ...default_config,
            user: options.easee?.user || '',
            pw: options.easee?.pw || '',
            access_token: options.easee?.access_token || '',
            refresh_token: options.easee?.refresh_token || '',
            charger_id: options.easee?.charger_id || '',
            equalizer_id: options.easee?.equalizer_id || ''
        };
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Failed to parse ${CONFIG_PATH}: ${error.toString()}${RESET}`);
        return default_config;
    }
}

// Updates the configuration file with new access and refresh tokens
function update_config(access_token, refresh_token) {
    // Create new apikey file structure
    let config_data = {
        easee: {
            user: '',
            pw: '',
            access_token: '',
            refresh_token: '',
            charger_id: '',
            equalizer_id: ''
        }
    };

    // Use existing apikey file structure if the file exists
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            config_data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (error) {
            console.log(`${GREEN}[ERROR ${date_string()}] Cannot parse config data from ${CONFIG_PATH}: ${error.toString()}${RESET}`);
            console.log(`${GREEN}[${date_string()}] Creating new config file${RESET}`);
        }
    }

    // Add tokens depending on the config file type
    if (config_data.hasOwnProperty('options')) {
        config_data.options.easee.access_token = access_token;
        config_data.options.easee.refresh_token = refresh_token;
    } else {
        config_data.easee.access_token = access_token;
        config_data.easee.refresh_token = refresh_token;
    }

    // Write to file with error handling
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config_data, null, 4), { encoding: 'utf8', flag: 'w' });
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Failed to write to config file: ${error.toString()}${RESET}`);
    }
}

// Checks the status of an API response and logs the result
async function check_response(response, type, log_success = false) {
    if (!response) {
        console.log(`${GREEN}[ERROR ${date_string()}] ${type} query failed: No response${RESET}`);
        return null;
    }
    if (response.status !== 200) {
        console.log(`${GREEN}[ERROR ${date_string()}] ${type} query failed!${RESET}`);
        console.log(`${GREEN}API status: ${response.status}${RESET}`);
        console.log(`${GREEN}API response: ${response.statusText}${RESET}`);
    } else if (log_success) {
        console.log(`${GREEN}[${date_string()}] ${type} query successful!${RESET}`);
    }
    return response.status;
}

// Authenticates using username and password to obtain new tokens
async function use_credentials() {
    const user = config().user;
    const pw = config().pw;
    const options = {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: 'null' },
        body: `{"userName":"${user}","password":"${pw}"}`
    };
    let response;
    try {
        response = await fetch('https://api.easee.com/api/accounts/login', options);
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Fetch failed in use_credentials: ${error.toString()}${RESET}`);
        return null;
    }
    return response;
}

// Updates tokens using refresh token or falls back to credentials with retries
async function update_tokens() {
    const options = {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: `Bearer ${config().access_token}` },
        body: `{"accessToken":"${config().access_token}","refreshToken":"${config().refresh_token}"}`
    };
    let response;
    try {
        response = await fetch('https://api.easee.com/api/accounts/refresh_token', options);
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Fetch failed in update_tokens: ${error.toString()}${RESET}`);
        response = null;
    }

    if (response && await check_response(response, 'Refresh token', true) === 200) {
        try {
            const data = await response.json();
            update_config(data.accessToken, data.refreshToken);
        } catch (error) {
            console.log(`${GREEN}[ERROR ${date_string()}] JSON parsing failed in update_tokens: ${error.toString()}${RESET}`);
        }
    } else {
        let attempts;
        for (attempts = 0; attempts < 3; attempts++) {
            response = await use_credentials();
            if (response && await check_response(response, 'Authorization', true) === 200) {
                try {
                    const data = await response.json();
                    update_config(data.accessToken, data.refreshToken);
                    return;
                } catch (error) {
                    console.log(`${GREEN}[ERROR ${date_string()}] JSON parsing failed in use_credentials: ${error.toString()}${RESET}`);
                }
            }
            // Add delay between retries
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log(`${GREEN}[ERROR ${date_string()}] Authorization attempt failed ${attempts} times${RESET}`);
        console.log(`${GREEN}[ERROR ${date_string()}] Unable to update authentication tokens!${RESET}`);
    }
}

// Fetches data for a device, updating tokens if necessary
async function fetch_data(url, id) {
    url = url.replace('{id}', id);
    let options = {
        method: 'GET',
        headers: { accept: 'application/json', Authorization: `Bearer ${config().access_token}` }
    };
    let response;
    try {
        response = await fetch(url, options);
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Fetch failed in fetch_data: ${error.toString()}${RESET}`);
        response = null;
    }

    if (!response || await check_response(response, id, false) !== 200) {
        await update_tokens();
        options.headers.Authorization = `Bearer ${config().access_token}`;
        try {
            response = await fetch(url, options);
        } catch (error) {
            console.log(`${GREEN}[ERROR ${date_string()}] Fetch failed in fetch_data after token update: ${error.toString()}${RESET}`);
            return {};
        }
        if (!response || await check_response(response, id, false) !== 200) {
            console.log(`${GREEN}[ERROR ${date_string()}] Fetch attempt failed for device: ${id}${RESET}`);
            // If fetch fails, return empty object
            return {};
        }
    }

    try {
        return await response.json();
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] JSON parsing failed in fetch_data: ${error.toString()}${RESET}`);
        return {};
    }
}

// Initializes the CSV file with headers if it doesn't exist or is empty
async function init_csv() {
    // Create the csv directory if it does not exist
    const csv_dir = dirname(CSV_FILE_PATH);
    try {
        if (!fs.existsSync(csv_dir)) {
            fs.mkdirSync(csv_dir, { recursive: true });
        }

        // Check if the file already exists and is not empty
        const csv_append = fs.existsSync(CSV_FILE_PATH) && fs.statSync(CSV_FILE_PATH).size > 0;

        // If the file does not exist or is empty, create file and add first line
        if (!csv_append) {
            fs.writeFileSync(CSV_FILE_PATH, 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n');
        }
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Failed to initialize CSV at ${CSV_FILE_PATH}: ${error.toString()}${RESET}`);
    }
}

// Appends data to the CSV file with error handling
async function write_csv(data) {
    // Check the csv file status and create one if necessary
    await init_csv();

    // Append data to the file
    try {
        const unix_time = moment().unix();
        fs.appendFileSync(CSV_FILE_PATH, `${unix_time},${data}\n`);
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Failed to append to CSV: ${error.toString()}${RESET}`);
    }
}

// Queries device data from Easee API and writes to CSV
async function query_device_data() {
    // Get Equalizer data
    const equalizer_data = await fetch_data(`https://api.easee.com/api/equalizers/{id}/state`, config().equalizer_id);

    // Get charger data
    const charger_data = await fetch_data(`https://api.easee.com/api/chargers/{id}/state`, config().charger_id);

    // Check if the data contains required keys
    const required_keys_eq = ['currentL1', 'currentL2', 'currentL3'];
    const required_keys_ch = ['inCurrentT3', 'inCurrentT4', 'inCurrentT5'];

    const is_valid_eq = required_keys_eq.every(key => key in equalizer_data);
    const is_valid_ch = required_keys_ch.every(key => key in charger_data);

    // Write to csv if equalizer or charger data is valid
    if (is_valid_eq || is_valid_ch) {
        // Fill missing equalizer data with zeros
        const eq_curr1 = is_valid_eq ? equalizer_data.currentL1.toFixed(2) : '0';
        const eq_curr2 = is_valid_eq ? equalizer_data.currentL2.toFixed(2) : '0';
        const eq_curr3 = is_valid_eq ? equalizer_data.currentL3.toFixed(2) : '0';
        // Fill missing charger data with zeros
        const ch_curr1 = is_valid_ch ? charger_data.inCurrentT3.toFixed(2) : '0';
        const ch_curr2 = is_valid_ch ? charger_data.inCurrentT4.toFixed(2) : '0';
        const ch_curr3 = is_valid_ch ? charger_data.inCurrentT5.toFixed(2) : '0';

        await write_csv(`${ch_curr1},${ch_curr2},${ch_curr3},${eq_curr1},${eq_curr2},${eq_curr3}`);

        if (!is_valid_eq) {
            console.log(`${GREEN}[${date_string()}] No data found for equalizer '${config().equalizer_id}', writing charger data only${RESET}`);
        }
        if (!is_valid_ch) {
            console.log(`${GREEN}[${date_string()}] No data found for charger '${config().charger_id}', writing equalizer data only${RESET}`);
        }
    } else {
        console.log(`${GREEN}[ERROR ${date_string()}] No data found for any device!${RESET}`);
        console.log(`${GREEN}[${date_string()}] The CSV file is not updated${RESET}`);
    }

    // Debug printouts
    if (DEBUG) {
        console.log(`${YELLOW}[DEBUG ${date_string()}] Charger data: ${JSON.stringify(charger_data, null, 2)}${RESET}`);
        console.log(`${YELLOW}[DEBUG ${date_string()}] Equalizer data: ${JSON.stringify(equalizer_data, null, 2)}${RESET}`);
    }
}

// ### Main Execution ###
(async () => {
    try {
        // Validate required configuration fields before proceeding
        const cfg = config();
        const errors = [];

        if (!cfg.charger_id) {
            errors.push("Missing 'charger_id'");
        }
        if (!cfg.equalizer_id) {
            errors.push("Missing 'equalizer_id'");
        }
        if (!((cfg.user && cfg.pw) || (cfg.access_token && cfg.refresh_token))) {
            errors.push("Either 'user' and 'pw' or 'access_token' and 'refresh_token' are required");
        }
        if (errors.length > 0) {
            throw new Error(errors.join('; '));
        }

        // Check the csv file status and create one if necessary
        await init_csv();

        // Run Easee query and write to csv file
        await query_device_data();
    } catch (error) {
        console.log(`${GREEN}[ERROR ${date_string()}] Main execution failed: ${error.toString()}${RESET}`);
        process.exit(1); // Exit with error code
    }
})();