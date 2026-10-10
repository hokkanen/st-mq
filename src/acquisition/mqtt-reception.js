/** Commit an equipment delivery and its held state together. Completion
 * callbacks run only after durability, so failed readback cannot acknowledge a
 * physical command and a broker retransmission can retry the same delivery. */
export function createMqttReception({ store, engine, admission, devices, meters, requests = null }) {
  let effects = null, accepted = null;
  const copiedFields = ['readings', 'dehumidifierState', 'dehumidifierReport', 'temperatureGuard'];
  const operationFields = ['coverOperation', 'dehumidifierOperation'];
  const scalarFields = ['connected', 'available', 'lastAt', 'lastPollAt', 'state', 'identity', 'identityPending',
    'observationOrder', 'writeOrder', 'online', 'bridgeOnline', 'liveSinceConnect', 'heartbeatAt', 'invalid',
    'subscriptionStatus', 'subscriptionRefresh', 'lastReceivedAt', 'lastLiveAt', 'lastRetainedAt', 'recordingLocation', 'dehumidifierHistoryAfter'];
  return {
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
      const snapshots = devices.map(device => ({ device,
        fields: Object.fromEntries(scalarFields.filter(key => Object.hasOwn(device, key)).map(key => [key, device[key]])),
        copied: Object.fromEntries(copiedFields.filter(key => Object.hasOwn(device, key)).map(key => [key, structuredClone(device[key])])),
        operations: operationFields.filter(key => Object.hasOwn(device, key))
          .map(key => ({ key, reference: device[key], value: structuredClone(device[key]) })),
        checks: [...device.checks].map(check => ({ check, reported: check.reported && new Set(check.reported), retainedReceived: check.retainedReceived })),
      }));
      const savedMeters = new Map([...meters].map(([id, meter]) => [id, { meter, state: meter.checkpoint() }]));
      const savedRequests = requests && new Map(requests);
      const pending = effects = [];
      const previousAccepted = accepted;
      accepted = onAccepted;
      const rewind = () => {
        admission.restore(delivery);
        if (held) engine.restoreIngestionCheckpoint(held);
        for (const snapshot of snapshots) {
          Object.assign(snapshot.device, snapshot.fields, snapshot.copied);
          // Pending transport callbacks own these receipt objects. Replacing
          // one with a clone strands its eventual outcome after any failed
          // receipt, even an unrelated device's observation.
          for (const { key, reference, value } of snapshot.operations) {
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
        if (requests) { requests.clear(); for (const [id, request] of savedRequests) requests.set(id, request); }
      };
      store.afterRollback?.(rewind);
      let result;
      try { result = store.transaction ? store.transaction(receive) : receive(); }
      catch (error) {
        rewind();
        throw error;
      } finally { effects = null; accepted = previousAccepted; }
      for (const effect of pending) if (store.afterCommit) store.afterCommit(effect); else effect();
      return result;
    },
  };
}
