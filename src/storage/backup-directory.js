import { dirname, relative, resolve, sep } from 'node:path';

/** Configuration owns retained copies; a missing current optional setting uses
 * the persistent database directory, never the service account's home. */
export function backupDirectory(config = {}) {
  return resolve(config.recording?.backupDirectory ?? resolve(config.databaseDir ?? dirname(config.dbPath ?? resolve('st-mq.sqlite')), 'backups'));
}

/** Reuse Configuration's verified Supervisor mapping. A configured path outside
 * the known /config mount has no inferred host equivalent. */
export function backupLocation(config = {}) {
  const directory = backupDirectory(config), info = config.configuration;
  const addon = config.addon === true || info?.environment === 'home-assistant';
  if (!addon) return { environment: 'standalone', folder: directory, insideApp: null, hostMappingKnown: true };
  const external = info?.externalImportPath;
  const mapped = info?.importPath === '/config/secrets.json' && typeof external === 'string'
    && /^\/addon_configs\/[a-zA-Z0-9_-]+\/secrets\.json$/.test(external);
  const suffix = relative('/config', directory);
  const insideMount = suffix !== '..' && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep);
  return { environment: 'home-assistant', folder: mapped && insideMount ? resolve(dirname(external), suffix) : null,
    insideApp: directory, hostMappingKnown: Boolean(mapped && insideMount) };
}
