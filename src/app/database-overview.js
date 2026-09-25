import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SIGNAL_INFO } from '../domain/history-series.js';
import { recordingPolicy, recordedSignalInfo, RECORDING_POLICIES } from '../domain/recording-policy.js';

export const OVERVIEW_REFRESH_MS = 5 * 60_000;
const fields = (...pairs) => pairs.map(([name, description]) => ({ name, description }));
const observationFields = fields(['Value and unit', 'A numeric value, or an explicit missing value.'],
  ['Observation and receipt times', 'When the source measured it and when this application received it.'],
  ['Source and quality', 'Origin, availability and estimation flags; source details are not exposed here.']);
const learningFields = fields(
  ['Time window', 'Sample timestamp and the completed interval start/end.'],
  ['Temperatures and solar', 'Configured indoor average, contributing upstairs/downstairs/bedroom readings and weights, outdoor temperature and estimated solar radiation; unavailable values remain missing. Imported learning retains its original upstairs-only temperature.'],
  ['Control and occupancy context', 'Requested phase, room boost, target temperature, occupied/away regime and associated episode reference.'],
  ['Estimated electrical input', 'Compressor duty, nominal compressor power, auxiliary kW, total estimated heat-pump kW and their estimation basis.'],
  ['Heat destination and equipment evidence', 'Space-heating compressor duty and auxiliary kW, hot-water/space-heating route, auxiliary stage and basis, observed activity and known-mode flags.'],
  ['Heating context', 'Heating integral, supply-temperature shortfall, route and verification status.'],
  ['Property and charger energy context', 'Per-phase kWh, covered duration, contributing observation references and complete-coverage flags; not heat-pump metering.'],
  ['Interval inputs', 'Saved interval temperatures, radiation, phase, room boost, target and space-heating activity used by replay.'],
  ['Quality and lineage', 'Quality flags, source observation and availability-span references, forecast version, issue/fetch times and original content availability.'],
  ['Configuration and algorithm', 'Journal records also retain learning configuration, algorithm/configuration versions and an initial seed when required.']);
const episodeFields = fields(
  ['Episode identity and duration', 'Episode reference, start/end, completion and recovery-completion status, and observed control phases.'],
  ['Energy and equipment evidence', 'Estimated or measured basis, compressor kWh/runtime, total and recovery kWh, and observed activity/auxiliary/routing flags.'],
  ['Auxiliary energy', 'Space-heating, hot-water and recovery auxiliary kWh.'],
  ['Predictions and calibration context', 'Predicted total/recovery/auxiliary kWh and frozen recovery and auxiliary-risk assumptions.'],
  ['Replay provenance', 'Committed-history basis, forecast reference, saved learning configuration, algorithm/configuration versions and initial seed when required.']);
const nonAdaptive = [
  ['controller_phase', 'Requested controller phase', 'Normal, preheat, reduction or recovery requested by the controller.', 'When the requested phase changes or its recorded coverage is renewed.'],
  ['dhwr_request', 'Hot-water recirculation request', 'Requested circulation pulse and its expected duration; not proof of measured pump operation.', 'When a circulation pulse is requested or its end is recorded.'],
  ['learning_profit', 'Space-heating benefit after recovery', 'Estimated mean space-heating benefit for comparable completed cycles, with sample count and uncertainty; excludes hot-water service changes and unfinished attempts.', 'When the set of learning metrics changes.'],
  ['learning_aux_profit', 'Space-heating benefit with auxiliary recovery', 'The completed-cycle space-heating estimate for cycles with observed auxiliary space-heating output during recovery.', 'When the set of learning metrics changes.'],
  ['learning_recovery_error', 'Space-heating recovery-cost prediction error', 'Calculated error between the original space-heating recovery-cost prediction and assessed space-heating recovery.', 'When the set of learning metrics changes.'],
  ['learning_indoor_temperature', 'Learned normal indoor temperature', 'The saved learned normal occupied temperature; a calculated result.', 'When the set of learning metrics changes.'],
];
const importedSignals = {
  stmq: ['spot_price', 'requested_heat_mode', 'indoor_temperature', 'garage_temperature', 'outdoor_temperature'],
  easee: ['ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3', 'property_current_l1', 'property_current_l2', 'property_current_l3'],
};
const signalLabels = { ...Object.fromEntries(Object.entries(SIGNAL_INFO).map(([key, info]) => [key, info.label])),
  spot_price: 'Spot price excluding VAT and contract charges', requested_heat_mode: 'Requested legacy heating command',
  ...Object.fromEntries(importedSignals.easee.map(signal => [signal, `${signal.startsWith('ev1') ? 'Charger 1' : 'Property'} L${signal.at(-1)} current`])),
};
const empty = () => ({ count: 0, firstAt: null, lastAt: null, missingCount: 0 });
function stats(row) { return { count: Number(row?.count ?? 0), firstAt: row?.firstAt ?? null,
  lastAt: row?.lastAt ?? null, ...(row?.missingCount != null ? { missingCount: Number(row.missingCount) } : {}) }; }
function sum(rows) {
  const result = empty();
  for (const row of rows) {
    result.count += row.count; result.missingCount += row.missingCount ?? 0;
    if (row.firstAt != null) result.firstAt = result.firstAt === null ? row.firstAt : Math.min(result.firstAt, row.firstAt);
    if (row.lastAt != null) result.lastAt = result.lastAt === null ? row.lastAt : Math.max(result.lastAt, row.lastAt);
  }
  return result;
}
function item(id, label, description, values, options = {}) {
  return { id, label, description, retention: 'history', retentionDescription: 'Retained as historical records.',
    countLabel: 'records', dateBasis: 'recorded time', ...stats(values), status: values?.count ? 'present' : 'empty',
    basis: description, fields: [], ...options };
}
const quote = value => `'${value.replaceAll("'", "''")}'`;
const opaqueId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const fileSize = path => { try { return statSync(path).size; } catch { return 0; } };

/** Aggregate metadata only: no history payloads, credentials, device identifiers,
 * import paths, state keys or free-form notes leave SQLite. Every large scan is
 * performed by the read-only history worker and cached, never on control ticks. */
export function getDatabaseOverview({ store, now = Date.now() }) {
  const db = store.db;
  const aggregate = (table, first, last = first, where = '1') => stats(db.prepare(
    `SELECT COUNT(*) count,MIN(${first}) firstAt,MAX(${last}) lastAt FROM ${table} WHERE ${where}`).get());
  const grouped = (table, expression, first, last = first, extra = '') => new Map(db.prepare(
    `SELECT ${expression} category,COUNT(*) count,MIN(${first}) firstAt,MAX(${last}) lastAt ${extra}
      FROM ${table} GROUP BY category`).all().map(row => [row.category, stats(row)]));
  const groups = [];
  const add = (id, label, description, items) => groups.push({ id, label, description, items });

  // Group metadata in SQLite: history payloads and private device identities never
  // leave the database. The same policy drives the recorder and this inventory.
  const raw = "CASE WHEN json_valid(raw) THEN raw ELSE '{}' END";
  const streams = db.prepare(`SELECT source,signal,unit,import_id IS NOT NULL imported,
    json_extract(${raw},'$.recorder.policy') policyId,
    json_extract(${raw},'$.timeBasis') timeBasis,
    COUNT(*) count,MIN(COALESCE(source_time,received_at)) firstAt,
    MAX(COALESCE(source_time,received_at)) lastAt,SUM(value IS NULL) missingCount
    FROM observations GROUP BY source,signal,unit,imported,policyId,timeBasis`).all();
  const observations = new Map(), observedDatasets = new Map(), inventoryIssues = [];
  const addCount = (map, key, row) => map.set(key, sum([map.get(key) ?? empty(), stats(row)]));
  for (const row of streams) {
    const imported = row.imported || row.source.startsWith('csv:');
    let policy = imported ? recordingPolicy({ ...row, importId: 1 })
      : row.policyId && RECORDING_POLICIES[row.policyId]
        ? { id: row.policyId, ...RECORDING_POLICIES[row.policyId] }
        : recordingPolicy({ ...row, raw: { timeBasis: row.timeBasis } });
    if (!imported && !RECORDING_POLICIES[row.policyId]
      && !['event', 'every-report', 'interval', 'hourly-energy'].includes(policy.id)) {
      inventoryIssues.push('Scalar observations without a registered current writer policy are present.');
      policy = { id: 'unclassified', adaptive: false, recorded: true, label: 'Unregistered writer',
        writeBehavior: 'No current recorder policy or recognized direct writer is recorded for this stream.',
        basis: 'Original stored scalar values; verify the producer before interpreting their saving rule.' };
    }
    const csvKind = row.source.slice(4);
    const category = imported ? importedSignals[csvKind]?.includes(row.signal) ? `${csvKind}:${row.signal}` : 'import-other'
      : policy.adaptive ? 'adaptive' : row.signal;
    addCount(observations, category, row);
    if (imported) continue;
    const signal = /^[a-z][a-z0-9_]{0,100}$/.test(row.signal) ? row.signal : `unrecognized_${opaqueId(row.signal)}`;
    if (signal !== row.signal) inventoryIssues.push('An unrecognized signal identifier is listed with an opaque reference.');
    const key = JSON.stringify([signal, row.unit, policy.id]);
    const previous = observedDatasets.get(key);
    observedDatasets.set(key, { ...row, signal, policy, ...sum([previous ?? empty(), stats(row)]) });
  }
  const totalObservations = sum([...observations.values()]);
  const scalarItems = [...observedDatasets.values()].filter(row => !row.policy.adaptive).map(row => {
    const info = recordedSignalInfo(row.signal, row.unit), definition = nonAdaptive.find(([signal]) => signal === row.signal);
    const reason = row.signal === 'auxiliary_power' ? 'Calculated from exact auxiliary-output state and the nominal rating; every changed estimate is retained.'
      : row.signal.endsWith('_hours') || row.signal === 'garage_native_energy' ? 'Counter increments must remain exact; a learned tolerance must not skip a changed total.'
        : ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'garage_temperature_2'].includes(row.signal)
          ? 'Every real sensor change is retained for thermal learning; unchanged genuine reports extend availability coverage.'
          : row.signal.startsWith('floor_') ? info.basis : row.policy.basis;
    return item(row.signal, info.label, definition?.[2] ?? reason, row, {
      signal: row.signal, unit: row.unit, recordingPolicy: row.policy.id, policyLabel: row.policy.label,
      dateBasis: 'observation time, or receipt time when unavailable', retention: row.signal.startsWith('learning_') || row.signal === 'auxiliary_power' ? 'derived' : 'history',
      writeBehavior: definition?.[3] ?? row.policy.writeBehavior,
      basis: info.basis ?? row.policy.basis, fields: [...observationFields, ...fields(['Recording reason', reason])],
      facts: [{ label: 'Signal', value: row.signal }, { label: 'Unit', value: row.unit },
        { label: 'Recording policy', value: row.policy.label }, { label: 'Basis', value: info.basis ?? row.policy.basis }],
    });
  });
  // A signal may have multiple current producers or units; preserve each policy
  // without colliding disclosure identities or silently merging different units.
  const duplicateIds = new Map();
  for (const dataset of scalarItems) duplicateIds.set(dataset.id, (duplicateIds.get(dataset.id) ?? 0) + 1);
  for (const dataset of scalarItems) if (duplicateIds.get(dataset.id) > 1)
    dataset.id += `:${dataset.recordingPolicy}:${opaqueId(dataset.unit)}`;
  add('other_observations', 'Exact measurements, states and calculated history',
    'Each observed non-adaptive stream is listed below. Exact changes, every-report feedback, direct energy intervals and controller events have separate saving rules.',
    scalarItems.sort((a, b) => a.label.localeCompare(b.label)));

  const imports = grouped('imports', "CASE WHEN kind IN ('stmq','easee') THEN kind ELSE 'other' END", 'started_at', 'COALESCE(completed_at,started_at)');
  const importRows = aggregate('import_rows', 'source_time');
  const importFacts = new Map(db.prepare(`SELECT CASE WHEN kind IN ('stmq','easee') THEN kind ELSE 'other' END category,
    SUM(status='complete') complete,SUM(status='failed') failed,SUM(status='importing') importing,
    SUM(row_count) sourceRows,SUM(rejected_count) rejected FROM imports GROUP BY category`).all().map(row => [row.category, row]));
  const importItems = [];
  for (const [kind, signals] of Object.entries(importedSignals)) {
    const values = sum(signals.map(signal => observations.get(`${kind}:${signal}`) ?? empty()));
    const fact = importFacts.get(kind) ?? {};
    importItems.push(item(`csv-${kind}`, `${kind === 'stmq' ? 'Controller' : 'Easee'} CSV observations`,
      kind === 'stmq' ? 'Historical spot prices, requested heating commands, and upstairs, garage and outdoor temperatures.'
        : 'Historical charger and property currents for each of three phases. These are current snapshots, not metered kWh.', values, {
      dateBasis: 'observation time', writeBehavior: 'Once when each CSV is imported; file digests and row identities prevent duplicates.',
      fields: signals.map(signal => ({ name: signalLabels[signal], description: 'Saved value, unit, timestamp, quality and original CSV row reference.' })),
      facts: [{ label: 'Completed imports', value: fact.complete ?? 0 }, { label: 'Imports in progress', value: fact.importing ?? 0 },
        { label: 'Failed imports', value: fact.failed ?? 0 }, { label: 'Rejected source rows', value: fact.rejected ?? 0 },
        ...signals.map(signal => ({ label: `${signalLabels[signal]} records`, value: observations.get(`${kind}:${signal}`)?.count ?? 0 }))],
    }));
  }
  if (observations.get('import-other')?.count) importItems.push(item('csv-other', 'Other imported observations',
    'Imported observations outside the two supported CSV field sets.', observations.get('import-other'), { fields: observationFields }));
  importItems.push(item('original-csv-rows', 'Original CSV rows', 'Original source rows retained alongside decoded observations for provenance and re-import checks.', importRows, {
    dateBasis: 'source row time', writeBehavior: 'During CSV import.', fields: fields(['Source row', 'Original numeric CSV record, quality flags and row number.'],
      ['Import reference', 'Reference to the associated import; filenames and contents are not shown here.']) }));
  importItems.push(item('import-log', 'Import progress and deduplication', 'One record per distinct imported file; completed, incomplete and failed work remains distinguishable.', sum([...imports.values()]), {
    countLabel: 'imports', retention: 'mixed', retentionDescription: 'One retained import entry; its progress and outcome are updated in place.',
    writeBehavior: 'Created when import starts, updated as it progresses and finishes.',
    fields: fields(['Identity and provenance', 'CSV kind, file digest and private source path.'], ['Progress', 'Start/completion times, status, row count and rejected count.']) }));
  add('imports', 'Imported CSV history', 'Supported v0.7.5 controller and Easee CSVs can be imported as historical observations. Source rows and decoded observations are separate stored records, not additional measurements.', importItems);

  const snapshots = grouped('provider_snapshot_fetches', "CASE WHEN kind IN ('weather','market') THEN kind ELSE 'other' END", 'fetched_at');
  const content = stats(db.prepare(`SELECT COUNT(DISTINCT c.id) count,MIN(f.fetched_at) firstAt,MAX(f.fetched_at) lastAt
    FROM provider_snapshot_contents c LEFT JOIN provider_snapshot_fetches f ON f.content_id=c.id`).get());
  const contentCount = content.count;
  const contentStats = new Map(db.prepare(`SELECT CASE WHEN kind IN ('weather','market') THEN kind ELSE 'other' END category,
    COUNT(DISTINCT content_id) versions,SUM(content_id IS NOT NULL) referenceCount FROM provider_snapshot_fetches GROUP BY category`)
    .all().map(row => [row.category, row]));
  const snapshotItem = (kind, label, description, definitions) => {
    const c = contentStats.get(kind) ?? { versions: 0, referenceCount: 0 };
    return item(`${kind}-snapshots`, label, description, snapshots.get(kind), {
      countLabel: 'fetches', dateBasis: 'fetch time', writeBehavior: 'Each successful fetch gets a timestamped reference; changed content is stored once.',
      fields: definitions, facts: [{ label: 'Distinct referenced content versions', value: c.versions },
        { label: 'References reusing an existing version', value: Math.max(0, c.referenceCount - c.versions) }] });
  };
  add('forecasts', 'Weather forecasts', 'Forecast estimates are versioned separately from physical observations. Current solar radiation is reconstructed from the forecast available then; it is not a measured household radiation series.', [
    snapshotItem('weather', 'Temperature and solar forecasts', 'Saved forecasts from the configured weather sources, including their issuance and acquisition metadata.',
      fields(['Forecast intervals', 'Start/end time, outdoor temperature (°C) and solar radiation (W/m²), where supplied.'],
        ['Provenance and freshness', 'Provider, issue time and its basis, fetch time, acquisition health and content reference.']))]);
  const contractState = aggregate('state', 'updated_at', 'updated_at', "key LIKE 'contract:%'");
  const periods = stats(db.prepare(`SELECT COUNT(*) count,MIN(json_extract(p.value,'$.from')) firstAt,
    MAX(json_extract(p.value,'$.from')) lastAt FROM state s,json_each(CASE WHEN json_valid(s.value)
      THEN s.value ELSE '{}' END,'$.periods') p WHERE s.key LIKE 'contract:%'`).get());
  add('prices', 'Electricity prices and rates', 'Market prices and dated contract components are saved separately. All-in prices are calculated from them.', [
    snapshotItem('market', 'Spot-price snapshots', 'Published spot-price intervals and provider coverage information.',
      fields(['Price intervals', 'Interval start/end and spot price in c/kWh, with VAT/unit basis.'],
        ['Fetch and coverage', 'Provider, acquisition time, available date coverage and content version reference.'])),
    item('contract-periods', 'Dated electricity contract rates', 'The current contract document retains its dated rate periods; this is not a new document for every read.', periods, {
      countLabel: 'periods', dateBasis: 'effective start dates', retention: 'mixed',
      retentionDescription: 'Dated periods retained inside an updated current contract document; future scheduled periods can be replaced before they start.',
      writeBehavior: 'When configured rates change or a dated period is added.',
      facts: [{ label: 'Current contract documents', value: contractState.count }],
      fields: fields(['Effective period', 'Start/end and configuration provenance.'],
        ['Energy components', 'Margin and electricity tax excluding VAT; VAT rate.'],
        ['Network transfer', 'Tariff selection and dated day/night/seasonal transfer rates.']) })]);

  const journal = grouped('learning_journal', "CASE WHEN input LIKE 'garage:%' THEN 'garage:' ELSE '' END || kind", 'at');
  const cycles = aggregate('learning_cycles', 'started_at', 'COALESCE(ended_at,started_at)');
  const cycleFacts = db.prepare(`SELECT SUM(status='completed') completed,SUM(status='incomplete') incomplete,
    SUM(json_type(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.assessment')='object') assessed FROM learning_cycles`).get();
  const learningItems = ['sample', 'episode', 'context'].map(kind => item(`journal-${kind}`, {
    sample: 'Reproducible learning samples', episode: 'Learning episodes', context: 'Learning context and configuration references',
  }[kind], { sample: 'Immutable causal samples constructed from committed history.', episode: 'Immutable completed episode inputs used for learning updates.',
    context: 'Immutable reference contexts, saved configurations, seeds and baseline-reset information required to replay learning.' }[kind], journal.get(kind), {
    writeBehavior: kind === 'sample' ? 'For eligible committed 15-minute learning windows.' : kind === 'episode' ? 'When a learning episode completes.' : 'When learning context or its reference configuration must be journalled.',
      fields: kind === 'sample' ? learningFields : kind === 'episode' ? episodeFields : fields(
      ['Reference context', 'Reference timestamp, optional room observation and baseline-reset time, or adopted historical model/baseline seed and its source.'],
      ['Sensor and control transitions', 'Sensor replacement/calibration and correction, pooled floor override mode, requested phase, room boost and occupancy changes.'],
      ['Learning configuration', 'Saved control/thermal assumptions associated with this context.'],
      ['Replay versions', 'Algorithm and configuration versions, forecast reference when present, and initial model seed when required.']) }));
  for (const kind of ['sample', 'context']) learningItems.push(item(`garage-journal-${kind}`,
    kind === 'sample' ? 'Garage learning samples' : 'Garage learning context',
    kind === 'sample' ? 'Original normalized garage inputs: rear/front/outdoor temperatures, electrical and compressor evidence, charger disturbances, native availability and protection context.'
      : 'Versioned garage configuration, room-target reference, sensor changes and deterministic reconstruction seed.', journal.get(`garage:${kind}`), {
      dateBasis: 'journal time', writeBehavior: kind === 'sample' ? 'On each completed garage learning tick.' : 'When garage configuration, sensor epoch or reference context changes.',
      fields: fields(['Physical inputs', 'Temperatures in °C, electrical input in kW, compressor and charger activity as fractions; missing evidence stays unknown.'],
        ['Configuration and provenance', 'Saved configuration, current algorithm, source timing and original seed; not a repeated adaptive measurement.']) }));
  for (const [kind, values] of journal) if (!['sample', 'episode', 'context', 'garage:sample', 'garage:context'].includes(kind)) {
    inventoryIssues.push('An unrecognized learning journal kind needs a recording description.');
    learningItems.push(item(`journal-unrecognized-${opaqueId(kind)}`, `Unrecognized journal kind · ${opaqueId(kind)}`,
      'This distinct journal kind is counted separately; it has no current writer description.', values, {
        writeBehavior: 'Unrecognized writer; inspect the current producer before interpreting these records.', fields: learningFields }));
  }
  learningItems.push(item('learning-cycles', 'Cycle plans, execution and assessments', 'Each cycle contains its original plan and forecast, observations, adjustments, calculated costs and completed assessment when available.', cycles, {
    countLabel: 'cycles', retention: 'mixed', retentionDescription: 'A cycle record is updated while active and retained after completion or interruption.',
    dateBasis: 'cycle start / end', writeBehavior: 'On planning and as a cycle progresses or completes.',
    facts: [{ label: 'Completed cycles', value: cycleFacts.completed ?? 0 }, { label: 'Incomplete cycles', value: cycleFacts.incomplete ?? 0 },
      { label: 'Cycles with saved assessments', value: cycleFacts.assessed ?? 0 }],
    fields: fields(['Original plan', 'Schedule, frozen model and configuration, weather and price assumptions.'],
      ['Execution', 'Committed observations, requested phases, adjustments and coverage.'], ['Assessment', 'Recorded cycle cost, comparable space-heating cost and benefit, space-heating recovery error and uncertainty; hot-water service is excluded from benefit.']) }));
  add('learning', 'Learning history', 'These are stored model records and calculated results. Explaining or selecting the home model’s inputs is a separate feature.', learningItems);

  const fireplace = grouped('fireplace_events', "CASE WHEN kind IN ('load','remove') THEN kind ELSE 'other' END", 'at');
  const retractedLoads = db.prepare(`SELECT COUNT(*) count FROM fireplace_events loads JOIN
    (SELECT input,target_id FROM fireplace_events WHERE kind='remove' GROUP BY input,target_id) corrections
    ON corrections.input=loads.input AND corrections.target_id=loads.id WHERE loads.kind='load'`).get().count;
  add('fireplace', 'Fireplace history', 'Firewood additions and corrections are retained once. Delayed heat inputs are reconstructed from this history during learning; each correction does not store another copy of the training journal.', [
    item('fireplace-loads', 'Recorded firewood additions', 'Reported loads for either fireplace and subsequent additions. This inventory includes retained mistaken entries as well as current entries, beyond the dashboard’s 48-hour list.', fireplace.get('load'), {
      countLabel: 'additions', dateBasis: 'recording time', writeBehavior: 'Once per distinct submission; retrying the same request does not add another load.',
      retentionDescription: 'Original additions remain in history, including entries later marked mistaken.',
      facts: [{ label: 'Unretracted additions', value: (fireplace.get('load')?.count ?? 0) - retractedLoads },
        { label: 'Retracted additions', value: retractedLoads }],
      fields: fields(['Fuel addition', 'Whole kilograms of dry firewood and the server-recorded addition time; reported fuel is not measured delivered heat.'],
        ['Recording identity', 'Input stream and unique submission identity used to distinguish additions from retries; identifiers are not displayed here.']) }),
    item('fireplace-corrections', 'Mistaken-entry corrections', 'Retractions identify the original load and when the mistake was recorded. A correction changes effective learning inputs while retaining the original entry.', fireplace.get('remove'), {
      countLabel: 'corrections', dateBasis: 'correction time', writeBehavior: 'When a saved entry is marked mistaken; retries of the same request reuse its correction.',
      fields: fields(['Correction time', 'When the correction was received, separately from the original addition time.'],
        ['Original entry reference', 'The load being retracted and the correction’s submission identity; identifiers are not displayed here.']) }),
    ...(fireplace.get('other')?.count ? [item('fireplace-other', 'Additional fireplace records',
      'Other fireplace record kinds retained in this database; original contents are not displayed here.', fireplace.get('other'))] : []),
  ]);

  const stateCategories = [
    ['contract', "key LIKE 'contract:%'", 'Contract documents', 'Dated electricity rates; their periods are described above.'],
    ['heat-power', "key LIKE 'heat-pump-power-config:%'", 'Heat-pump power assumptions', 'Current nominal compressor, circulation and auxiliary power assumptions; historical changes are retained in configuration events.'],
    ['recorder', "key LIKE 'recorder:%'", 'Adaptive recorder checkpoints', 'Shared storage feedback, learned per-signal scales, last saved values, coverage cursors and pending phase or total energy intervals.'],
    ['acquisition', "key LIKE 'provider:%' OR key='providers:health' OR key='electricity:acquisition'", 'Provider and electricity acquisition state', 'Latest provider responses, source health/backoff and unfinished electrical integration and charging sessions needed to resume acquisition.'],
    ['session-checks', "key LIKE 'charging-session-check:%' OR key LIKE 'easee:session-check:%' OR key LIKE 'easee:session-check-head:%'", 'Charging comparison identities', 'Hashed session identities prevent duplicate finalized comparisons; raw provider identifiers are not copied into checks.'],
    ['learning', "key LIKE 'learning:%' OR key LIKE 'adaptive:%' OR key LIKE 'learned:%'", 'Learning checkpoints and progress', 'Current fitted model, replay cursor, baseline, metrics and history rebuild progress.'],
    ['fireplace', "key LIKE 'fireplace:%'", 'Fireplace reconstruction progress', 'Current correction revision, background reconstruction status and progress. A replacement model is activated after reconstruction completes.'],
    ['recovery', "key LIKE 'recovery:%'", 'History recovery progress', 'Current manual recovery progress and its accepted, conflicting and skipped record counts. The complete reconstructed model is published after catching up live learning.'],
    ['settings', "key LIKE 'settings:%' OR key LIKE 'occupancy:%' OR key LIKE 'override:%'", 'Settings and temporary overrides', 'Current operating settings, occupancy and expiring manual overrides; credentials remain in external configuration.'],
    ['control', "key LIKE 'executor:%' OR key LIKE 'h66:%' OR key LIKE 'applied:%' OR key LIKE 'pending-plan:%' OR key LIKE 'phase-snapshot:%' OR key LIKE 'dhwr:%' OR key LIKE 'heating-test:%' OR key LIKE 'cycle:%' OR key LIKE 'trials:%' OR key LIKE 'native-room-reference:%'", 'Control execution and active plans', 'Execution/readback/restoration state, native room reference, active cycle, pending plan, phase coverage and bounded trial allowance.'],
    ['floor', "key='floor-override:v1'", 'Floor override restoration', 'Current ownership, sequence, outstanding release obligations and latest result. Individual contact history is listed under exact measurements.'],
    ['equipment-tests', "key='equipment-tests:v1'", 'Equipment tests and manual operations', 'Current bounded equipment operation, restoration requirement and latest test result.'],
    ['equipment-doors', "key LIKE 'equipment:door:%'", 'Last reported door contacts', 'Latest event-only contact state and route identity retained across reconnects; original changes are recorded separately.'],
    ['equipment-energy', "key LIKE 'shelly:%energy:%' OR key LIKE 'mqtt:equipment-energy:%'", 'Equipment meter accumulation', 'Current counter baseline, reset/gap evidence and pending caravan or other metered-equipment accumulation.'],
    ['charging-ownership', "key LIKE 'charging:%:ownership' OR key LIKE 'charging:%:ownership:ocpp'", 'Charger ownership and restoration', 'Device-bound control permission, native baseline and unfinished current-limit restoration.'],
    ['charging', "key LIKE 'charging:%' OR key LIKE 'shelly-evse:%'", 'Charging choices, sessions and device state', 'Device-bound Automatic charging and shared priority choices survive restart and unplugging. Physical connections, energy baselines, vehicle observations, session edits, schedules and charger-controller state are also retained. Battery and ready-by defaults remain configured.'],
    ['easee-ocpp', "key LIKE 'easee:ocpp%'", 'Charger 1 OCPP setup', 'Current native OCPP setup verification, saved restoration baseline and control readiness.'],
    ['garage', "key LIKE 'garage:%'", 'Garage control and learning state', 'Current model checkpoint, protection exposure, active episode, adapter restoration, temporary price-control pause and device-bound room target.'],
    ['pairing', "key='pairing-lineage'", 'Paired database lineage', 'Current pairing lineage used to identify a published database and fence replica ownership; private identifiers are omitted.'],
    ['simulation', "key LIKE 'simulation:%'", 'Simulation state', 'Current simulated plant state for resuming a simulation.'],
  ];
  const state = grouped('state', `CASE ${stateCategories.map(([id, where]) => `WHEN ${where} THEN ${quote(id)}`).join(' ')} ELSE 'other' END`, 'updated_at', 'updated_at', ",SUM(value='null') missingCount");
  const currentOptions = { retention: 'current', countLabel: 'current entries', dateBasis: 'last updates',
    retentionDescription: 'Updated in place. Previous versions of these current entries are not retained here.',
    writeBehavior: 'When the associated state changes.', fields: fields(['Current state', 'Latest saved state and update timestamp; private identifiers and values are omitted from this inventory.']) };
  add('settings', 'Current settings and checkpoints', 'These entries keep the application running across restarts. Counts are current entries, and date ranges are their last updates—not a complete history of earlier states.',
    [...stateCategories.map(([id, , label, description]) => item(`state-${id}`, label, description, state.get(id), {
      ...currentOptions, ...(id === 'settings' ? { fields: fields(
        ['Operating settings', 'Controller mode, comfort target and permitted temperature drop.'],
        ['Occupancy', 'Occupied/away mode and planned return time.'],
        ['Temporary overrides', 'Override action and expiry; cleared state may remain as an explicit null entry.'],
        ['Last update', 'When each current settings document was last changed.']) } : id === 'charging' ? { fields: fields(
        ['Persistent charging choices', 'Automatic charging and shared priority, bound to the current equipment identity.'],
        ['Session edits', 'Ready-by time, starting charge, target charge and usable battery capacity for the physical session; these do not replace configured defaults.'],
        ['Session and device state', 'Connection, measured energy, vehicle observations, native readiness, schedule and current execution state.'],
        ['Last update', 'When the current state changed; private device identifiers and payload values are not exposed.']) } : {}) })),
      ...(state.get('other')?.count ? [item('state-other', 'Unrecognized current-state entries', 'Each unrecognized entry is identified below by an opaque reference to avoid exposing private device identifiers. No current writer description is available.', state.get('other'), currentOptions)] : [])]);
  if (state.get('other')?.count) {
    inventoryIssues.push('Current-state entries without a registered writer description are present.');
    groups.at(-1).items.at(-1).breakdown = db.prepare(`SELECT key,updated_at FROM state WHERE NOT
      (${stateCategories.map(([, where]) => `(${where})`).join(' OR ')}) ORDER BY key`).all()
      .map(row => ({ label: `State entry ${opaqueId(row.key)}`, count: 1, firstAt: row.updated_at, lastAt: row.updated_at }));
  }

  const eventCategories = [
    ['charging-checks', "type='charging-session-check'", 'Finalized charging comparisons', 'One immutable reference and estimated energy comparison per Charger 1 session or Charger 2 charging period; incomplete coverage is excluded from averages.'],
    ['heat-power-config', "type='heat-pump-power-config'", 'Historical heat-pump power assumptions', 'Versioned nominal power assumptions used to reconstruct heat-pump power and timing comparisons from recorded equipment states.'],
    ['decisions', "type='decision'", 'Controller decisions', 'Action, phase, reasons, commands and execution outcomes recorded for each decision.'],
    ['settings', "type IN ('settings-changed','configured-rates-applied','contract-period-added','occupancy-changed','occupancy-expired','override-changed','override-expired')", 'Settings and override changes', 'Changes to settings, contract rates and temporary operating instructions.'],
    ['cycles', "type LIKE 'cycle-%'", 'Cycle events', 'Cycle planning, progression, interruption and completion notifications.'],
    ['execution', "type LIKE 'h66-%' OR type LIKE 'floor-%' OR type LIKE 'heating-test-%' OR type LIKE 'control-%' OR type='restoration-pending' OR type='simulated-command-readback'", 'Equipment execution and readback events', 'Requests, confirmations, failures, restoration and manual-test outcomes.'],
    ['garage-feed', "type='garage-external-temperature-diagnostic'", 'Garage external-temperature problems', 'Only abnormal feed conditions and recovery from them. Successful renewals and normal external-temperature values are not recorded.'],
    ['garage-diagnostics', "type='garage-pump-diagnostic'", 'Garage native diagnostic bytes', 'Changes to raw native diagnostic bytes and their availability after genuine observation. These bytes are not interpreted as a diagnosed fault.'],
    ['garage', "type LIKE 'garage-%'", 'Garage control changes', 'Native-setting requests, room-target changes, manual control and temporary price-control changes.'],
    ['sensors', "type LIKE 'sensor-%' OR type='indoor-baseline-reset'", 'Sensor and temperature-reference changes', 'Sensor replacement, movement, calibration, correction and baseline boundaries used during reconstruction.'],
    ['mqtt', "type LIKE 'mqtt-%'", 'MQTT connection and acquisition events', 'Connection, subscription and transport failures or recovery, separate from scalar sensor coverage.'],
    ['learning', "type LIKE 'learning-%' OR type LIKE 'checkpoint-%' OR type='scheduled-cycle-rejected'", 'Learning and planning diagnostics', 'Learning worker faults, checkpoint reconstruction and rejected scheduled cycles.'],
    ['history', "type LIKE 'history%'", 'History import and recovery events', 'Import completion and atomic recovery outcomes; source files and private paths are not displayed.'],
    ['application', "type IN ('controller-error','provider-cache-rebuild','settings-reloaded','settings-reload-failed','charging-session-check-conflict')", 'Application diagnostics', 'Controller errors, cache rebuilds, configuration reload results and conflicting charger checks.'],
  ];
  const eventTypes = db.prepare(`SELECT CASE ${eventCategories.map(([id, where]) => `WHEN ${where} THEN ${quote(id)}`).join(' ')} ELSE 'other' END category,
    type,COUNT(*) count,MIN(at) firstAt,MAX(at) lastAt FROM events GROUP BY category,type ORDER BY type`).all();
  const events = new Map();
  for (const row of eventTypes) addCount(events, row.category, row);
  const eventItems = eventCategories.map(([id, , label, description]) => item(`events-${id}`, label, description, events.get(id), {
    writeBehavior: id === 'decisions' ? 'On every recorded controller decision.' : 'When the event occurs.',
    fields: id === 'charging-checks' ? fields(['Period and energy', 'Start/end, source, integrated kWh and final reference kWh.'], ['Coverage', 'Completeness and quality; Charger 2 energy added differs from electrical input.'])
      : id === 'heat-power-config' ? fields(['Nominal powers', 'Compressor, circulation and rated auxiliary power in kW.'], ['Version and effective time', 'Algorithm/configuration version, input mode and effective timestamp.'])
      : fields(['Event type and time', 'What happened and when.'], ['Event context', 'Associated decision, configuration, command, assessment or failure details.']) }));
  if (events.get('other')?.count) eventItems.push(item('events-other', 'Unrecognized event types', 'Distinct event types without a current writer description.', events.get('other'), {
    writeBehavior: 'Unrecognized writer; inspect the current producer before interpreting these events.', fields: fields(['Event type and time', 'What happened and when.'], ['Event context', 'Relevant details; payloads are not exposed here.']) }));
  for (const dataset of eventItems) {
    const category = dataset.id.slice('events-'.length);
    dataset.breakdown = eventTypes.filter(row => row.category === category).map(row => ({
      label: category === 'other' ? `Unrecognized event ${opaqueId(row.type)}` : row.type,
      ...stats(row), writeBehavior: category === 'garage-feed' ? 'On abnormal-status or reason change, and once on recovery.' : dataset.writeBehavior,
    }));
  }
  if (events.get('other')?.count) {
    inventoryIssues.push('Event types without a registered writer description are present.');
    const unknown = eventItems.find(row => row.id === 'events-other');
    unknown.label = 'Unrecognized event types'; unknown.description = 'Each distinct unrecognized event type is counted separately below with an opaque reference; payloads remain private.';
  }
  const counters = aggregate('counters', "COALESCE(source_time,CAST(strftime('%s',observed_date) AS INTEGER)*1000)");
  const annotations = aggregate('annotations', 'start_at', 'COALESCE(end_at,start_at)');
  eventItems.push(item('manual-counters', 'Dated manual runtime counters', 'Manually entered compressor, auxiliary-stage and hot-water runtime readings. A date alone does not imply a known time of day.', counters, {
    dateBasis: 'observation dates', datePrecision: 'date', writeBehavior: 'When manual history is added or seeded.',
    fields: fields(['Runtime counters', 'Compressor, auxiliary 3 kW, auxiliary 6 kW and hot-water hours.'], ['Provenance', 'Observation date, optional precise time, unit and source note.']) }));
  eventItems.push(item('annotations', 'Historical annotations', 'Notes about periods such as absence, heating off, uncertain boundaries and training exclusions.', annotations, {
    dateBasis: 'annotated period start / end', writeBehavior: 'When an annotation is added.',
    fields: fields(['Period and classification', 'Start/end, kind and confidence in the boundaries.'], ['Interpretation', 'Note, provenance and whether the period is excluded from training.']) }));
  add('events', 'Events, manual counters and annotations', 'Recorded decisions and context explain what happened without presenting calculated results as physical measurements.', eventItems);

  const coverage = aggregate('recorder_coverage', 'start_at', 'end_at');
  const metrics = aggregate('recorder_metrics', 'bucket');
  const audits = aggregate('energy_audits', 'source_time');
  const journalEntries = aggregate('learning_journal_entries', 'at');
  const epochs = aggregate('learning_epochs', 'NULL');
  const recoveryRuns = aggregate('recovery_runs', 'started_at', 'COALESCE(completed_at,started_at)');
  const recoverySources = aggregate('recovery_provenance', 'NULL');
  const otherEpochs = aggregate('learning_journal_entries', 'at', 'at',
    "epoch<>COALESCE((SELECT epoch FROM learning_epochs WHERE input=learning_journal_entries.input),'original')");
  add('support', 'Recording and storage support', 'These support records are stored in addition to measurements. Charts read original committed records using SQLite indexes. Display-point reduction and cached chart responses stay in memory; no separate chart summaries are stored in the database.', [
    item('adaptive-observations', 'Saved adaptive measurement history', 'Every saved adaptive dataset is listed here, including recovered history without a current recorder checkpoint. The Adaptive measurements table shows streams with a current checkpoint and their thresholds. Matching signals with the same unit and saving rule are combined across sources.', observations.get('adaptive'), {
      dateBasis: 'observation time, or receipt time when unavailable', writeBehavior: 'When a learned numeric change threshold, quality transition or accumulated-energy interval closure requires a record; unchanged values are not repeated.', fields: observationFields,
      breakdownLabel: 'Measurement / unit / saving rule',
      breakdown: [...observedDatasets.values()].filter(row => row.policy.adaptive).map(row => ({
        ...stats(row), signal: row.signal, unit: row.unit, recordingPolicy: row.policy.id,
        label: `${recordedSignalInfo(row.signal, row.unit).label} (${row.signal}) · ${row.unit} · ${row.policy.label}`,
        dateBasis: 'observation time, or receipt time when unavailable',
      })).sort((a, b) => a.label.localeCompare(b.label)),
    }),
    item('coverage', 'Availability and verification coverage', 'Compact spans distinguish fresh unchanged readings from stale, failed or unavailable acquisition.', coverage, {
      countLabel: 'spans', dateBasis: 'span start / end', retention: 'mixed', retentionDescription: 'New spans are retained; the current unchanged span is extended in place.',
      writeBehavior: 'Updated by acquisition; new span on a status or associated saved-reading change, or after a source-freshness gap.',
      fields: fields(['Status and time span', 'Availability classification, receipt coverage and latest source timestamp.'], ['References', 'Saved observation reference and number of acquisition samples represented.']) }),
    item('recorder-statistics', 'Recording statistics', 'Hourly counts and time-weighted pre-update change statistics used by the recording display and storage optimizer.', metrics, {
      countLabel: 'hourly buckets', dateBasis: 'bucket time', retention: 'rolling', retentionDescription: 'Hourly buckets updated in place; buckets older than seven days are pruned by the recorder.',
      writeBehavior: 'Each acquisition updates its current hourly bucket.',
      fields: fields(['Counts and saved times', 'Polls, saved records, first/last saved receipt times and stale/failed/unavailable acquisitions.'], ['Compression statistics', 'Approximate serialized observation bytes and accumulated normalized pre-update change/time; not per-table disk usage.']) }),
    item('snapshot-content', 'Shared provider snapshot content', 'Immutable deduplicated content shared by timestamped weather and market fetch references listed above.', content, {
      countLabel: 'versions', dateBasis: 'associated fetch times', writeBehavior: 'Once per new content digest.', fields: fields(['Content', 'Provider forecast/price intervals.'], ['Digest', 'Content identity used to reuse unchanged data.']) }),
    item('meter-audits', 'Property cumulative meter readings', 'Property import counters and diagnostic metadata. Charger 1 and Charger 2 use finalized session references instead of cumulative charger counters.', audits, {
      dateBasis: 'meter observation time', writeBehavior: 'When a changed cumulative counter is received; never used to correct estimates or train.',
      fields: fields(['Meter reading', 'Cumulative kWh, source and receipt timestamps, quality.'], ['Diagnostic context', 'Optional stored comparison metadata; current checks can also be calculated read-only from matching energy coverage.']) }),
    item('learning-archive', 'Other model history epochs', 'Original committed learning remains available after a successful recovery. A recovery in progress also stages its candidate history here until verification and publication.', otherEpochs, {
      retention: 'mixed', retentionDescription: 'Successful original epochs remain reconstructible. Compact ordering references reuse original inputs; abandoned unpublished candidates are removed on retry.',
      dateBasis: 'learning record time', writeBehavior: 'During current-format history recovery; source entries are referenced without duplicating their payload.', fields: learningFields }),
    item('learning-epochs', 'Selected model histories', 'One selection per recovered input identifies the complete learning history currently used by the model.', epochs, {
      retention: 'current', retentionDescription: 'Updated atomically with the completed model checkpoint.', countLabel: 'selections',
      writeBehavior: 'On atomic publication of a recovered learning history.', dateBasis: 'no independent timestamps stored' }),
    item('recovery-runs', 'Manual recovery records', 'Recovery boundaries and outcomes identify how combined model history was reconstructed. Counts and dates are shown without source identities or payloads.', recoveryRuns, {
      countLabel: 'recoveries', retention: 'mixed', writeBehavior: 'Created when recovery starts, updated at verified completion; abandoned incomplete runs are removed on retry.',
      retentionDescription: 'Completed recoveries retain their reconstruction boundary; abandoned incomplete jobs are removed on retry.' }),
    item('recovery-provenance', 'Recovered source references', 'Source-to-master reference mappings prevent duplicate imports and keep accepted record references consistent across interrupted recovery attempts.', recoverySources, {
      countLabel: 'references', writeBehavior: 'Once per recovered source record disposition; interruption retries reuse the mapping.', dateBasis: 'no independent timestamps stored',
      fields: fields(['Origin and disposition', 'Opaque source identity, mapped local record reference and whether it was accepted or rejected; values are not displayed.']) }),
  ]);
  if (snapshots.get('other')?.count) groups.at(-1).items.push(item('snapshot-other', 'Other provider fetch references',
    'Additional provider snapshot kinds present in the database.', snapshots.get('other'), { dateBasis: 'fetch time' }));

  // Physical table accounting is separate from logical dataset counts above:
  // contract periods live inside state documents and snapshot content is shared.
  const tableCounts = {
    observations: totalObservations.count, state: sum([...state.values()]).count, events: sum([...events.values()]).count,
    imports: sum([...imports.values()]).count, import_rows: importRows.count, annotations: annotations.count, counters: counters.count,
    provider_snapshot_fetches: sum([...snapshots.values()]).count, provider_snapshot_contents: contentCount,
    recorder_coverage: coverage.count, recorder_metrics: metrics.count, energy_audits: audits.count,
    learning_journal_entries: journalEntries.count, learning_epochs: epochs.count, recovery_runs: recoveryRuns.count,
    recovery_provenance: recoverySources.count, learning_cycles: cycles.count,
    fireplace_events: sum([...fireplace.values()]).count,
  };
  const actualTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (actualTables.some(({ name }) => !Object.hasOwn(tableCounts, name))) inventoryIssues.push('An unregistered physical table needs a writer and retention description.');
  const tables = actualTables.map(({ name }, index) => Object.hasOwn(tableCounts, name) ? { name, rows: tableCounts[name] }
    : { name: `Additional internal table ${index + 1}`, rows: db.prepare(`SELECT COUNT(*) count FROM "${name.replaceAll('"', '""')}"`).get().count });
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const allocatedBytes = db.prepare('PRAGMA page_count').get().page_count * pageSize;
  const reusableBytes = db.prepare('PRAGMA freelist_count').get().freelist_count * pageSize;
  const fileBytes = store.path && store.path !== ':memory:' ? fileSize(store.path) : null;
  const walBytes = store.path && store.path !== ':memory:' ? fileSize(`${store.path}-wal`) : 0;
  return { generatedAt: now, refreshAfterMs: OVERVIEW_REFRESH_MS,
    catalogueComplete: inventoryIssues.length === 0, inventoryIssues: [...new Set(inventoryIssues)],
    database: { allocatedBytes, reusableBytes, fileBytes, walBytes, totalFileBytes: fileBytes === null ? null : fileBytes + walBytes,
      description: 'SQLite allocated pages include recorded data, indexes that speed lookups and reusable pages. Chart responses and display-point reduction use memory, not additional database tables. Main-file plus WAL bytes are physical files and include temporary journal overhead; dataset sizes are not estimated.' },
    groups, accounting: { tables, totalRows: tables.reduce((total, table) => total + table.rows, 0),
      views: [{ name: 'provider_snapshots', description: 'Current read-only view joining fetch references with shared content; it stores no additional rows.' },
        { name: 'learning_journal', description: 'Selected complete learning epoch for each input; source entries and archived epochs are counted in learning_journal_entries.' },
        { name: 'learning_journal_all', description: 'Resolves compact epoch references to their original saved input; it stores no duplicated payload rows.' }],
      description: 'Each physical table is counted once here. Dataset counts above overlap where documents contain periods or fetches reference shared content; do not add those dataset counts together.' } };
}
