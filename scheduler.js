import fs from 'fs';
import schedule from 'node-schedule';
import { spawn } from 'child_process';

// Begin execution here
(async () => {
    // Create the csv directory if it does not exist
    const csv_dir = './share/st-mq';
    if (!fs.existsSync(csv_dir)) {
        fs.mkdirSync(csv_dir, { recursive: true });
    }

    // Function to spawn a process with error handling
    const spawn_process = (command, args = [], options = { stdio: 'inherit' }) => {
        const process = spawn(command, args, options);

        process.on('error', (error) => {
            console.error(`ERROR: Could not spawn '${command} ${args.join(' ')}': ${error}`);
        });
    };

    // Spawn easee-query.js and mqtt-query.js
    spawn_process('node', ['./scripts/easee-query.js']);
    spawn_process('node', ['./scripts/mqtt-control.js']);

    // Wait for 1 second to allow easee-query and mqtt_control to create files
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Spawn chart.js web server immediately upon start
    spawn_process('npm', ['run', 'dev']);

    // Schedule chart.js server restart at 15 seconds past every 5th minute
    //schedule.scheduleJob('15 */5 * * * *', () => {
    //    spawn_process('npm', ['run', 'dev'], { stdio: 'ignore' });
    //});
})();
