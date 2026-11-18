import { validGarageCommandReceipt } from './contract.js';

export const garageCommandFeedbackKey = input => `garage:command-feedback:${input}`;

export function validateGarageCommandFeedback(feedback) {
  if (feedback == null) return null;
  if (typeof feedback !== 'object' || Object.keys(feedback).sort().join(',') !== 'adapterKey,control,deviceId,set'
    || typeof feedback.adapterKey !== 'string' || !/^[a-f0-9]{64}$/.test(feedback.adapterKey)
    || typeof feedback.deviceId !== 'string' || !feedback.deviceId || feedback.deviceId.length > 128 || /[\u0000-\u001f]/.test(feedback.deviceId)
    || ['control', 'set'].some(action => feedback[action] !== null
      && (!validGarageCommandReceipt(feedback[action]) || feedback[action].action !== action)))
    throw new Error('Unsupported saved Garage command feedback.');
  return feedback;
}
