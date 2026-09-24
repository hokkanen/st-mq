/** Commit an equipment delivery and its held state together. Completion
 * callbacks run only after durability, so failed readback cannot acknowledge a
 * physical command and a broker retransmission can retry the same delivery. */
export function createMqttReception({ store, engine, admission, devices, meters, requests = null }) {
  let effects = null;
  const copiedFields = ['readings', 'coverOperation', 'dehumidifierState', 'dehumidifierReport', 'dehumidifierOperation', 'temperatureGuard'];
  const scalarFields = ['connected', 'available', 'lastAt', 'lastPollAt', 'state', 'identity', 'identityPending',
    'observationOrder', 'writeOrder', 'online', 'bridgeOnline', 'liveSinceConnect', 'heartbeatAt', 'invalid',
    'subscriptionStatus', 'subscriptionRefresh', 'lastReceivedAt', 'lastLiveAt', 'lastRetainedAt', 'recordingLocation'];
  return {
    afterCommit(effect) { if (effects) effects.push(effect); else effect(); },
    run(receive) {
      if (effects) return receive();
      const delivery = admission.checkpoint(), held = engine.ingestionCheckpoint?.();
      const snapshots = devices.map(device => ({ device,
        fields: Object.fromEntries(scalarFields.filter(key => Object.hasOwn(device, key)).map(key => [key, device[key]])),
        copied: Object.fromEntries(copiedFields.filter(key => Object.hasOwn(device, key)).map(key => [key, structuredClone(device[key])])),
        checks: [...device.checks].map(check => ({ check, reported: check.reported && new Set(check.reported), retainedReceived: check.retainedReceived })),
      }));
      const savedMeters = new Map([...meters].map(([id, meter]) => [id, { meter, state: meter.checkpoint() }]));
      const savedRequests = requests && new Map(requests);
      const pending = effects = [];
      let result;
      try { result = store.transaction ? store.transaction(receive) : receive(); }
      catch (error) {
        admission.restore(delivery);
        if (held) engine.restoreIngestionCheckpoint(held);
        for (const snapshot of snapshots) {
          Object.assign(snapshot.device, snapshot.fields, snapshot.copied);
          for (const { check, reported, retainedReceived } of snapshot.checks) {
            if (reported) check.reported = reported;
            check.retainedReceived = retainedReceived;
          }
        }
        meters.clear();
        for (const [id, { meter, state }] of savedMeters) { meter.restore(state); meters.set(id, meter); }
        if (requests) { requests.clear(); for (const [id, request] of savedRequests) requests.set(id, request); }
        throw error;
      } finally { effects = null; }
      for (const effect of pending) effect();
      return result;
    },
  };
}
