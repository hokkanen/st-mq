import { isDeepStrictEqual } from 'node:util';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0;
const purposes = new Set(['session-cost', 'shelly-limiter']);

function scoped(value, scope, purpose) {
  if (!object(scope) || !identifier(scope.association)) return false;
  if (purpose === 'session-cost') {
    const request = scope.request, connectedAt = Number(request?.scope?.split(':').at(-1));
    return object(value?.value) && time(value.value.startAt) && object(request)
      && time(connectedAt) && request.scope === `${scope.association}:${connectedAt}`
      && request.sessionId === request.scope;
  }
  const physical = scope.physical;
  return value?.version === 1 && value.association === scope.association
    && time(scope.adapterGeneration)
    && identifier(scope.sessionId) && value.sessionId === scope.sessionId
    && object(physical) && physical.sessionId === scope.sessionId
    && time(physical.connectedAt) && time(physical.generation)
    && isDeepStrictEqual(value.limiter?.scope, physical);
}
function calculationClock(value, purpose) {
  return purpose === 'session-cost' ? value?.value?.updatedAt : value?.limiter?.evaluatedAt;
}
function withoutCalculationClock(value, purpose) {
  if (purpose === 'session-cost') {
    const { updatedAt, ...cost } = value.value;
    return { ...value, value: cost };
  }
  const { evaluatedAt, ...limiter } = value.limiter;
  return { ...value, limiter };
}

/** Only two derived calculation dates may avoid rewriting an otherwise exact
 * current state. Baselines belong to successful COMMIT, not a prepared write.
 * The callers validate the full current state before entering this boundary. */
export function createChargingCalculationWriter(store, purpose) {
  if (!purposes.has(purpose)) throw new Error('Unsupported charging calculation persistence');
  const admitted = new Map(), pending = new Map(), committedOrder = new Map();
  let issued = 0;
  function prepared(key, publish) {
    const order = ++issued, token = Symbol(), tokens = pending.get(key) ?? new Set();
    tokens.add(token); pending.set(key, tokens);
    const finish = () => {
      if (!tokens.delete(token)) return false;
      if (!tokens.size && pending.get(key) === tokens) pending.delete(key);
      return true;
    };
    store.afterRollback(() => { finish(); });
    store.afterCommit(() => {
      // An earlier afterCommit observer may synchronously commit a newer write.
      // Its cache must not be replaced by this older transaction's later hook.
      if (finish() && order > (committedOrder.get(key) ?? 0)) {
        committedOrder.set(key, order); publish();
      }
    });
  }
  function unchanged(key, value, scope) {
    const previous = admitted.get(key), date = calculationClock(value, purpose);
    const earlier = previous && calculationClock(previous.value, purpose);
    return Boolean(!pending.has(key) && previous && scoped(value, scope, purpose)
      && scoped(previous.value, previous.scope, purpose) && time(date) && time(earlier) && date >= earlier
      && isDeepStrictEqual(scope, previous.scope)
      && isDeepStrictEqual(withoutCalculationClock(value, purpose), withoutCalculationClock(previous.value, purpose)));
  }
  return {
    unchanged,
    write(key, value, scope) {
      if (unchanged(key, value, scope)) return false;
      // Clone before SQL or registration: a rejected clone/setter cannot leave
      // a pending token, and later RAM updates cannot mutate an admitted basis.
      const saved = structuredClone(value), savedScope = structuredClone(scope);
      store.setState(key, saved);
      prepared(key, () => { admitted.set(key, { value: saved, scope: savedScope }); });
      return true;
    },
    forget(key) {
      // Retirement is also a prepared change: A -> delete -> A in one outer
      // transaction must reinsert A rather than compare against its old cache.
      prepared(key, () => { admitted.delete(key); });
    },
  };
}
