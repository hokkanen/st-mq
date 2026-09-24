import { confirmAction } from './confirmation.js';
import { isReadOnlyReplica } from './replica-status.js';

export function ocppSetupRevision(status) {
  if (!status || status.readOnly === true || isReadOnlyReplica(status)) return null;
  const setup = status.providers?.easee?.localOcpp?.setup;
  return setup?.state === 'blocked' && setup.reason === 'foreign-configuration' && setup.canAdopt === true && !setup.busy
    && typeof setup.revision === 'string' && /^[a-f0-9]{64}$/.test(setup.revision)
    ? setup.revision : null;
}

/** Confirmation applies only to the configuration that was inspected when the
 * dialog opened. The server independently verifies its remote revision. */
export function createOcppSetupAction({ document, request, getStatus, blocked = () => false,
  onBusy = () => {}, onMessage = () => {}, beforeRequest = () => {}, afterRequest = () => {}, confirm = confirmAction }) {
  let pending = false;
  return async () => {
    const revision = ocppSetupRevision(getStatus());
    if (pending || blocked() || revision === null) return;
    pending = true;
    try {
      if (!await confirm({ document, title: 'Replace the charger’s OCPP connection?',
        message: 'This replaces the charger’s existing OCPP server connection with this installation’s configured local connection. Native OCPP takes over charging authorization and schedules from Easee cloud. Normal stop requests cloud handback. After a crash or power loss, charging may wait for approval until the controller restarts or Direct OCPP is disabled through Easee configuration.',
        action: 'Set up local connection' })) return;
      if (blocked() || ocppSetupRevision(getStatus()) !== revision) {
        onMessage('Charger setup or control authority changed. Review the current status before trying again.', true);
        return;
      }
      onBusy(true); beforeRequest();
      onMessage('Setting up the local charger connection…', false);
      try {
        await request('/api/charging/ocpp-setup', { action: 'adopt', revision });
        onMessage('Setup requested. Waiting for the charger’s confirmed connection.', false);
      } catch (error) {
        onMessage(error.message || 'Local connection setup could not be completed.', true);
      } finally { onBusy(false); }
      await afterRequest();
    } finally { pending = false; }
  };
}
