import { validShellyBootSample, validShellyBootEpoch } from './shelly-reboot.js';

const time = value => Number.isSafeInteger(value) && value >= 0;

/** A captured native clock observation is evidence, not a corrected timestamp. */
export function validShellyCommandClock(value, dispatchedAt = null, epoch) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'epoch,sample'
    && validShellyBootEpoch(value.epoch) && validShellyBootSample(value.sample)
    && (epoch === undefined || epoch === value.epoch)
    && (dispatchedAt === null || time(dispatchedAt) && value.sample.receivedAt <= dispatchedAt
      && (value.sample.admittedAt === undefined || value.sample.admittedAt <= dispatchedAt)));
}

/** Sys.GetStatus has whole-second precision and was sampled somewhere inside
 * its recorded request/reply interval. Translate the command interval into
 * native time using those bounds; do not add a clock-skew grace period. */
export function shellyCommandWindow(command) {
  const clock = command?.nativeClock;
  if (!validShellyCommandClock(clock, command?.dispatchedAt, command?.bootEpoch)
    || !time(command.dispatchedAt) || !time(command.acceptedAt) || command.acceptedAt < command.dispatchedAt) return null;
  const sample = clock.sample;
  return { lower: sample.unixtime * 1000 + command.dispatchedAt - sample.receivedAt,
    upper: (sample.unixtime + 1) * 1000 + command.acceptedAt - sample.requestedAt };
}

export function shellyCommandEventTime(at, command) {
  const window = shellyCommandWindow(command);
  return time(at) && window !== null && at >= window.lower && at < window.upper;
}

export function shellyCommandSettingTime(at, command) {
  const window = shellyCommandWindow(command);
  // Integral native update clocks locate a change inside that whole second.
  const precision = time(at) && at % 1000 === 0 ? 1000 : 1;
  return time(at) && window !== null && at < window.upper && at + precision > window.lower;
}
