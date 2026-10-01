import { TIME_ZONE } from '../domain/prices.js';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
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
import { LEARNING_ALGORITHM } from './committed-learning.js';
import { chargingSettings } from '../charging/settings.js';
import { CHARGER_DEFINITIONS } from '../charging/model.js';
import { validateTargetState, validateTargetSelection } from '../charging/target.js';
import { replicaReadModel, snapshotState } from './replica-read-model.js';

const INPUTS = new Set(['mqtt', 'providers', 'simulated', 'offline']);
const unavailable = 'This slave is read-only. Make changes on the master instance.';

function publishedCheckpointAt(snapshot, input, cursor, algorithm, now) {
  if (!snapshot || !Number.isSafeInteger(cursor) || cursor <= 0) return null;
  const row = snapshot.store.db.prepare('SELECT at,algorithm_version FROM learning_journal WHERE input=? AND id=?').get(input, cursor);
  return row?.algorithm_version === algorithm && Number.isFinite(row.at)
    && row.at <= Math.min(now, snapshot.publication.sourceAt) ? row.at : null;
}

/** Project the saved master model only. A viewer has no current equipment,
 * control budget or cycle evaluator with which to establish live readiness. */
function homeLearningSnapshot(snapshot, checkpoint, now) {
  const recordedAt = publishedCheckpointAt(snapshot, snapshot?.input, checkpoint?.journalCursor, LEARNING_ALGORITHM, now);
  const available = checkpoint?.algorithmVersion === LEARNING_ALGORITHM && checkpoint.model?.version === 4
    && checkpoint.model.parameters && recordedAt !== null;
  return { status: available ? checkpoint.health?.status ?? 'unavailable' : 'unavailable',
    reconstruction: 'snapshot', readOnly: true, snapshotAt: snapshot?.publication.sourceAt ?? null,
    recordedAt: available ? recordedAt : null,
    adaptive: available ? { model: checkpoint.model, health: checkpoint.health ?? {},
      baselineC: checkpoint.baselineC ?? null, comfortReference: checkpoint.comfortReference ?? null,
      algorithmVersion: checkpoint.algorithmVersion, journalCursor: checkpoint.journalCursor,
      cursor: checkpoint.cursor ?? null } : null,
    metrics: null, readiness: null, outcomes: null, episode: null,
    parameters: available ? checkpoint.learningConfiguration ?? {} : {},
    message: available ? 'Recorded master model. Live control readiness and completed-cycle assessments are unavailable in this snapshot.'
      : 'No compatible saved Home model is available at this snapshot boundary.' };
}

/** Show the master's saved charging decision at the publication boundary.
 * Neither the viewer clock nor copied ownership can schedule charger actions. */
function chargingSnapshot(snapshot) {
  if (!snapshot) return null;
  const saved = snapshot.store.getState(`charging:${snapshot.input}`);
  if (!saved) return null;
  if (saved.version !== 6 || Object.hasOwn(saved, 'settings')) throw new Error('Unsupported charging snapshot; start a fresh development database');
  if (!saved.view?.settings || !Array.isArray(saved.view?.chargers) || CHARGER_DEFINITIONS.some(({id}) => !saved.view.chargers.some(row => row.id === id && row.values)))
    throw new Error('Malformed current charging snapshot; start a fresh development database');
  for (const record of Object.values(saved.chargers ?? {})) validateTargetState(record.targetState);
  for (const charger of saved.view.chargers) validateTargetSelection(charger.targetSelection);
  const snapshotAt = snapshot.publication.sourceAt;
  const settings = chargingSettings(saved.view.settings);
  const reception = value => ({ ...value, available: false, connected: null, brokerConnected: null, subscribed: null,
    subscriptionStatus: 'read-only-snapshot', reason: 'read-only-snapshot', readOnly: true, recorded: true, snapshotAt });
  const recordedSetup = setup => setup ? { ...structuredClone(setup), available: false, healthy: false,
    readOnly: true, recorded: true, snapshotAt,
    fields: Object.fromEntries(Object.entries(setup.fields ?? {}).map(([key, value]) => [key,
      { ...value, available: false, recorded: true, reason: 'read-only-snapshot' }])) } : null;
  const reports = saved.view.diagnostics, tests = saved.view.physicalTests;
  if (reports && (reports.version !== 1 || !Array.isArray(reports.chargers))
    || tests && (tests.version !== 2 || !Array.isArray(tests.runs)))
    throw new Error('Unsupported charging assessment snapshot; start a fresh development database');
  const recordedReport = report => report ? { ...structuredClone(report), readOnly: true, recorded: true, snapshotAt,
    liveAvailable: false, evidenceStale: report.endedAt === null || report.evidenceStale === true } : null;
  const diagnostics = reports ? { ...structuredClone(reports), readOnly: true, recorded: true, snapshotAt, liveAvailable: false,
    chargers: reports.chargers.map(slot => ({ id: slot.id, current: recordedReport(slot.current),
      recent: (slot.recent ?? []).map(recordedReport) })) } : null;
  // Preserve the master's assessment, including an unfinished test phase. A
  // viewer neither advances a run nor turns elapsed viewer time into a result.
  const physicalTests = tests ? { ...structuredClone(tests), canManage: false, readOnly: true, recorded: true, snapshotAt,
    runs: tests.runs.map(run => ({ ...run, readOnly: true, recorded: true, snapshotAt, liveAvailable: false })) } : null;
  const chargers = CHARGER_DEFINITIONS.map(definition => {
    const id = definition.id;
    const record = saved.chargers?.[id] ?? {};
    const ownership = record.association ? snapshot.store.getState(`charging:${snapshot.input}:${id}:${record.association}:ownership`) : null;
    const recorded = saved.view?.chargers?.find(charger => charger.id === id);
    const control = { ...(ownership ?? recorded?.control ?? { phase: 'unavailable', released: false }),
      enabled: settings.chargers[id].enabled, readOnly: true, snapshotAt, snapshot: null,
      reason: `${ownership?.reason ? `${ownership.reason} ` : ''}Recorded master status; live charger health is unavailable on this read-only slave.` };
    // A published view already contains the master's selected vehicle, battery
    // facts and energy assumption. Rebuilding it with this viewer's code would
    // reinterpret historical decisions and discard independently stored feeds.
    const charger = structuredClone(recorded);
    return { ...charger,
      referenceGridKwh: recorded?.referenceGridKwh ?? charger.requiredGridKwh,
      progress: recorded?.progress ?? null,
      readOnly: true, recorded: true, snapshotAt, control,
      automaticSoc: recorded?.automaticSoc ?? null,
      plan: record.plan ?? recorded?.plan ?? null, forecast: recorded?.forecast ?? null,
      mqtt: reception(recorded?.mqtt), vehicleMqtt: recorded?.vehicleMqtt ? reception(recorded.vehicleMqtt) : null,
      error: null };
  });
  return { readOnly: true, recorded: true, snapshotAt, timezone: TIME_ZONE,
    controls: saved.view.controls, settings, chargers,
    vehicleFeeds: (saved.view?.vehicleFeeds ?? []).map(feed => ({ ...feed, reception: reception(feed.reception),
      ...(feed.setup ? { setup: recordedSetup(feed.setup) } : {}) })),
    coordination: saved.view?.coordination ?? null, error: null,
    ...(diagnostics ? { diagnostics } : {}), ...(physicalTests ? { physicalTests } : {}) };
}

function recordedInput(store) {
  const row = store.db.prepare("SELECT payload,at FROM events WHERE type='decision' ORDER BY id DESC LIMIT 1").get();
  const decision = row ? { ...JSON.parse(row.payload), at: row.at } : null;
  if (INPUTS.has(decision?.input)) return { input: decision.input, decision };
  const scopes = [...INPUTS];
  const journal = store.db.prepare(`SELECT input FROM learning_journal WHERE input IN (${scopes.map(() => '?').join(',')})
    ORDER BY id DESC LIMIT 1`).get(...scopes);
  const input = journal?.input;
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
  installSignalHandlers = true, pairContext = null, controlAuthority = null, snapshotDirectory } = {}) {
  if (config?.role !== 'slave') throw new TypeError('Slave startup requires the local slave role');
  const snapshotSettings = config.topology === 'pair' ? config.pair : config.mirror;
  const directory = snapshotDirectory ?? (config.topology === 'pair' ? snapshotSettings?.snapshotDirectory : snapshotSettings?.directory);
  if (!directory) throw new TypeError('A local snapshot directory is required');
  let current = null, refreshing = null, closed = false, lastError = null;
  let closePending = null, finishStartup;
  const startupSettled = new Promise(resolve => { finishStartup = resolve; });
  const retiring = new Set(), signalHandlers = new Map();
  const staleAfterMs = snapshotSettings?.staleAfterMs ?? 180_000;

  function retire(snapshot) {
    if (!snapshot || snapshot.retiring || snapshot.references > 0 || !snapshot.retired) return;
    snapshot.retiring = true;
    const done = snapshot.chartService.close().catch(() => {}).finally(() => {
      snapshot.store.close(); retiring.delete(done);
    });
    retiring.add(done);
  }

  async function refresh() {
    if (closed) throw new Error('Slave viewer is closed');
    if (refreshing) return refreshing;
    refreshing = (async () => {
      // A publisher can advance twice between manifest read and worker startup.
      // Retry the latest manifest instead of opening an unverified fallback file.
      for (let attempt = 0; attempt < 3; attempt++) {
        let store, chartService;
        try {
          const publication = await readPublication(directory);
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
    // Source evidence and recording metrics are immutable within a verified
    // generation. Only the explicit freshness views below use the viewer clock.
    const recorded = snapshot ? structuredClone(snapshot.readModel ??= replicaReadModel(snapshot, config))
      : replicaReadModel(null, config);
    let charging;
    try { charging = chargingSnapshot(snapshot); }
    catch {
      // Invalid controller state must stay uninterpreted, while independent
      // history remains available to diagnose a failed master startup.
      charging = { available: false, readOnly: true, recorded: true, snapshotAt: publication?.sourceAt ?? null,
        settings: null, chargers: [], vehicleFeeds: [],
        error: 'The saved charging data is unavailable in this snapshot. Other recorded data remains readable.' };
    }
    const state = lastError ? 'error' : !publication ? 'waiting'
      : Math.max(now - publication.verifiedAt, now - publication.sourceAt) > staleAfterMs ? 'stale' : 'ready';
    const homeState = snapshotState(snapshot, `adaptive:${snapshot?.input}`);
    const checkpoint = homeState.value;
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
    return { ...recorded, role: 'slave', instance: { role: 'slave', readOnly: true }, readOnly: true,
      environment: 'history', automation: Object.fromEntries(['home'].map(feature => [feature, {
        ...recorded.automation?.[feature], enabled: recorded.automation?.[feature]?.enabled === true,
        available: false, activity: 'unavailable', reason: 'This computer is read-only.' }])), now, input: snapshot?.input ?? 'offline',
      sync: { state, generation: publication?.generation ?? null,
        snapshotAt: publication?.sourceAt ?? null, lastSuccessAt: publication?.verifiedAt ?? null,
        verifiedAt: publication?.verifiedAt ?? null, digest: publication?.digest ?? null,
        bytes: publication?.bytes ?? null, staleAfterMs, ...(lastError ? { error: lastError } : {}) },
      observations,
      learning: { ...homeLearningSnapshot(snapshot, checkpoint, now), ...(homeState.error ? { error: homeState.error } : {}) },
      charging,
      garage: { ...recorded.garage, status: 'monitoring', reason: recorded.garage.error ?? 'Read-only slave; recorded master evidence',
        observations: { rear: observations.garage, front: observations.garageFront, outdoor: observations.outdoor },
      },
      sensorChanges: snapshot ? sensorChangesView(snapshot.store, snapshot.input,
        { now: snapshot.publication.sourceAt, config: learningConfig, readOnly: true,
          observedSignals: ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature'].filter((signal, i) => observations[['upstairs', 'downstairs', 'bedroom'][i]]) })
        : { available: false, readOnly: true, events: [], sensors: [] },
      contract: snapshot?.store.getState(`contract:${snapshot.input}`) ?? null,
      lastDecision: snapshot?.decision ?? null,
      fireplace: snapshot ? { ...fireplaceView(snapshot.store, snapshot.input, { asOf: publication.sourceAt }),
        available: false, readOnly: true } : null,
    };
  }

  async function getReadContext() {
    await refresh();
    if (closed) throw Object.assign(new Error('Slave viewer is closed'), { statusCode: 503 });
    const snapshot = current;
    if (snapshot) snapshot.references++;
    let released = false;
    return { store: snapshot?.store, chartService: snapshot?.chartService,
      engine: { clock: () => snapshot?.publication.sourceAt ?? clock(), config: { input: snapshot?.input ?? 'offline' }, plant: null,
        status: () => status(snapshot), contract: () => snapshot?.store.getState(`contract:${snapshot.input}`) ?? null,
        fireplaceStatus: () => snapshot ? { ...fireplaceView(snapshot.store, snapshot.input, { asOf: snapshot.publication.sourceAt }),
          available: false, readOnly: true } : null,
        sensorChangesStatus: () => status(snapshot).sensorChanges },
      release() {
        if (released || !snapshot) return;
        released = true; snapshot.references--; retire(snapshot);
      } };
  }

  const webAccess = createWebAccess({ config, topology: config.topology, role: 'slave', getReadContext, pairContext, controlAuthority,
    getDatabaseExportDirectory: () => config.recording?.exportDirectory ?? homedir(),
    settingsReloadStatus: () => ({ available: false, busy: false, reason: unavailable }),
    staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../dist') });
  function close() {
    if (closePending) return closePending;
    closed = true;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    closePending = (async () => {
      await startupSettled;
      const errors = [];
      try { await webAccess.close(); } catch (error) { errors.push(error); }
      try { await refreshing; } catch (error) { errors.push(error); }
      if (current) { current.retired = true; retire(current); }
      for (const result of await Promise.allSettled([...retiring])) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, 'Slave cleanup completed with errors.');
    })();
    return closePending;
  }
  if (installSignalHandlers) for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { void close().catch(() => { process.exitCode = 1; }); };
    signalHandlers.set(signal, handler); process.once(signal, handler);
  }
  try {
    await refresh();
    if (closed) throw new Error('The slave is shutting down.');
    await webAccess.start();
    if (closed) throw new Error('The slave is shutting down.');
    finishStartup();
    return { get store() { return current?.store ?? null; }, get server() { return webAccess.server; },
      webAccess, close, refresh, status };
  } catch (error) { finishStartup(); try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; } throw error; }
}
