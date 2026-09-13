// These channels are live equipment details, retired duplicate feeds, or an
// uninstalled sensor. None belongs in recorded telemetry or chart datasets.
const LIVE_ONLY = new Set(['caravan_active', 'caravan_power', 'caravan_current',
  'heat_savings_active', 'garage_relay_active']);
const RETIRED = new Set(['garage_temperature_ha']);

export function isRecordedDataset({ source, signal }) {
  return !LIVE_ONLY.has(signal) && !RETIRED.has(signal)
    && !(signal?.startsWith('caravan_') && signal !== 'caravan_energy')
    && !signal?.startsWith('garage_heat_pump_')
    && source !== 'mqtt-temperature-ha'
    && !(source === 'husdata-h66' && signal === 'indoor_temperature');
}

/** Remove the retired development telemetry itself, including recorder state,
 * rather than hiding it in the UI. Imported history and the immutable learning
 * journal remain intact. Run before constructing the engine or chart readers. */
export function pruneRetiredDatasets(store) {
  const marker = 'recorded-datasets:equipment-cleanup:v1';
  if (store.getState(marker)) return { observations: 0, coverage: 0, metrics: 0, states: 0 };
  return store.transaction(() => {
    const streams = store.db.prepare(`SELECT DISTINCT source,device,signal FROM observations WHERE import_id IS NULL
      UNION SELECT DISTINCT source,device,signal FROM recorder_coverage`).all().filter(row => !isRecordedDataset(row));
    const removeCoverage = store.db.prepare('DELETE FROM recorder_coverage WHERE source=? AND device=? AND signal=?');
    const removeObservations = store.db.prepare('DELETE FROM observations WHERE source=? AND device=? AND signal=? AND import_id IS NULL');
    const removeMetrics = store.db.prepare('DELETE FROM recorder_metrics WHERE key=?');
    const removeState = store.db.prepare('DELETE FROM state WHERE key=?');
    let observations = 0, coverage = 0, metrics = 0, states = 0;
    for (const row of streams) {
      const values = [row.source, row.device, row.signal], key = JSON.stringify(values);
      coverage += removeCoverage.run(...values).changes;
      observations += removeObservations.run(...values).changes;
      metrics += removeMetrics.run(key).changes;
      states += removeState.run(`recorder:signal:${key}`).changes;
    }
    for (const row of store.db.prepare('SELECT DISTINCT key FROM recorder_metrics').all()) {
      let parts; try { parts = JSON.parse(row.key); } catch { continue; }
      if (Array.isArray(parts) && parts.length === 3 && !isRecordedDataset({ source: parts[0], signal: parts[2] }))
        metrics += removeMetrics.run(row.key).changes;
    }
    // Some discontinued sources only have cached availability/recorder state.
    for (const row of store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:signal:%' OR key LIKE 'indoor:%' OR key LIKE 'observation:%'").all()) {
      let value; try { value = JSON.parse(row.value); } catch { continue; }
      if (value?.signal && !isRecordedDataset(value)) {
        states += removeState.run(row.key).changes;
        if (value.key) metrics += removeMetrics.run(value.key).changes;
      }
    }
    // Future-controller accumulator checkpoints have no corresponding device.
    for (const row of store.db.prepare("SELECT key FROM state WHERE key LIKE 'shelly:equipment-energy:v1:garage_heat_pump%' OR key LIKE 'mqtt:equipment-energy:v1:garage_heat_pump%'").all())
      states += removeState.run(row.key).changes;
    const result = { observations, coverage, metrics, states };
    store.setState(marker, result);
    return result;
  });
}
