import fetch from 'node-fetch';
import fs from 'fs';
import promptSync from 'prompt-sync';
import schedule from 'node-schedule';

// Set debugging settings and prints
const DEBUG = false;

const apikey_path = './workspace/apikey';
const csv_path = './workspace/consumption.csv';

function keys() {
	let access_token = '';
	let refresh_token = '';

	if (fs.existsSync(apikey_path)) {
		const keydata = fs.readFileSync(apikey_path, 'utf8').split('\n');
		access_token = keydata[0] ? keydata[0].trim() : access_token;
		refresh_token = keydata[1] ? keydata[1].trim() : refresh_token;
	}

	const json = {
		"access_token": access_token,
		"refresh_token": refresh_token
	};
	return json;
}

async function check_response(response, type) {
	if (response.status === 200) {
		console.log(`${type} query successful (${new Date().toISOString().replace(/[T]/g, ' ').slice(0, 19) + " UTC"})`);
		console.log(` API Status: ${response.status}\n API response: ${response.statusText}`);
	}
	else {
		console.log(`${type} query failed (${new Date().toISOString().replace(/[T]/g, ' ').slice(0, 19) + " UTC"})`)
		console.log(` API Status: ${response.status}\n API response: ${response.statusText}`);
	}
	return response.status;
}

async function use_credentials() {
	const user = promptSync()('Username:');
	const pw = promptSync()('Password:', { echo: '*' });
	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: 'null' },
		body: `{"userName":"${user}","password":"${pw}"}`
	};
	let response = await fetch('https://api.easee.com/api/accounts/login', options).catch(err => console.error(err));
	if (await check_response(response, 'Authorization') !== 200)
		response = await use_credentials();
	return response;
}

async function update_tokens() {
	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/*+json', Authorization: `Bearer ${keys().access_token}` },
		body: `{"accessToken":"${keys().access_token}","refreshToken":"${keys().refresh_token}"}`
	};
	let response = await fetch('https://api.easee.com/api/accounts/refresh_token', options).catch(err => console.error(err));
	if (await check_response(response, 'Refresh token') !== 200)
		response = await use_credentials();
	const data = await response.json();
	fs.writeFileSync(apikey_path, `${data.accessToken}\n${data.refreshToken}\n`, { encoding: 'utf8', flag: 'w' });
}

async function fetch_data(url, id) {
	url = url.replace('{id}', id);
	const options = {
		method: 'GET',
		headers: { accept: 'application/json', Authorization: `Bearer ${keys().access_token}` }
	};
	let response = await fetch(url, options).catch(err => console.error(err));
	let data = await response.json();
	if (await check_response(response, id) !== 200) {
		await update_tokens();
		data = await fetch_data(url, id);
	}
	return data;
}

async function write_csv(data) {
	// Check if the file already exists and is not empty
	const csv_append = fs.existsSync(csv_path) && !(fs.statSync(csv_path).size === 0);

	// If the file does not exists, create file and add first line
	if (!csv_append)
		fs.writeFileSync(csv_path, 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n');

	// Append data to the file
	const unix_time = Math.floor(Date.now() / 1000);
	fs.appendFileSync(csv_path, `${unix_time},${data}\n`);
}

async function easee_query() {

	// Create workspace directory if it does not exist
	const workdir = './workspace';
	if (!fs.existsSync(workdir))
		fs.mkdirSync(workdir, { recursive: true });

	// Get Equalizer data
	const id_eq = 'QPLSWZC4';
	const data_eq = await fetch_data(`https://api.easee.com/api/equalizers/{id}/state`, id_eq);

	// Get charger data
	const id_ch = 'EHWZBUUV';
	const data_ch = await fetch_data(`https://api.easee.com/api/chargers/{id}/state`, id_ch);

	// Write csv
	await write_csv(`${data_ch.inCurrentT3},${data_ch.inCurrentT4},${data_ch.inCurrentT5},${data_eq.currentL1},${data_eq.currentL2},${data_eq.currentL3}`);

	// Debug printouts
	if (DEBUG) {
		console.log(data_ch);
		console.log(data_eq)
	}
}

// Begin execution here
(async () => {
	// Run easee query with set schedule
	easee_query();
	schedule.scheduleJob('*/5 * * * *', easee_query);
})();
