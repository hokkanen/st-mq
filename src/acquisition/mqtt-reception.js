import { isDeepStrictEqual } from 'node:util';

/** Commit an equipment delivery and its held state together. Completion
 * callbacks run only after durability, so failed readback cannot acknowledge a
 * physical command and a broker retransmission can retry the same delivery. */
export function createMqttReception({ store, engine, admission, devices, meters, requests = null }) {
  let effects = null, accepted = null;
  const revisions = new WeakMap();
  let transportRevision = 0;
  const copiedFields = ['readings', 'dehumidifierState', 'dehumidifierReport', 'temperatureGuard'];
  const operationFields = ['coverOperation', 'dehumidifierOperation'];
  const scalarFields = ['connected', 'available', 'lastAt', 'lastPollAt', 'state', 'identity', 'identityPending',
    'observationOrder', 'writeOrder', 'online', 'bridgeOnline', 'liveSinceConnect', 'heartbeatAt', 'invalid',
    'subscriptionStatus', 'subscriptionRefresh', 'lastReceivedAt', 'lastLiveAt', 'lastRetainedAt', 'recordingLocation', 'dehumidifierHistoryAfter'];
  return {
    // Connection/subscription withdrawal happens outside SQLite admission. It
    // remains authoritative if an older asynchronous COMMIT later fails.
    invalidate(device) {
      revisions.set(device, (revisions.get(device) ?? 0) + 1);
      transportRevision++;
    },
    // Admission evidence belongs to the currently executing delivery only. The
    // caller publishes success after its enclosing transaction commits.
    accept() { accepted?.(); },
    afterCommit(effect) {
      if (effects) effects.push(effect);
      else if (store.afterCommit) store.afterCommit(effect);
      else effect();
    },
    run(receive, { onAccepted = null } = {}) {
      if (effects) return receive();
      const delivery = admission.checkpoint(), held = engine.ingestionCheckpoint?.();
      const deliveryRevision = transportRevision;
      const snapshots = devices.map(device => ({ device,
        revision: revisions.get(device) ?? 0,
        fields: Object.fromEntries(scalarFields.filter(key => Object.hasOwn(device, key)).map(key => [key, device[key]])),
        copied: Object.fromEntries(copiedFields.filter(key => Object.hasOwn(device, key)).map(key => [key, structuredClone(device[key])])),
        operations: operationFields.filter(key => Object.hasOwn(device, key))
          .map(key => ({ key, reference: device[key], value: structuredClone(device[key]) })),
        checks: [...device.checks].map(check => ({ check, reported: check.reported && new Set(check.reported), retainedReceived: check.retainedReceived })),
      }));
      const savedMeters = new Map([...meters].map(([id, meter]) => [id, { meter, state: meter.checkpoint() }]));
      const savedRequests = requests && new Map(requests);
      let receivedRequests;
      const captureOperations = () => {
        for (const snapshot of snapshots) for (const operation of snapshot.operations) {
          operation.receivedReference = snapshot.device[operation.key];
          operation.receivedValue = structuredClone(operation.receivedReference);
        }
      };
      const pending = effects = [];
      const previousAccepted = accepted;
      accepted = onAccepted;
      const rewind = () => {
        if (deliveryRevision === transportRevision) admission.restore(delivery);
        if (held) engine.restoreIngestionCheckpoint(held);
        for (const snapshot of snapshots) {
          if (snapshot.revision !== (revisions.get(snapshot.device) ?? 0)) continue;
          Object.assign(snapshot.device, snapshot.fields, snapshot.copied);
          // Pending transport callbacks own these receipt objects. Replacing
          // one with a clone strands its eventual outcome after any failed
          // receipt, even an unrelated device's observation.
          for (const { key, reference, value, receivedReference, receivedValue } of snapshot.operations) {
            if (snapshot.device[key] !== receivedReference || !isDeepStrictEqual(snapshot.device[key], receivedValue)) continue;
            if (reference) {
              for (const field of Object.keys(reference)) delete reference[field];
              Object.assign(reference, value);
            }
            snapshot.device[key] = reference;
          }
          for (const { check, reported, retainedReceived } of snapshot.checks) {
            if (reported) check.reported = reported;
            check.retainedReceived = retainedReceived;
          }
        }
        meters.clear();
        for (const [id, { meter, state }] of savedMeters) { meter.restore(state); meters.set(id, meter); }
        if (requests) {
          for (const [id, request] of receivedRequests ?? requests) {
            if (!savedRequests.has(id) && requests.get(id) === request) requests.delete(id);
          }
          for (const [id, request] of savedRequests) {
            const snapshot = snapshots.find(row => row.device === request.device);
            if (!request.retired && snapshot?.revision === (revisions.get(request.device) ?? 0)
              && !requests.has(id)) requests.set(id, request);
          }
        }
      };
      store.afterRollback?.(rewind);
      let result;
      try {
        result = store.transaction ? store.transaction(receive) : receive();
        receivedRequests = requests && new Map(requests);
        captureOperations();
      }
      catch (error) {
        receivedRequests = requests && new Map(requests);
        captureOperations();
        rewind();
        throw error;
      } finally { effects = null; accepted = previousAccepted; }
      for (const effect of pending) if (store.afterCommit) store.afterCommit(effect); else effect();
      return result;
    },
  };
}
