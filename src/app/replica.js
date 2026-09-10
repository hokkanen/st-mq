import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../storage/store.js';
import { readReplicaPublication } from '../replication/publication.js';
import { createChartService } from './chart-service.js';
import { createWebAccess } from './web-access.js';
import { fireplaceView } from './fireplace.js';
import { sensorChangesView } from './sensor-changes.js';
import { indoorAverage, SENSOR_SETTLING_MS } from '../domain/indoor-sensors.js';
import { sensorBoundaries } from './sensor-inputs.js';

const INPUTS = new Set(['mqtt', 'providers', 'simulated', 'offline']);
const unavailable = 'This replica is read-only. Make changes on the primary instance.';

function recordedInput(store) {
  const row = store.db.prepare("SELECT payload,at FROM events WHERE type='decision' ORDER BY id DESC LIMIT 1").get();
  const decision = row ? { ...JSON.parse(row.payload), at: row.at } : null;
  if (INPUTS.has(decision?.input)) return { input: decision.input, decision };
  const journal = store.db.prepare('SELECT input FROM learning_journal ORDER BY id DESC LIMIT 1').get();
  if (INPUTS.has(journal?.input)) return { input: journal.input, decision };
  const contract = store.db.prepare("SELECT key FROM state WHERE key IN ('contract:mqtt','contract:providers','contract:simulated') ORDER BY key LIMIT 1").get();
  return { input: contract ? contract.key.slice('contract:'.length) : 'offline', decision };
}

function observed(store, signal, now) {
  const row = store?.latestObservation(signal);
  if (!row) return null;
  const observedAt = row.sourceTime ?? null;
  const quality = row.quality ?? [];
  const acceptable = quality.every(flag => ['good', 'simulated', 'historical', 'converted_fahrenheit'].includes(flag)
    || flag === 'estimated' && row.source === 'openmeteo' && signal === 'outdoor_temperature');
  return { value: row.value, observedAt, receivedAt: row.receivedAt, source: row.source,
    quality, ageMs: Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : null, recorded: true,
    stale: !Number.isFinite(observedAt) || observedAt > now || now - observedAt > 30 * 60_000 || !acceptable };
}

/** A viewer never constructs an Engine. Each request leases one immutable,
 * verified generation, including its chart worker, until the response ends. */
export async function startReplica({ config, clock = Date.now,
  readPublication = readReplicaPublication, makeChartService = createChartService,
  installSignalHandlers = true, pairContext = null, controlAuthority = null } = {}) {
  if (config?.role !== 'replica') throw new TypeError('Replica startup requires the local replica role');
  if (!config.replication?.directory) throw new TypeError('A local replica directory is required');
  let current = null, refreshing = null, closed = false, lastError = null;
  const retiring = new Set(), signalHandlers = new Map();
  const staleAfterMs = config.replication.staleAfterMs ?? 180_000;

  function retire(snapshot) {
    if (!snapshot || snapshot.retiring || snapshot.references > 0 || !snapshot.retired) return;
    snapshot.retiring = true;
    const done = snapshot.chartService.close().catch(() => {}).finally(() => {
      snapshot.store.close(); retiring.delete(done);
    });
    retiring.add(done);
  }

  async function refresh() {
    if (closed) throw new Error('Replica viewer is closed');
    if (refreshing) return refreshing;
    refreshing = (async () => {
      // A publisher can advance twice between manifest read and worker startup.
      // Retry the latest manifest instead of opening an unverified fallback file.
      for (let attempt = 0; attempt < 3; attempt++) {
        let store, chartService;
        try {
          const publication = await readPublication(config.replication.directory);
          if (!publication) {
            lastError = current ? 'The snapshot manifest is unavailable; serving the last verified snapshot.' : null;
            return;
          }
          if (publication.generation === current?.publication.generation) { lastError = null; return; }
          store = new Store(publication.dbPath, { readOnly: true });
          const recorded = recordedInput(store);
          chartService = makeChartService({ store });
          const abort = new AbortController();
          const timeout = setTimeout(() => abort.abort(), 30_000);
          try { await chartService.overview({ signal: abort.signal }); }
          finally { clearTimeout(timeout); }
          if (closed) { await chartService.close(); store.close(); return; }
          const previous = current;
          current = { publication, store, chartService, ...recorded, references: 0, retired: false };
          lastError = null;
          if (previous) { previous.retired = true; retire(previous); }
          return;
        } catch {
          await chartService?.close(); store?.close();
          lastError = 'The latest snapshot could not be opened. Check synchronization and matching application versions.';
        }
      }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  function status(snapshot = current) {
    const now = clock(), publication = snapshot?.publication;
    const state = lastError ? 'error' : !publication ? 'waiting'
      : Math.max(now - publication.verifiedAt, now - publication.sourceAt) > staleAfterMs ? 'stale' : 'ready';
    const checkpoint = snapshot?.store.getState(`adaptive:${snapshot.input}`);
    const learningConfig = checkpoint?.learningConfiguration ?? {};
    const boundaries = snapshot ? sensorBoundaries(snapshot.store, snapshot.input, snapshot.publication.sourceAt) : {};
    const observations = Object.fromEntries([['upstairs', 'indoor_temperature'], ['downstairs', 'downstairs_temperature'],
      ['bedroom', 'bedroom_temperature'], ['outdoor', 'outdoor_temperature'], ['garage', 'garage_temperature']]
      .map(([name, signal]) => {
        const reading = observed(snapshot?.store, signal, now), changedAt = boundaries[signal];
        if (reading && Number.isFinite(changedAt)
          && (now < changedAt + SENSOR_SETTLING_MS || reading.observedAt === null || reading.observedAt < changedAt))
          Object.assign(reading, { stale: true, settling: now < changedAt + SENSOR_SETTLING_MS });
        return [name, reading];
      }));
    observations.indoor = indoorAverage({ indoor_temperature: observations.upstairs,
      downstairs_temperature: observations.downstairs, bedroom_temperature: observations.bedroom }, learningConfig);
    if (Number.isFinite(checkpoint?.measurementEpochAt) && now < checkpoint.measurementEpochAt + SENSOR_SETTLING_MS)
      Object.assign(observations.indoor, { value: null, stale: true, settling: true });
    return { role: 'replica', instance: { role: 'replica', readOnly: true }, readOnly: true,
      mode: 'monitoring', liveWrites: false, now, input: snapshot?.input ?? 'offline',
      replication: { state, generation: publication?.generation ?? null,
        snapshotAt: publication?.sourceAt ?? null, lastSuccessAt: publication?.verifiedAt ?? null,
        verifiedAt: publication?.verifiedAt ?? null, digest: publication?.digest ?? null,
        bytes: publication?.bytes ?? null, staleAfterMs, ...(lastError ? { error: lastError } : {}) },
      observations,
      sensorChanges: snapshot ? sensorChangesView(snapshot.store, snapshot.input,
        { now: snapshot.publication.sourceAt, config: learningConfig, readOnly: true,
          observedSignals: ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature'].filter((signal, i) => observations[['upstairs', 'downstairs', 'bedroom'][i]]) })
        : { available: false, readOnly: true, events: [], sensors: [] },
      contract: snapshot?.store.getState(`contract:${snapshot.input}`) ?? null,
      lastDecision: snapshot?.decision ?? null,
      recording: { historyRevision: publication?.generation ?? null,
        measuredDatabaseBytes: publication?.bytes ?? 0, parameters: [] },
      heatingTests: { available: false, reason: unavailable },
    };
  }

  async function getReadContext() {
    await refresh();
    if (closed) throw Object.assign(new Error('Replica viewer is closed'), { statusCode: 503 });
    const snapshot = current;
    if (snapshot) snapshot.references++;
    let released = false;
    return { store: snapshot?.store, chartService: snapshot?.chartService,
      engine: { clock: () => snapshot?.publication.sourceAt ?? clock(), config: { input: snapshot?.input ?? 'offline' }, plant: null,
        status: () => status(snapshot), contract: () => snapshot?.store.getState(`contract:${snapshot.input}`) ?? null,
        fireplaceStatus: () => snapshot ? fireplaceView(snapshot.store, snapshot.input, { asOf: snapshot.publication.sourceAt }) : null,
        sensorChangesStatus: () => status(snapshot).sensorChanges },
      release() {
        if (released || !snapshot) return;
        released = true; snapshot.references--; retire(snapshot);
      } };
  }

  const webAccess = createWebAccess({ config, role: 'replica', getReadContext, pairContext, controlAuthority,
    settingsReloadStatus: () => ({ available: false, busy: false, reason: unavailable }),
    staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../dist') });
  async function close() {
    if (closed) return;
    closed = true;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await webAccess.close();
    await refreshing;
    if (current) { current.retired = true; retire(current); }
    await Promise.allSettled([...retiring]);
  }
  try {
    await refresh();
    await webAccess.start();
    if (installSignalHandlers) for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { void close().catch(() => { process.exitCode = 1; }); };
      signalHandlers.set(signal, handler); process.once(signal, handler);
    }
    return { get store() { return current?.store ?? null; }, get server() { return webAccess.server; },
      webAccess, close, refresh, status };
  } catch (error) { await close(); throw error; }
}
