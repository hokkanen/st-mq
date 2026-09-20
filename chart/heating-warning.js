const openDialogs = new WeakSet();

/** One confirmation for a deliberate change that outlasts the normal update. */
export function confirmPausedHeating({ document, title, message, action = 'Apply change' }) {
  if (openDialogs.has(document)) return Promise.resolve(false);
  if (!document.defaultView?.HTMLDialogElement)
    return Promise.resolve(document.defaultView?.confirm(`${title}\n\n${message}`) ?? false);
  openDialogs.add(document);
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'heating-warning-dialog';
  dialog.setAttribute('aria-labelledby', 'heating-warning-title');
  dialog.setAttribute('aria-describedby', 'heating-warning-description');
  const heading = document.createElement('h3'); heading.id = 'heating-warning-title'; heading.textContent = title;
  const description = document.createElement('p'); description.id = 'heating-warning-description'; description.textContent = message;
  const actions = document.createElement('div'); actions.className = 'heating-warning-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = 'Cancel';
  const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = action;
  cancel.addEventListener('click', () => dialog.close('cancel'));
  apply.addEventListener('click', () => dialog.close('apply'));
  actions.append(cancel, apply); dialog.append(heading, description, actions); document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'apply';
      dialog.remove(); openDialogs.delete(document); previousFocus?.focus(); resolve(accepted);
    }, { once: true });
    dialog.showModal(); cancel.focus();
  });
}

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
