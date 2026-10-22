// Executed with the selected Node, without starting the application or a Store.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseEnvironment, canonical } from './linux-deployment.js';
import { relative, isAbsolute } from 'node:path';

try {
  const [release, environmentFile, runtime, source] = process.argv.slice(2);
  const environment = parseEnvironment(readFileSync(environmentFile, 'utf8'));
  const { loadConfig } = await import(pathToFileURL(join(release, 'src/app/config.js')));
  const config = loadConfig({ ...process.env, ...environment }, release);
  if (config.topology !== 'pair' || config.addon) throw new Error();
  for (const value of [config.dataDir, config.databaseDir, config.dbPath, config.pair.directory,
    config.pair.snapshotDirectory, config.pair.sourceDirectory, config.pair.snapshotExportDirectory]) {
    if (!isAbsolute(value)) throw new Error();
    for (const boundary of [runtime, source]) {
      const path = relative(canonical(boundary), canonical(value));
      if (!path || path !== '..' && !path.startsWith('../') && !isAbsolute(path)) throw new Error();
    }
  }
} catch {
  console.error('The selected commit rejected the private application configuration; no application or database was started.');
  process.exitCode = 1;
}
