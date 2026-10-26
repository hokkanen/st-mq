import { createEventLogService } from './event-log-service.js';

/** One physical replica file owns its history workers. Publication leases keep
 * separate native read transactions and capture their own verified boundary;
 * advancing the manifest must not retire a cache used by another request. */
export function createReplicaChartOwner(store, makeChartService, options, makeEventLogService = createEventLogService) {
  const admission = Object.create(store);
  admission.runStorageTask = store.runStorageTask.bind(store);
  const service = makeChartService({ ...options, store: admission });
  return { store, admission, service, makeEventLogService, events: null, references: 0 };
}

// The snapshot's existing file-owner lease also owns this reader. A manifest
// advance changes its verified arguments, never the lifetime of the worker.
export function leaseReplicaEvents(owner, checkpoint) {
  return { query: (args, options) => {
    owner.events ??= owner.makeEventLogService({ store: owner.admission });
    return owner.events.query({ ...args, checkpoint }, options);
  } };
}

export function leaseReplicaCharts(owner, store, checkpoint) {
  owner.references++;
  // All chart workers for this physical file share one admission queue. Each
  // generation's ordinary SQLite connection still has its independent lifetime.
  if (store !== owner.store) {
    for (const method of ['runStorageTask', 'storageStatus', 'writeQueueStatus'])
      store[method] = owner.store[method].bind(owner.store);
    store.writeHealth.status = owner.store.writeHealth.status.bind(owner.store.writeHealth);
  }
  const service = {};
  for (const method of ['query', 'queryWire', 'energyChecks']) if (owner.service[method])
    service[method] = (args, options) => owner.service[method](args, { ...options, checkpoint });
  for (const method of ['overview', 'pin']) if (owner.service[method])
    service[method] = options => owner.service[method]({ ...options, checkpoint });
  if (owner.service.overviewAction)
    service.overviewAction = (input, options) => owner.service.overviewAction(input, { ...options, checkpoint });
  if (owner.service.energyChecksAction)
    service.energyChecksAction = (input, args, options) => owner.service.energyChecksAction(input, args, { ...options, checkpoint });
  let closing;
  service.close = () => closing ??= (async () => {
    if (--owner.references) return;
    try {
      const results = await Promise.allSettled([owner.service, owner.events].filter(Boolean)
        .map(reader => Promise.resolve().then(() => reader.close())));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'History readers could not finish cleanup.');
    }
    finally { await owner.store.close(); }
  })();
  return service;
}

/** Local publication verifies the exact base before applying to this file.
 * Coalesced catch-up then discards the old journal prefix, so checkpointAt(old)
 * is not a cache continuity proof. Physical identity, database identity and a
 * forward verified publication preserve immutable inputs; selection/import and
 * committed-head checks inside the worker still govern every cached result. */
export function continuesReplicaCharts(previous, publication, identity) {
  const before = previous?.publication, from = before?.checkpoint, to = publication.checkpoint;
  return Boolean(from && to && publication.fileGeneration
    && publication.fileGeneration === before.fileGeneration && publication.dbPath === before.dbPath
    && identity === previous.fileIdentity && to.databaseId === from.databaseId
    && (to.sequence > from.sequence || to.sequence === from.sequence && to.hash === from.hash));
}
