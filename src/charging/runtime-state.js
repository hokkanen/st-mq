import { chargingDefaults } from './settings.js';
import { validateBmwChargingHistory } from './vehicle.js';
import { validateTargetState, validateTargetSelection } from './target.js';
import { validateIdentificationState } from './identification.js';
import { validateJointTeslaComparison } from './joint-identification.js';
import { validateChargingFlexibility } from './flexibility.js';
import { validateChargingProgress } from './progress.js';

const object = input => input && typeof input === 'object' && !Array.isArray(input);
const time = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const vehicleIds = ['bmw', 'tesla'];
const evidenceFields = ['scope', 'chargingTimes', 'stoppedTimes', 'physicalCharging', 'historyOverflow',
  'bmwReason', 'bmwChargingReadingId', 'bmwPlugReadingId', 'bmwContestedPauseRequestedAt', 'teslaContestedPauseRequestedAt',
  'teslaCurrentCandidate', 'teslaCurrentMatch', 'teslaCurrentMatchTestId', 'teslaCurrentResolvedTestId'];
const times = value => Array.isArray(value) && value.length <= 4096
  && value.every((at, index) => time(at) && (index === 0 || value[index - 1] < at));
const sessionConnectedAt = request => Number(request.scope.split(':').at(-1));
const scoped = (value, association) => typeof value === 'string' && value.startsWith(`${association}:`)
  && time(Number(value.slice(association.length + 1))) && value === `${association}:${Number(value.slice(association.length + 1))}`;
function validateVehicleContext(previous) {
  const { vehicleEvidence: evidence, vehicleMatch: match, vehicleConflict: conflict, association } = previous;
  if (evidence != null && (!fields(evidence, evidenceFields) || !scoped(evidence.scope, association)
    || !times(evidence.chargingTimes) || !times(evidence.stoppedTimes)
    || evidence.physicalCharging !== undefined && typeof evidence.physicalCharging !== 'boolean'
    || evidence.historyOverflow !== undefined && typeof evidence.historyOverflow !== 'boolean'
    || evidence.bmwReason !== undefined && !['matched-controlled-pause', 'matched-identification-pause', 'matched-physical-session'].includes(evidence.bmwReason)
    || ['bmwChargingReadingId', 'bmwPlugReadingId'].some(key => evidence[key] != null && !identifier(evidence[key])))
    || match != null && (!fields(match, ['id', 'scope', 'association', 'vehicleAssociation', 'connectedAt', 'matchedAt', 'revision', 'pauseRequestedAt'])
      || !vehicleIds.includes(match.id) || match.association !== association || !identifier(match.vehicleAssociation)
      || !time(match.connectedAt) || match.scope !== `${association}:${match.connectedAt}`
      || !time(match.matchedAt) || match.matchedAt < match.connectedAt
      || !Number.isSafeInteger(match.revision) || match.revision < 1)
    || conflict != null && (!fields(conflict, ['scope', 'ids', 'vehicleAssociations', 'at'])
      || !scoped(conflict.scope, association) || !time(conflict.at)
      || !Array.isArray(conflict.ids) || !conflict.ids.length || new Set(conflict.ids).size !== conflict.ids.length
      || conflict.ids.some(id => !vehicleIds.includes(id))
      || !fields(conflict.vehicleAssociations, vehicleIds)
      || Object.values(conflict.vehicleAssociations).some(value => value != null && !identifier(value))))
    throw new Error('Unsupported saved vehicle identity evidence; start a fresh development database');
}
function validateSavedRequest(request, association) {
  if (request == null) return;
  try {
    if (!object(request) || Object.keys(request).some(key => !['scope', 'sessionId', 'revision', 'deadlineAt', 'overrides', 'anchorAt', 'readyBy', 'chargeNow', 'flexibility'].includes(key))
      || typeof request.scope !== 'string' || request.scope !== `${association}:${sessionConnectedAt(request)}`
      || !Number.isSafeInteger(sessionConnectedAt(request)) || sessionConnectedAt(request) < 0 || request.sessionId !== request.scope
      || !Number.isSafeInteger(request.revision) || request.revision < 1
      || !Number.isSafeInteger(request.deadlineAt) || !object(request.overrides)
      || request.chargeNow !== undefined && request.chargeNow !== true
      || request.anchorAt !== undefined && (!Number.isSafeInteger(request.anchorAt) || request.anchorAt < 0)) throw new Error();
    chargingDefaults(request.overrides, { partial: true });
    if (request.readyBy !== undefined) chargingDefaults({ readyBy: request.readyBy }, { partial: true });
    validateChargingFlexibility(request);
  } catch { throw new Error('Unsupported saved charging session; start a fresh development database'); }
}
function validateSavedControls(value, priority = false) {
  if (value === undefined) return;
  const keys = priority ? ['association', 'priority', 'revision'] : ['enabled', 'revision'];
  if (!object(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (priority ? !/^[a-f0-9]{64}$/.test(value.association) || !['balanced', 'charger1', 'charger2'].includes(value.priority)
      : typeof value.enabled !== 'boolean'))
    throw new Error('Unsupported saved charging controls; start a fresh development database');
}
function validateCurrentIdentificationEvidence(evidence) {
  validateJointTeslaComparison(evidence?.teslaCurrentMatch);
  const candidate = evidence?.teslaCurrentCandidate;
  const time = value => Number.isSafeInteger(value) && value >= 0;
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (candidate != null && (!object(candidate)
    || Object.keys(candidate).sort().join(',') !== 'minimumPhysicalAt,observedAt,physicalAt,receivedAt,testId,vehicleAssociation'
    || !id(candidate.testId) || !id(candidate.vehicleAssociation) || !time(candidate.observedAt)
    || ['receivedAt', 'physicalAt', 'minimumPhysicalAt'].some(key => !time(candidate[key]) || candidate[key] > candidate.observedAt))
    || ['teslaCurrentResolvedTestId', 'teslaCurrentMatchTestId'].some(key => evidence?.[key] != null && !id(evidence[key]))
    || evidence?.bmwContestedPauseRequestedAt !== undefined && !time(evidence.bmwContestedPauseRequestedAt)
    || evidence?.teslaContestedPauseRequestedAt !== undefined && !time(evidence.teslaContestedPauseRequestedAt)
    || evidence?.teslaCurrentMatch != null && evidence.teslaCurrentMatch.testId !== evidence.teslaCurrentMatchTestId)
    throw new Error('Unsupported saved current identification evidence; start a fresh development database');
}

/** One saved runtime contract, shared by startup preflight and live construction.
 * Validate every recorded association before current configuration selects one;
 * accepting a format never grants the saved association control authority. */
export function validateChargingRuntimeState(saved) {
  if (saved == null) return;
  if (!object(saved) || (Object.keys(saved).length && (saved.version !== 6
    || Object.keys(saved).some(key => !['version', 'revision', 'controls', 'chargers', 'vehicleFeeds', 'consumedTeslaPower', 'consumedTeslaCurrent', 'view'].includes(key)))))
    throw new Error('Unsupported charging state; start a fresh development database');
  if (saved.revision !== undefined && (!Number.isSafeInteger(saved.revision) || saved.revision < 0)
    || saved.chargers !== undefined && !object(saved.chargers)
    || saved.vehicleFeeds !== undefined && !object(saved.vehicleFeeds)
    || saved.view != null && (!object(saved.view) || !Array.isArray(saved.view.chargers)))
    throw new Error('Unsupported charging state; start a fresh development database');
  for (const consumed of [saved.consumedTeslaPower, saved.consumedTeslaCurrent])
    if (consumed != null && (!object(consumed) || Object.keys(consumed).sort().join(',') !== 'association,receivedAt'
      || typeof consumed.association !== 'string' || !consumed.association.length
      || !Number.isSafeInteger(consumed.receivedAt) || consumed.receivedAt < 0))
      throw new Error('Unsupported consumed vehicle evidence; start a fresh development database');
  validateSavedControls(saved.controls, true);
  for (const [id, previous] of Object.entries(saved.chargers ?? {})) {
    if (!['charger1', 'charger2'].includes(id) || !fields(previous, ['association', 'controls', 'replan', 'request', 'plan', 'progress',
      'supplyEstimate', 'sessionCost', 'vehicleMatch', 'vehicleEvidence', 'vehicleConflict', 'identification', 'targetState',
      'vehicleDisconnect', 'streamAssociation', 'streamEvidence'])
      || typeof previous.association !== 'string' || !previous.association.length)
      throw new Error('Unsupported saved charging session; start a fresh development database');
    for (const key of ['plan', 'supplyEstimate', 'sessionCost', 'vehicleDisconnect', 'streamEvidence'])
      if (previous[key] != null && !object(previous[key]))
        throw new Error('Unsupported saved charging session; start a fresh development database');
    if (previous.streamAssociation !== undefined && !identifier(previous.streamAssociation))
      throw new Error('Unsupported saved charging session; start a fresh development database');
    validateVehicleContext(previous);
    validateSavedControls(previous.controls);
    validateTargetState(previous.targetState);
    validateChargingProgress(previous.progress);
    if (previous.replan !== undefined && typeof previous.replan !== 'boolean')
      throw new Error('Unsupported saved charging controls; start a fresh development database');
    validateSavedRequest(previous.request, previous.association);
    validateCurrentIdentificationEvidence(previous.vehicleEvidence);
    if (previous.vehicleMatch?.pauseRequestedAt !== undefined && (previous.vehicleMatch.id !== 'tesla'
      || !Number.isSafeInteger(previous.vehicleMatch.pauseRequestedAt)
      || previous.vehicleMatch.pauseRequestedAt < previous.vehicleMatch.connectedAt
      || previous.vehicleMatch.pauseRequestedAt > previous.vehicleMatch.matchedAt))
      throw new Error('Unsupported saved controlled Tesla identity; start a fresh development database');
    if (previous.identification != null) validateIdentificationState(previous.identification);
  }
  for (const previous of saved.view?.chargers ?? []) validateTargetSelection(previous?.targetSelection);
  for (const [id, previous] of Object.entries(saved.vehicleFeeds ?? {})) {
    if (id !== 'bmw' || !fields(previous, ['reading', 'consumedPlugId', 'consumedChargingId'])
      || ['consumedPlugId', 'consumedChargingId'].some(key => previous[key] != null && !identifier(previous[key])))
      throw new Error('Unsupported saved vehicle evidence; start a fresh development database');
    validateBmwChargingHistory(previous.reading);
  }
}
