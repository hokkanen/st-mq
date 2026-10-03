// Installation plan only. This descriptor does not establish connectivity,
// electrical state, firmware compatibility or permission to operate relays.
export const FLOOR_PREHEAT_DEVICE = Object.freeze({
  group: 'groundfloor', label: 'Ground-floor circuits', model: 'SONOFF 4CH PRO R3', source: 'SONOFF',
});

export const FLOOR_PREHEAT_CIRCUITS = Object.freeze([
  { id: 1, label: 'Living', lengthM: 106 },
  { id: 2, label: 'Living', lengthM: 62 },
  { id: 3, label: 'Storage', lengthM: 38 },
  { id: 4, label: 'Storage', lengthM: 80 },
].map(Object.freeze));

export const FLOOR_PREHEAT_SIGNALS = Object.freeze(FLOOR_PREHEAT_CIRCUITS
  .map(({ id }) => `floor_groundfloor_${id}_active`));
