export function homeHeatingWarning(status, formatTime) {
  const hold = status?.decision?.manualHold;
  if (!(status?.override?.expiresAt > status.now && hold?.until > status.now) || hold.changed === false) return '';
  const mode = ({ normal: 'Normal heating', reduction: 'Reduced heating', preheat: 'Preheat', recovery: 'Normal heating' })[hold.phase] ?? 'Your heating selection';
  const selection = hold.parameters ? `${mode} and changed heat-pump parameters` : mode;
  return `${selection} will stay until ${formatTime(hold.until)} or Resume now. Automatic price control is paused; room temperatures may change. Previous settings return when the pause ends.`;
}

export function garageHeatingWarning(status, formatTime) {
  const controls = status?.garage?.heatingControls;
  if (!(controls?.paused && controls.manualChanged && controls.holdUntil > status.now)) return '';
  const off = (controls.requestedMode ?? controls.selectedMode) === 'off';
  return `${off ? 'Heating is held off' : 'Manual heating is held'} until ${formatTime(controls.holdUntil)} or Resume now. ${off
    ? 'A cold garage can freeze pipes and stored equipment. Freeze protection may restore heating sooner.'
    : 'Automatic price control is paused.'} Normal heating returns when the pause ends.`;
}
