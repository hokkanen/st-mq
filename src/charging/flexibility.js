import moment from 'moment-timezone';
import { TIME_ZONE } from '../domain/prices.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const instant = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

/** Calendar arithmetic deliberately preserves Helsinki's wall clock. Moment's
 * explicit local parser chooses the earlier autumn occurrence and shifts a
 * missing spring time forward by the gap, matching normal ready-by semantics. */
export function nextLocalChargingDay(at, timezone = TIME_ZONE) {
  if (!instant(at) || !moment.tz.zone(timezone)) throw new Error('Invalid charging deadline');
  const local = moment.tz(at, timezone);
  return moment.tz(`${local.clone().add(1, 'day').format('YYYY-MM-DD')} ${local.format('HH:mm')}`,
    'YYYY-MM-DD HH:mm', true, timezone).valueOf();
}

export function validateChargingFlexibility(request) {
  const value = request.flexibility;
  if (value === undefined) return;
  const active = value?.activeDefer, last = value?.lastTransition;
  if (!object(value) || Object.keys(value).sort().join(',') !== 'activeDefer,authorizedBaseline,lastTransition,normalReadyByAt'
    || !instant(value.normalReadyByAt)
    || typeof value.authorizedBaseline !== 'boolean'
    || active != null && (!keys(active, ['id', 'checkpointAt', 'deferredReadyByAt', 'approvedAt', 'revision'])
      || !identifier(active.id) || !instant(active.approvedAt) || !instant(active.checkpointAt)
      || active.approvedAt >= active.checkpointAt || active.checkpointAt !== value.normalReadyByAt
      || active.deferredReadyByAt !== nextLocalChargingDay(active.checkpointAt)
      || !Number.isSafeInteger(active.revision) || active.revision < 1 || active.revision > request.revision)
    || !keys(last, ['id', 'action', 'at', 'revision', 'deadlineAt'])
      || !identifier(last.id) || !['allow', 'cancel', 'consume'].includes(last.action)
      || !instant(last.at) || !instant(last.deadlineAt)
      || !Number.isSafeInteger(last.revision) || last.revision < 1 || last.revision > request.revision
    || active != null && (last.action !== 'allow' || last.id !== active.id || last.at !== active.approvedAt
      || last.revision !== active.revision)
    || active == null && last.action === 'allow'
    || last.action === 'consume' && value.authorizedBaseline !== true
    || last.deadlineAt !== request.deadlineAt
    || request.deadlineAt !== (active?.deferredReadyByAt ?? value.normalReadyByAt))
    throw new Error('Unsupported saved charging flexibility; start a fresh development database');
}

/** A status projection is read-only, including after downtime. Only the write
 * owner commits consumption; crossing the checkpoint never adds permission. */
export function chargingFlexibility(request, now) {
  const saved = request?.flexibility, grant = saved?.activeDefer;
  const active = Boolean(grant && now < grant.checkpointAt);
  const normalReadyByAt = grant && !active ? grant.deferredReadyByAt : saved?.normalReadyByAt ?? request?.deadlineAt ?? null;
  return { normalReadyByAt, effectiveReadyByAt: active ? grant.deferredReadyByAt : normalReadyByAt,
    active, checkpointAt: active ? grant.checkpointAt : null,
    deferredReadyByAt: active ? grant.deferredReadyByAt : Number.isSafeInteger(normalReadyByAt) ? nextLocalChargingDay(normalReadyByAt) : null,
    revision: request?.revision ?? null };
}

export function consumeChargingFlexibility(request, now) {
  const grant = request?.flexibility?.activeDefer;
  if (!grant || now < grant.checkpointAt) return false;
  request.revision++;
  request.deadlineAt = grant.deferredReadyByAt;
  request.flexibility = { normalReadyByAt: grant.deferredReadyByAt, authorizedBaseline: true, activeDefer: null,
    lastTransition: { id: grant.id, action: 'consume', at: grant.checkpointAt,
      deadlineAt: grant.deferredReadyByAt, revision: request.revision } };
  return true;
}

/** The parent request already owns equipment and physical-session identity.
 * Keep one grant and one receipt, bounded for arbitrarily long connections. */
export function changeChargingFlexibility(request, { action, actionId }, now) {
  if (!identifier(actionId) || !['allow', 'cancel'].includes(action)) throw new Error('Invalid charging flexibility action');
  const saved = request.flexibility;
  if (saved?.activeDefer?.id === actionId && action === 'allow'
    || saved?.lastTransition?.id === actionId && (saved.lastTransition.action === action
      || saved.lastTransition.action === 'consume' && action === 'allow')) return false;
  consumeChargingFlexibility(request, now);
  const current = chargingFlexibility(request, now);
  if (action === 'allow' && (current.active || current.normalReadyByAt <= now))
    throw new Error(current.active ? 'One extra day is already allowed. Wait until its earlier ready-by time before adding another.'
      : 'This ready-by time has passed. Edit Ready by explicitly before allowing another day.');
  if (action === 'cancel' && !current.active) throw new Error('There is no active one-day allowance to cancel.');
  request.revision++;
  request.deadlineAt = action === 'allow' ? current.deferredReadyByAt : current.normalReadyByAt;
  request.flexibility = { normalReadyByAt: current.normalReadyByAt, authorizedBaseline: request.flexibility?.authorizedBaseline === true,
    activeDefer: action === 'allow' ? { id: actionId, checkpointAt: current.normalReadyByAt,
      deferredReadyByAt: current.deferredReadyByAt, approvedAt: now, revision: request.revision } : null,
    lastTransition: { id: actionId, action, at: now, deadlineAt: request.deadlineAt, revision: request.revision } };
  return true;
}

export function flexibilityUnavailable(view, now, enabled = true) {
  if (!enabled) return 'forecast-disabled';
  if (view.values.connected.value !== true || !view.request) return 'not-connected';
  if (view.requiredGridKwh <= 1e-7) return 'charging-complete';
  if (!view.settings.enabled || !view.capabilities.scheduling) return 'automatic-disabled';
  if (view.request.chargeNow) return 'charge-now';
  if (view.control?.manual || view.telemetry?.manualStop) return 'manual-instruction';
  if (view.control?.errorCode || view.control?.pending || ['charging', 'pausing'].includes(view.identification?.phase)
    || view.identification?.pauseOutstanding
    || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(view.identification?.currentTest?.phase)) return 'control-unavailable';
  const current = chargingFlexibility(view.request, now);
  if (current.active) return 'already-allowed';
  if (current.normalReadyByAt <= now) return 'ready-by-passed';
  return null;
}

/** A changed deadline needs the current runtime's separately supplied durable
 * session request, not merely a number embedded in an economic candidate. */
export function admittedChargingDeadlineRevision(plan, previousDeadlineAt, scope, connectedAt) {
  if (plan?.deadlineAt === previousDeadlineAt) return true;
  const proposed = plan?.priceRevision?.deadlineRequest;
  return Boolean(proposed && scope && identifier(scope.actionId)
    && Number.isSafeInteger(scope.revision) && scope.revision > 0
    && instant(connectedAt) && scope.connectedAt === connectedAt
    && scope.deadlineAt === plan.deadlineAt
    && ['actionId', 'revision', 'connectedAt', 'deadlineAt'].every(key => proposed[key] === scope[key]));
}
