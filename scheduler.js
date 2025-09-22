import { fileURLToPath } from 'url';
import fs from 'fs';
import schedule from 'node-schedule';
import { spawn } from 'child_process';
import path, { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set console colors
export const RESET = '\x1b[0m';
export const RED = '\x1b[31m';

// Function to spawn a process with error handling
function spawn_process(command, args = [], options = { stdio: 'inherit', cwd: __dirname }) {
    // Spawn the process
    const proc = spawn(command, args, options);
    // Check for launch errors
    proc.on('error', (error) => {
        console.error(`${RED}%s${RESET}`, `ERROR: Could not spawn '${command} ${args.join(' ')}': ${error}`);
    });
    // Log exit for debugging
    proc.on('exit', (code) => {
        if (code !== 0) {
            console.log(`${RED}Process '${command} ${args.join(' ')}' exited with code ${code}${RESET}`);
        }
    });
    return proc;
}

// Begin execution here
(async () => {
    // Create the csv directory if it does not exist
    const csv_dir = path.join(__dirname, 'share', 'st-mq');
    if (!fs.existsSync(csv_dir)) {
        fs.mkdirSync(csv_dir, { recursive: true });
    }

    // Spawn mqtt-control.js and schedule restart every 15 minutes at specified times if exited
    const schedule_mqtt_control = () => {
        let mqtt_control = spawn_process('node', [path.join(__dirname, 'scripts', 'mqtt-control.js')]);
        schedule.scheduleJob('14,29,44,59 * * * *', async () => {
            if (mqtt_control.exitCode !== null) {
                mqtt_control = spawn_process('node', [path.join(__dirname, 'scripts', 'mqtt-control.js')]);
            }
        });
    };

    // Spawn and schedule easee-query.js every 5th minute
    const schedule_easee_query = () => {
        spawn_process('node', [path.join(__dirname, 'scripts', 'easee-query.js')]);
        schedule.scheduleJob('*/5 * * * *', async () => {
            spawn_process('node', [path.join(__dirname, 'scripts', 'easee-query.js')]);
        });
    };

    // Spawn chart builder process
    const schedule_chart_builder = () => {
        let log_stream_builder;
        try {
            log_stream_builder = fs.openSync(path.join(csv_dir, 'chart-builder.log'), 'w');
        } catch (err) {
            return console.error(`${RED}%s${RESET}`, `ERROR: Could not open chart-builder.log: ${err}`);
        }
        const options = { stdio: ['inherit', log_stream_builder, log_stream_builder], cwd: __dirname };
        spawn_process('npm', ['run', 'build'], options);
    };

    // Spawn chart server process
    const schedule_chart_server = () => {
        let log_stream_server;
        try {
            log_stream_server = fs.openSync(path.join(csv_dir, 'chart-server.log'), 'w');
        } catch (err) {
            return console.error(`${RED}%s${RESET}`, `ERROR: Could not open chart-server.log: ${err}`);
        }
        const options = { stdio: ['inherit', log_stream_server, log_stream_server], cwd: __dirname };
        spawn_process('npm', ['run', 'preview'], options);
    };

    // Spawn the processes
    schedule_mqtt_control();
    schedule_easee_query();
    schedule_chart_builder();
    schedule_chart_server();
})();
