// Historical electrical association is separate from fresh source/control evidence.
export const CARAVAN_ASSOCIATION_GRACE_MS = 60_000;
export const CARAVAN_FEED_STABLE_MS = 30_000;
export const CARAVAN_ASSOCIATION_CHECKPOINT_MS = 30_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;
const optionalTime = value => value === null || time(value);

export const caravanQualificationKey = (id, identity, signature) =>
  `equipment:caravan-qualification:v1:${id}:${identity}:${signature}`;
export const caravanQualificationCurrentKey = id => `equipment:caravan-qualification-current:v1:${id}`;

export function validateCaravanQualificationCurrent(value) {
  if (value === null || value === undefined) return null;
  if (!keys(value, 'identity,signature') || !digest(value.identity) || !digest(value.signature))
    throw new Error('Equipment saved Caravan qualification selection is invalid.');
  return value;
}

export function caravanAssociationProof(evidence) {
  return Object.fromEntries(['startedAt', 'completedAt', 'powerRiseW', 'powerFallW', 'minimumChangeW', 'phases']
    .map(key => [key, structuredClone(evidence[key])]));
}

function validProof(proof) {
  if (!keys(proof, 'completedAt,minimumChangeW,phases,powerFallW,powerRiseW,startedAt')
    || !time(proof.startedAt) || !time(proof.completedAt) || proof.startedAt > proof.completedAt
    || !Number.isFinite(proof.minimumChangeW) || proof.minimumChangeW < 3
    || !Number.isFinite(proof.powerRiseW) || proof.powerRiseW < proof.minimumChangeW
    || !Number.isFinite(proof.powerFallW) || proof.powerFallW < proof.minimumChangeW
    || !keys(proof.phases, 'baseline,off,on')) return false;
  const { baseline, on, off } = proof.phases;
  return Object.entries(proof.phases).every(([phase, value]) =>
    keys(value, 'commandAt,firstPowerObservedAt,lastPowerObservedAt')
    && (phase === 'baseline' ? optionalTime(value.commandAt) : time(value.commandAt))
    && time(value.firstPowerObservedAt) && time(value.lastPowerObservedAt)
    && value.firstPowerObservedAt <= value.lastPowerObservedAt
    && value.lastPowerObservedAt <= proof.completedAt
    && (value.commandAt === null || value.commandAt >= proof.startedAt
      && value.commandAt <= value.firstPowerObservedAt))
    && baseline.lastPowerObservedAt <= on.commandAt
    && on.lastPowerObservedAt <= off.commandAt;
}

export function validateCaravanQualification(value, { identity, signature, meterSignature } = {}) {
  if (value === null || value === undefined) return null;
  if (!keys(value, 'failed,identity,invalidatedAt,lastHealthyAt,meterAt,meterSignature,outageAt,powerAt,proof,recheckAt,revision,signature')
    || !digest(value.identity) || !digest(value.signature) || !digest(value.meterSignature)
    || identity !== undefined && value.identity !== identity || signature !== undefined && value.signature !== signature
    || meterSignature !== undefined && value.meterSignature !== meterSignature
    || value.proof !== null && !validProof(value.proof)
    || !time(value.lastHealthyAt) || !time(value.powerAt) || !time(value.meterAt)
    || value.powerAt > value.lastHealthyAt || value.meterAt > value.lastHealthyAt
    || value.proof !== null && value.proof.completedAt > value.lastHealthyAt
    || !optionalTime(value.outageAt) || !optionalTime(value.invalidatedAt)
    || !optionalTime(value.recheckAt) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || value.failed !== null && (!keys(value.failed, 'at,reason') || !time(value.failed.at)
      || typeof value.failed.reason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.failed.reason))
    || value.proof === null && value.invalidatedAt === null
    || value.recheckAt !== null && value.invalidatedAt === null
    || value.failed !== null && value.invalidatedAt === null)
    throw new Error('Equipment saved Caravan qualification is invalid; preserve the database and use a deliberate fresh development start.');
  return value;
}

export function validateSavedCaravanQualification(db) {
  for (const row of db.prepare("SELECT key,value FROM state WHERE key GLOB 'equipment:caravan-qualification:*' OR key GLOB 'equipment:caravan-qualification-current:*'").iterate()) {
    try {
      if (/^equipment:caravan-qualification-current:v1:[^:]+$/.test(row.key)) {
        const selected = JSON.parse(row.value);
        if (selected === null) throw new Error('absent saved selection');
        validateCaravanQualificationCurrent(selected);
        continue;
      }
      const match = /^equipment:caravan-qualification:v1:([^:]+):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(row.key);
      const saved = JSON.parse(row.value);
      if (!match || saved === null) throw new Error('invalid qualification key or absent saved row');
      validateCaravanQualification(saved, { identity: match[2], signature: match[3] });
    } catch {
      throw Object.assign(new Error('Unsupported or unreadable Caravan qualification. Preserve this database and use an intact current-version backup or a deliberate fresh development start. The existing database was not changed.'),
        { code: 'database_state_incompatible' });
    }
  }
}

export function createCaravanQualification(record = null, startedAt = null) {
  return { record: record && structuredClone(record),
    // Nothing observed during downtime can be inferred from starting a process.
    outageAt: record ? record.outageAt ?? record.lastHealthyAt : null,
    startedAt, recoveryAfter: startedAt ?? (record ? record.outageAt ?? record.lastHealthyAt : null),
    lastEvaluatedAt: record?.lastHealthyAt ?? startedAt,
    stable: null, ready: false, lastPowerAt: null, lastMeterAt: null };
}

export function loseCaravanQualification(watch, at) {
  if (!time(at)) return;
  watch.outageAt = watch.outageAt === null ? at : Math.min(watch.outageAt, at);
  watch.stable = null; watch.ready = false;
  if (watch.record) watch.record.outageAt = watch.outageAt;
}

/** Only admitted, healthy source clocks enter this function. Repeated cache reads
 * cannot end an outage, finish recovery or refresh the durable checkpoint. */
export function advanceCaravanQualification(watch, { now, healthy, powerAt, meterAt, lostAt = now }) {
  const record = watch.record;
  if (time(now) && time(watch.lastEvaluatedAt) && now < watch.lastEvaluatedAt) {
    loseCaravanQualification(watch, watch.lastEvaluatedAt);
    return { ready: false, testReady: false };
  }
  if (time(now)) watch.lastEvaluatedAt = now;
  if (time(now) && watch.outageAt !== null && record && now >= record.lastHealthyAt
    && now >= watch.outageAt + CARAVAN_ASSOCIATION_GRACE_MS) {
    record.invalidatedAt = Math.max(record.invalidatedAt ?? 0, watch.outageAt + CARAVAN_ASSOCIATION_GRACE_MS);
    record.failed = null;
  }
  if (!time(now) || record && now < record.lastHealthyAt || !healthy
    || !time(powerAt) || !time(meterAt) || powerAt > now || meterAt > now) {
    loseCaravanQualification(watch, lostAt); return { ready: false, testReady: false };
  }
  if (watch.outageAt !== null) {
    // Expiration precedes accepting a late return. Original loss is not rebased.
    if (powerAt <= watch.outageAt || meterAt <= watch.outageAt
      || powerAt < (watch.recoveryAfter ?? 0) || meterAt < (watch.recoveryAfter ?? 0)) {
      watch.ready = false; return { ready: false, testReady: false };
    }
    watch.outageAt = null;
    if (record) {
      record.outageAt = null;
      record.lastHealthyAt = now; record.powerAt = powerAt; record.meterAt = meterAt;
    }
  }
  if (!watch.stable || powerAt < watch.stable.lastPowerAt || meterAt < watch.stable.lastMeterAt
    || now < watch.stable.startedAt) {
    watch.stable = { startedAt: now, firstPowerAt: powerAt, firstMeterAt: meterAt,
      lastPowerAt: powerAt, lastMeterAt: meterAt };
  }
  watch.stable.lastPowerAt = powerAt; watch.stable.lastMeterAt = meterAt;
  const advanced = powerAt > (watch.lastPowerAt ?? -1) || meterAt > (watch.lastMeterAt ?? -1);
  watch.lastPowerAt = powerAt; watch.lastMeterAt = meterAt;
  if (record && advanced && powerAt > record.powerAt && meterAt > record.meterAt
    && now - record.lastHealthyAt >= CARAVAN_ASSOCIATION_CHECKPOINT_MS) {
    record.lastHealthyAt = now; record.powerAt = powerAt; record.meterAt = meterAt;
  }
  const stable = now - watch.stable.startedAt >= CARAVAN_FEED_STABLE_MS
    && powerAt - watch.stable.firstPowerAt >= CARAVAN_FEED_STABLE_MS
    && meterAt - watch.stable.firstMeterAt >= CARAVAN_FEED_STABLE_MS;
  watch.ready = Boolean(stable && record?.proof && record.invalidatedAt === null && record.failed === null);
  return { ready: watch.ready, testReady: stable && !watch.ready
    && (!record?.failed || record.failed.reason === 'controller-stopping') };
}
