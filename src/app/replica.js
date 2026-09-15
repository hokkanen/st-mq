import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../storage/store.js';
import { readReplicaPublication } from '../replication/publication.js';
import { createChartService } from './chart-service.js';
import { createWebAccess } from './web-access.js';
import { fireplaceView } from './fireplace.js';
import { sensorChangesView } from './sensor-changes.js';
import { indoorAverage, HELD_TEMPERATURE_SIGNALS } from '../domain/indoor-sensors.js';
import { sensorBoundaries } from './sensor-inputs.js';
import { lastIndoorReading, indoorReadingAttention, indoorReportStatus } from './indoor-readings.js';
import { indoorStatusMetadata, recordedOutdoorObservation, recordedTemperatureAttempt,
  temperatureBoundaryStatus } from './temperature-status.js';
import { garageModelSummary, GARAGE_ALGORITHM_VERSION } from '../garage/model.js';
import { LEARNING_ALGORITHM } from './committed-learning.js';
import { migrateChargingSettings } from '../charging/settings.js';
import { CHARGER_DEFINITIONS, buildCharger } from '../charging/model.js';

const INPUTS = new Set(['mqtt', 'providers', 'simulated', 'offline']);
const unavailable = 'This replica is read-only. Make changes on the primary instance.';

function publishedCheckpointAt(snapshot, input, cursor, algorithm, now) {
  if (!snapshot || !Number.isSafeInteger(cursor) || cursor <= 0) return null;
  const row = snapshot.store.db.prepare('SELECT at,algorithm_version FROM learning_journal WHERE input=? AND id=?').get(input, cursor);
  return row?.algorithm_version === algorithm && Number.isFinite(row.at)
    && row.at <= Math.min(now, snapshot.publication.sourceAt) ? row.at : null;
}

/** Project the saved primary model only. A viewer has no current equipment,
 * control budget or cycle evaluator with which to establish live readiness. */
function homeLearningSnapshot(snapshot, checkpoint, now) {
  const recordedAt = publishedCheckpointAt(snapshot, snapshot?.input, checkpoint?.journalCursor, LEARNING_ALGORITHM, now);
  const available = checkpoint?.algorithmVersion === LEARNING_ALGORITHM && checkpoint.model?.version === 2
    && checkpoint.model.parameters && recordedAt !== null;
  return { status: available ? checkpoint.health?.status ?? 'unavailable' : 'unavailable',
    reconstruction: 'snapshot', readOnly: true, snapshotAt: snapshot?.publication.sourceAt ?? null,
    recordedAt: available ? recordedAt : null,
    adaptive: available ? { model: checkpoint.model, health: checkpoint.health ?? {},
      baselineC: checkpoint.baselineC ?? null, comfortReference: checkpoint.comfortReference ?? null,
      algorithmVersion: checkpoint.algorithmVersion, journalCursor: checkpoint.journalCursor,
      cursor: checkpoint.cursor ?? null } : null,
    metrics: null, readiness: null, outcomes: null, episode: null,
    message: available ? 'Recorded primary model. Live control readiness and completed-cycle assessments are unavailable in this snapshot.'
      : 'No compatible saved Home model is available at this snapshot boundary.' };
}

/** Show the primary's saved charging decision at the publication boundary.
 * Neither the viewer clock nor copied ownership can schedule charger actions. */
function chargingSnapshot(snapshot) {
  if (!snapshot) return null;
  const saved = snapshot.store.getState(`charging:${snapshot.input}`);
  if (!saved) return null;
  const snapshotAt = snapshot.publication.sourceAt;
  const settings = migrateChargingSettings(saved.settings ?? {});
  const chargers = CHARGER_DEFINITIONS.map(definition => {
    const id = definition.id;
    const record = saved.chargers?.[id] ?? (id === 'charger1' ? saved : {});
    const ownership = snapshot.store.getState(`charging:${snapshot.input}:${id}:ownership`)
      ?? (id === 'charger1' ? snapshot.store.getState(`charging:${snapshot.input}:ownership`) : null);
    const recorded = saved.view?.chargers?.find(charger => charger.id === id);
    const control = { ...(ownership ?? recorded?.control ?? { phase: 'unavailable', released: false }),
      enabled: settings.chargers[id].enabled, readOnly: true, snapshotAt, snapshot: null,
      reason: `${ownership?.reason ? `${ownership.reason} ` : ''}Recorded primary status; live charger health is unavailable on this read-only replica.` };
    return { ...buildCharger({ definition, settings: settings.chargers[id], timezone: settings.timezone,
      telemetry: recorded?.telemetry ?? {}, automaticSoc: record.automaticSoc, manualSoc: record.manualSoc,
      now: snapshotAt, deadlineAt: record.plan?.deadlineAt, control }),
      readOnly: true, recorded: true, snapshotAt, control,
      automaticSoc: record.automaticSoc ?? null, manualSoc: record.manualSoc ?? null,
      plan: record.plan ?? null, forecast: recorded?.forecast ?? null,
      mqtt: { connected: null, subscribed: null, reason: 'read-only-snapshot' }, error: null };
  });
  return { readOnly: true, recorded: true, snapshotAt, settings, chargers,
    coordination: saved.view?.coordination ?? null, error: null };
}

function recordedInput(store) {
  const row = store.db.prepare("SELECT payload,at FROM events WHERE type='decision' ORDER BY id DESC LIMIT 1").get();
  const decision = row ? { ...JSON.parse(row.payload), at: row.at } : null;
  if (INPUTS.has(decision?.input)) return { input: decision.input, decision };
  const scopes = [...INPUTS].flatMap(input => [input, `garage:${input}`]);
  const journal = store.db.prepare(`SELECT input FROM learning_journal WHERE input IN (${scopes.map(() => '?').join(',')})
    ORDER BY id DESC LIMIT 1`).get(...scopes);
  const input = journal?.input.replace(/^garage:/, '');
  if (INPUTS.has(input)) return { input, decision };
  const contract = store.db.prepare("SELECT key FROM state WHERE key IN ('contract:mqtt','contract:providers','contract:simulated') ORDER BY key LIMIT 1").get();
  return { input: contract ? contract.key.slice('contract:'.length) : 'offline', decision };
}

function observed(snapshot, signal, now) {
  const store = snapshot?.store;
  const knownAt = Math.min(now, snapshot?.publication.sourceAt ?? now);
  if (store && HELD_TEMPERATURE_SIGNALS.includes(signal)) {
    // A copied database can contain observations newer than its published
    // boundary. Select only evidence available at that boundary, then age the
    // displayed reading without advancing its measurement timestamp.
    const row = lastIndoorReading(store, { signal, at: knownAt, input: snapshot.input });
    if (row) {
      const current = indoorReadingAttention(row, now);
      const attentionReasons = [...new Set([...row.attentionReasons, ...current.attentionReasons])];
      const needsAttention = attentionReasons.length > 0;
      const report = indoorReportStatus(row, now, { attentionReasons });
      return { value: row.value, observedAt: row.sourceTime, receivedAt: row.receivedAt, source: row.source,
        quality: row.quality.filter(flag => flag !== 'stale'), ageMs: now - row.sourceTime, recorded: true, stale: false,
        ...(needsAttention ? { needsAttention, attentionReasons, held: true } : {}), ...report,
        ...indoorStatusMetadata(row, now, { store, knownAt, stale: report.stale ?? false }) };
    }
    const latest = recordedTemperatureAttempt(store, signal, knownAt, snapshot.input);
    return latest ? { value: null, observedAt: latest.sourceTime, source: latest.source, quality: latest.quality,
      recorded: true, stale: true, ...indoorStatusMetadata(latest, now, { stale: true }) } : null;
  }
  return recordedOutdoorObservation(store, now, { knownAt, input: snapshot?.input });
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
    const garageCheckpoint = snapshot?.store.getState(`garage:checkpoint:${snapshot.input}`);
    const garageRecordedAt = publishedCheckpointAt(snapshot, `garage:${snapshot?.input}`, garageCheckpoint?.cursor, GARAGE_ALGORITHM_VERSION, now);
    const garageModel = garageCheckpoint?.algorithmVersion === GARAGE_ALGORITHM_VERSION && garageRecordedAt !== null
      ? garageCheckpoint.model : null;
    const learningConfig = checkpoint?.learningConfiguration ?? {};
    const boundaries = snapshot ? sensorBoundaries(snapshot.store, snapshot.input, snapshot.publication.sourceAt) : {};
    const observations = Object.fromEntries([['upstairs', 'indoor_temperature'], ['downstairs', 'downstairs_temperature'],
      ['bedroom', 'bedroom_temperature'], ['outdoor', 'outdoor_temperature'], ['garage', 'garage_temperature'], ['garageFront', 'garage_temperature_2']]
      .map(([name, signal]) => {
        const reading = observed(snapshot, signal, now), changedAt = boundaries[signal];
        return [name, temperatureBoundaryStatus(reading, changedAt, now)];
      }));
    observations.indoor = indoorAverage({ indoor_temperature: observations.upstairs,
      downstairs_temperature: observations.downstairs, bedroom_temperature: observations.bedroom }, learningConfig);
    observations.indoor = temperatureBoundaryStatus(observations.indoor, checkpoint?.measurementEpochAt, now, { clearValue: true });
    return { role: 'replica', instance: { role: 'replica', readOnly: true }, readOnly: true,
      mode: 'monitoring', liveWrites: false, now, input: snapshot?.input ?? 'offline',
      replication: { state, generation: publication?.generation ?? null,
        snapshotAt: publication?.sourceAt ?? null, lastSuccessAt: publication?.verifiedAt ?? null,
        verifiedAt: publication?.verifiedAt ?? null, digest: publication?.digest ?? null,
        bytes: publication?.bytes ?? null, staleAfterMs, ...(lastError ? { error: lastError } : {}) },
      observations,
      learning: homeLearningSnapshot(snapshot, checkpoint, now),
      charging: chargingSnapshot(snapshot),
      garage: { status: 'monitoring', reason: 'Read-only replica; recorded primary evidence',
        settings: snapshot?.store.getState(`garage:configuration:${snapshot.input}`) ?? {},
        observations: { rear: observations.garage, front: observations.garageFront, outdoor: observations.outdoor },
        exposure: snapshot?.store.getState(`garage:exposure:${snapshot.input}`) ?? null,
        learning: { ...garageModelSummary(garageModel), reconstruction: 'snapshot', readOnly: true,
          snapshotAt: publication?.sourceAt ?? null, recordedAt: garageModel ? garageRecordedAt : null },
        adapter: { liveControlSupported: false, automaticControl: false, phase: 'monitoring',
          restorePending: snapshot?.store.getState(`garage:adapter:${snapshot.input}`)?.restorePending ?? false,
          blockedReasons: ['Read-only replica; live adapter health is unavailable'] } },
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
