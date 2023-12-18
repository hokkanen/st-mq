import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import schedule from 'node-schedule';

// Set debugging settings and prints
const DEBUG = false;

// Check if a config file is found
let config_path = './config.json'; // default path
if (fs.existsSync('./data/options.json'))
	config_path = './data/options.json'; // HASS path

// Set csv output file path
const csv_path = './share/st-mq/easee.csv';

// Aux function for formatting a time string
function date_string() {
	const now = new Date();
	const time = `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}:${now.getUTCSeconds().toString().padStart(2, '0')}`;
	const date = `${now.getUTCDate().toString().padStart(2, '0')}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}-${now.getUTCFullYear()}`;
	return `${time} ${date} UTC`;
}

// Get keys from the apikey file
function config() {
	// Initialize tokens
	let configdata = {
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
			configdata.access_token = options.easee.access_token;
			configdata.refresh_token = options.easee.refresh_token;
			configdata.charger_id = options.easee.charger_id;
			configdata.equalizer_id = options.easee.equalizer_id;
		} catch (error) {
			console.error(`Cannot obtain tokens from ${config_path} (${date_string()})`);
			console.error(error);
		}
	} else {
		console.error(`Cannot find config file in ${config_path} (${date_string()})`);
	}
	return configdata;
}

// Update apikey file
function update_config(access_token, refresh_token) {
	// Create new apikey file structure
	let configdata = {
		'easee': {
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
			console.error(`Cannot parse configdata from ${config_path} (${date_string()})`);
			console.error(error);
			console.error(`Creating new ${config_path} file! (${date_string()})`);
		}
	}
	// Add tokens depending on the config file type
	if (configdata.hasOwnProperty('options')) {
		configdata.options.easee.access_token = access_token;
		configdata.options.easee.refresh_token = refresh_token;
	} else {
		configdata.easee.access_token = access_token;
		configdata.easee.refresh_token = refresh_token;
	}

	// Write to file
	fs.writeFileSync(config_path, JSON.stringify(configdata, null, 4), { encoding: 'utf8', flag: 'w' });
}

// Check the API response status
async function check_response(response, type) {
	if (response.status === 200) {
		console.log(`${type} query successful (${date_string()})`);
		console.log(` API Status: ${response.status}\n API response: ${response.statusText}`);
	}
	else {
		console.log(`${type} query failed (${date_string()})`)
		console.log(` API Status: ${response.status}\n API response: ${response.statusText}`);
	}
	return response.status;
}

// Use credentials for authentication
async function use_credentials() {
	const user = config().access_token;
	const pw = config().refresh_token;
	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: 'null' },
		body: `{"userName":"${user}","password":"${pw}"}`
	};
	// Try a few times before giving up
	let i = 0;
	for (i = 0; i < 5; i++) {
		let response = await fetch('https://api.easee.com/api/accounts/login', options).catch(err => console.error(err));
		if (await check_response(response, 'Authorization') === 200) {
			return response;
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	throw new Error(`Authorization attempt failed ${i + 1} times.\nExiting now... (${date_string()})`);
}

// Update Easee tokens
async function update_tokens() {
	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: `Bearer ${config().access_token}` },
		body: `{"accessToken":"${config().access_token}","refreshToken":"${config().refresh_token}"}`
	};
	let response = await fetch('https://api.easee.com/api/accounts/refresh_token', options).catch(err => console.error(err));
	if (await check_response(response, 'Refresh token') !== 200)
		response = await use_credentials();
	const data = await response.json();
	update_config(data.accessToken, data.refreshToken);
}

// Fetch data from Easee API
async function fetch_data(url, id) {
	url = url.replace('{id}', id);
	let options = {
		method: 'GET',
		headers: { accept: 'application/json', Authorization: `Bearer ${config().access_token}` }
	};
	// Fetch data and check response
	let response = await fetch(url, options).catch(err => console.error(err));
	
	// If no success, update tokens and try again
	if (await check_response(response, id) !== 200) {
		await update_tokens();
		options.headers.Authorization = `Bearer ${config().access_token}`;
		response = await fetch(url, options).catch(err => console.error(err));
		if (await check_response(response, id) !== 200)
			throw new Error(`Fetch attempt failed for device id: ${id}\nExiting now... (${date_string()})`);
	}
	let data = await response.json();
	return data;
}

// Check the csv file status and create one if necessary
async function check_csv() {
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
    await check_csv();

	// Append data to the file
	const unix_time = Math.floor(Date.now() / 1000);
	fs.appendFileSync(csv_path, `${unix_time},${data}\n`);
}

// Run the Easee query
async function easee_query() {
	// Get Equalizer data
	const data_eq = await fetch_data(`https://api.easee.com/api/equalizers/{id}/state`, config().equalizer_id);

	// Get charger data
	const data_ch = await fetch_data(`https://api.easee.com/api/chargers/{id}/state`, config().charger_id);

	// Write csv
	await write_csv(`${data_ch.inCurrentT3.toFixed(2)},${data_ch.inCurrentT4.toFixed(2)},${data_ch.inCurrentT5.toFixed(2)},${data_eq.currentL1.toFixed(2)},${data_eq.currentL2.toFixed(2)},${data_eq.currentL3.toFixed(2)}`);

	// Debug printouts
	if (DEBUG) {
		console.log(data_ch);
		console.log(data_eq)
	}
}

// Begin execution here
(async () => {
    // Check the csv file status and create one if necessary
    await check_csv();

	// Run easee query with set schedule
	easee_query();
	schedule.scheduleJob('*/5 * * * *', easee_query);
})();
