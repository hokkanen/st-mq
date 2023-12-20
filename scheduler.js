import fs from 'fs';
import schedule from 'node-schedule';
import { spawn } from 'child_process';
import path from 'path';

// Set console colors
export const RESET = '\x1b[0m';
export const RED = '\x1b[31m';

// Function to spawn a process with error handling
function spawn_process(command, args = [], options = { stdio: 'inherit' }) {
    // Spawn the process
    const proc = spawn(command, args, options);
    // Check for launch errors
    proc.on('error', (error) => {
        console.error(`${RED}%s${RESET}`, `ERROR: Could not spawn '${command} ${args.join(' ')}': ${error}`);
    });
    return proc;
}

// Begin execution here
(async () => {
    // Create the csv directory if it does not exist
    const csv_dir = './share/st-mq/';
    if (!fs.existsSync(csv_dir)) {
        fs.mkdirSync(csv_dir, { recursive: true });
    }

    // Spawn mqtt-control.js and schedule restart every 55th minute if exited
    const schedule_mqtt_control = () => {
        let mqtt_control = spawn_process('node', ['./scripts/mqtt-control.js']);
        schedule.scheduleJob('55 * * * *', async () => {
            if (mqtt_control.exitCode !== null) {
                mqtt_control = spawn_process('node', ['./scripts/mqtt-control.js']);
            }
        });
    };

    // Spawn and schedule easee-query.js every 5th minute
    const schedule_easee_query = () => {
        spawn_process('node', ['./scripts/easee-query.js']);
        schedule.scheduleJob('*/5 * * * *', async () => {
            spawn_process('node', ['./scripts/easee-query.js']);
        });
    };

    // Spawn and schedule chart.js server restart at 15 seconds past every 5th minute
    const schedule_chart_server = () => {
        fs.lstat(path.dirname(csv_dir), (err, stats) => {
            if (err) return console.error(`${RED}%s${RESET}`, err);
            // Create a log stream with a flag ('a' = append, 'w' = overwrite)
            const log_stream = fs.openSync(csv_dir + 'chart-server.log', 'w');
            // Spawn the process in detached mode if the csv directory is behind symlink (no parcel reload)
            let chart_server = spawn_process('npm', ['run', 'dev'], { stdio: ['inherit', log_stream, log_stream], detached: stats.isSymbolicLink()});
            // Schedule restart if the csv directory is behind symlink (no parcel reload)
            if (stats.isSymbolicLink()) {
                schedule.scheduleJob('15 */5 * * * *', async () => {
                    if (chart_server.exitCode === null) {
                        process.kill(-chart_server.pid, 'SIGKILL');
                        await new Promise(resolve => chart_server.on('exit', resolve));
                    }
                    chart_server = spawn_process('npm', ['run', 'dev'], { stdio: ['inherit', log_stream, log_stream], detached: true });
                });
            }
        });
    };

    // Spawn the processes
    schedule_mqtt_control();
    schedule_easee_query();
    schedule_chart_server();
})();
