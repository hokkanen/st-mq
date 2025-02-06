import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import moment from 'moment-timezone';

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
const csv_path = './share/st-mq/easee.csv';

// Aux function for formatting a time string
function date_string() {
	return moment.utc().format('HH:mm:ss DD-MM-YYYY') + ' UTC';
}

// Get keys from the apikey file
function config() {
	// Initialize tokens
	let configdata = {
		'user': '',
		'pw': '',
		'access_token': '',
		'refresh_token': '',
		'charger_id': '',
		'equalizer_id': ''
	};

	// Try to get the keys from the config file
	if (fs.existsSync(config_path)) {
		try {
			const filedata = JSON.parse(fs.readFileSync(config_path, 'utf8'));
			// When using options.json (HASS), filedata is the whole object
			let options = filedata;
			// When using config.json (standalone), options is a separate object
			if (filedata.hasOwnProperty('options'))
				options = filedata.options;

			// Parse the received json into the configdata object
			configdata.user = options.easee.user;
			configdata.pw = options.easee.pw;
			configdata.access_token = options.easee.access_token;
			configdata.refresh_token = options.easee.refresh_token;
			configdata.charger_id = options.easee.charger_id;
			configdata.equalizer_id = options.easee.equalizer_id;
		} catch (error) {
			console.error(`${GREEN}%s${RESET}`, `Cannot obtain tokens from ${config_path} (${date_string()})`);
			console.error(`${GREEN}%s${RESET}`, error);
		}
	} else {
		console.error(`${GREEN}%s${RESET}`, `Cannot find config file in ${config_path} (${date_string()})`);
	}
	return configdata;
}

// Update apikey file
function update_config(access_token, refresh_token) {
	// Create new apikey file structure
	let configdata = {
		'easee': {
			'user': '',
			'pw': '',
			'access_token': '',
			'refresh_token': '',
			'charger_id': '',
			'equalizer_id': ''
		}
	};
	// Use existing apikey file structure if the file exists
	if (fs.existsSync(config_path)) {
		try {
			configdata = JSON.parse(fs.readFileSync(config_path, 'utf8'));
		} catch (error) {
			console.error(`${GREEN}%s${RESET}`, `Cannot parse config data from ${config_path} (${date_string()})`);
			console.error(`${GREEN}%s${RESET}`, error);
			console.log(`${GREEN}%s${RESET}`, `Creating new ${config_path} file! (${date_string()})`);
		}
	}
	// Add tokens depending on the config file type
	if (configdata.hasOwnProperty('options')) {
		configdata.options.easee.user = 'null';
		configdata.options.easee.pw = 'null';
		configdata.options.easee.access_token = access_token;
		configdata.options.easee.refresh_token = refresh_token;
	} else {
		configdata.easee.user = 'null';
		configdata.easee.pw = 'null';
		configdata.easee.access_token = access_token;
		configdata.easee.refresh_token = refresh_token;
	}

	// Write to file
	fs.writeFileSync(config_path, JSON.stringify(configdata, null, 4), { encoding: 'utf8', flag: 'w' });
}

// Check the API response status
async function check_response(response, type, log_success) {
	if (response.status !== 200) {
		console.log(`${GREEN}%s${RESET}`, `${type} query failed (${date_string()})`);
		console.log(`${GREEN}%s${RESET}`, ` API status: ${response.status}`);
		console.log(`${GREEN}%s${RESET}`, ` API response: ${response.statusText}`);
	}
	else if (log_success) {
		console.log(`${GREEN}%s${RESET}`, `${type} query successful (${date_string()})`);
		console.log(`${GREEN}%s${RESET}`, ` API status: ${response.status}`);
		console.log(`${GREEN}%s${RESET}`, ` API response: ${response.statusText}`);
	}
	return response.status;
}

// Use credentials for authentication
async function use_credentials() {
	const user = config().user;
	const pw = config().pw;
	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: 'null' },
		body: `{"userName":"${user}","password":"${pw}"}`
	};
	let response = await fetch('https://api.easee.com/api/accounts/login', options).catch(err => console.error(`${GREEN}%s${RESET}`, err));
	return response;
}

// Update Easee tokens
async function update_tokens() {
	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: `Bearer ${config().access_token}` },
		body: `{"accessToken":"${config().access_token}","refreshToken":"${config().refresh_token}"}`
	};
	let response = await fetch('https://api.easee.com/api/accounts/refresh_token', options).catch(err => console.error(`${GREEN}%s${RESET}`, err));

	// If refresh token fails, try to use credentials for authentication a few times
	if (await check_response(response, 'Refresh token', true) === 200) {
		const data = await response.json();
		update_config(data.accessToken, data.refreshToken);
	} else {
		let attempts;
		for (attempts = 0; attempts < 3; attempts++) {
			response = await use_credentials();
			if (await check_response(response, 'Authorization', true) === 200) {
				const data = await response.json();
				update_config(data.accessToken, data.refreshToken);
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		console.error(`${GREEN}%s${RESET}`, `Authorization attempt failed ${attempts} times (${date_string()})`);
		console.error(`${GREEN}%s${RESET}`, `Unable to update authentication tokens! (${date_string()})`);
	}
}

// Fetch data from Easee API
async function fetch_data(url, id) {
	url = url.replace('{id}', id);
	let options = {
		method: 'GET',
		headers: { accept: 'application/json', Authorization: `Bearer ${config().access_token}` }
	};
	// Fetch data and check response
	let response = await fetch(url, options).catch(err => console.error(`${GREEN}%s${RESET}`, err));

	// If no success, update tokens and try again
	if (await check_response(response, id, false) !== 200) {
		await update_tokens();
		options.headers.Authorization = `Bearer ${config().access_token}`;
		response = await fetch(url, options).catch(err => console.error(`${GREEN}%s${RESET}`, err));
		if (await check_response(response, id, false) !== 200) {
			console.error(`${GREEN}%s${RESET}`, `Fetch attempt failed for device: ${id} (${date_string()})`);
			// If fetch fails, return empty object
			return {};
		}
	}
	return await response.json();
}

// Initialize the csv file if necessary
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
		fs.writeFileSync(csv_path, 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n');
}

// Write data to csv file
async function write_csv(data) {
	// Check the csv file status and create one if necessary
	await init_csv();

	// Append data to the file
	const unix_time = moment().unix();
	fs.appendFileSync(csv_path, `${unix_time},${data}\n`);
}

// Run the Easee query
async function query_device_data() {
	// Get Equalizer data
	let data_eq = await fetch_data(`https://api.easee.com/api/equalizers/{id}/state`, config().equalizer_id);

	// Get charger data
	let data_ch = await fetch_data(`https://api.easee.com/api/chargers/{id}/state`, config().charger_id);

	// Check if the data contains required keys
	const required_keys_eq = ['currentL1', 'currentL2', 'currentL3'];
	const required_keys_ch = ['inCurrentT3', 'inCurrentT4', 'inCurrentT5'];

	const is_valid_eq = required_keys_eq.every(key => key in data_eq);
	const is_valid_ch = required_keys_ch.every(key => key in data_ch);

	// Write to csv if equalizer or charger data is valid
	if (is_valid_eq || is_valid_ch) {
		// Fill missing equalizer data with zeros
		if (!is_valid_eq) {
			console.error(`${GREEN}%s${RESET}`, `No data found for '${config().equalizer_id}'! (${date_string()})`);
			console.log(`${GREEN}%s${RESET}`, `Writing '${config().charger_id}' data only (${date_string()})`);
			data_eq = { ...data_eq, currentL1: 0, currentL2: 0, currentL3: 0 };
		}
		// Fill missing charger data with zeros	
		if (!is_valid_ch) {
			console.error(`${GREEN}%s${RESET}`, `No data found for '${config().charger_id}'! (${date_string()})`);
			console.log(`${GREEN}%s${RESET}`, `Writing '${config().equalizer_id}' data only (${date_string()})`);
			data_ch = { ...data_ch, inCurrentT3: 0, inCurrentT4: 0, inCurrentT5: 0 };
		}
		// Write data to csv
		await write_csv(`${data_ch.inCurrentT3.toFixed(2)},${data_ch.inCurrentT4.toFixed(2)},${data_ch.inCurrentT5.toFixed(2)},${data_eq.currentL1.toFixed(2)},${data_eq.currentL2.toFixed(2)},${data_eq.currentL3.toFixed(2)}`);
	} else {
		console.error(`${GREEN}%s${RESET}`, `No data found for any device! (${date_string()})`);
		console.log(`${GREEN}%s${RESET}`, `The csv file is not updated (${date_string()})`);
	}

	// Debug printouts
	if (DEBUG) {
		console.log(`${GREEN}%s${RESET}`, data_ch);
		console.log(`${GREEN}%s${RESET}`, data_eq)
	}
}

// Begin execution here
(async () => {
	// Check the csv file status and create one if necessary
	await init_csv();

	// Run Easee query and write to csv file
	query_device_data();
})();
