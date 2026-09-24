import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ocppHandoverRequirements, assertOcppHandoverReady } from '../acquisition/easee-ocpp-setup.js';
import { localOcppConfiguration } from '../acquisition/easee-ocpp.js';
import { pairError } from './state.js';

/** Reserve no service on standby: only check that its future listener can bind. */
export async function probeOcppListener(config) {
  const local = localOcppConfiguration(config.connections.easee.local_ocpp);
  const host = local.host === config.pairing.vip.address ? '0.0.0.0' : local.host;
  await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const server = createServer(socket => socket.destroy());
    const timeout = setTimeout(() => {
      controller.abort();
      reject(pairError('ocpp_handover_not_ready'));
    }, 2000);
    const finish = error => {
      clearTimeout(timeout);
      if (error) reject(pairError('ocpp_handover_not_ready')); else resolve();
    };
    server.once('error', finish);
    server.once('listening', () => server.close(finish));
    try { server.listen({ host, port: local.port, exclusive: true, signal: controller.signal }); }
    catch (error) { finish(error); }
  });
}

/** Only sanitized compatibility digests travel in the paired control protocol. */
export function ocppHandoverHooks({ configuration, store, probe = probeOcppListener }) {
  return {
    handoverRequirements() {
      try { return ocppHandoverRequirements(configuration(), store()?.getState('easee:ocpp-setup') ?? null); }
      catch { throw pairError('ocpp_handover_not_ready'); }
    },
    async prepareHandover(requirements) {
      const config = configuration();
      // The ordinary replica may be stale. Validate local configuration first;
      // require the final quiesced setup state when that snapshot arrives.
      try {
        assertOcppHandoverReady(config, null, requirements);
        if (requirements !== null) await probe(config);
      } catch { throw pairError('ocpp_handover_not_ready'); }
    },
    verifyHandover({ dbPath, requirements }) {
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare("SELECT value FROM state WHERE key = 'easee:ocpp-setup'").get();
        assertOcppHandoverReady(configuration(), row ? JSON.parse(row.value) : null, requirements);
      } catch {
        throw pairError('ocpp_handover_not_ready');
      } finally { db?.close(); }
    },
  };
}
