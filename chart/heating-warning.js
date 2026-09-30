export function homeHeatingWarning(status, formatTime) {
  const hold = status?.decision?.manualHold;
  const now = status?.now ?? Date.now(), pause = status?.override;
  if (!pause || !(pause.expiresAt === null || pause.expiresAt > now)
    || !hold || !(hold.until === null || hold.until > now) || hold.changed === false) return '';
  const mode = ({ normal: 'Normal heating', reduction: 'Reduced heating', preheat: 'Preheat', recovery: 'Normal heating' })[hold.phase] ?? 'Your heating selection';
  const scope = hold.until === null ? 'until you choose another mode or Automatic' : `until ${formatTime(hold.until)} or you choose another mode`;
  return `${mode} stays ${scope}. Automatic heating is paused; room temperatures may change. ${hold.phase === 'preheat' ? 'The ROOM increase and floor circulation end at the preheat deadline.' : 'Automatic control resumes when the pause ends.'}`;

}

export function garageHeatingWarning(status) {
  const warning = status?.garage?.warmingWarning;
  if (!warning || !Number.isFinite(warning.since) || warning.since > (status.now ?? Date.now())) return '';
  if (Number.isFinite(warning.until) && warning.until <= (status.now ?? Date.now())) return '';
  return warning.message || 'The temperature target has increased. Stored items and surfaces may stay cold: avoid wet or snowy vehicles and substantial moisture for roughly 24 hours, and longer if contents remain cold.';
}
