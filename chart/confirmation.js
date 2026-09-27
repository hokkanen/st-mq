const openDialogs = new WeakSet();

/** Shared app confirmation: Cancel first, focus restored, one modal at a time. */
export function confirmAction({ document, title, message, action = 'Apply change' }) {
  if (!document) return Promise.resolve(false);
  if (openDialogs.has(document)) return Promise.resolve(false);
  if (!document.defaultView?.HTMLDialogElement) return Promise.resolve(false);
  openDialogs.add(document);
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  dialog.setAttribute('aria-labelledby', 'confirmation-title');
  dialog.setAttribute('aria-describedby', 'confirmation-description');
  const heading = document.createElement('h3'); heading.id = 'confirmation-title'; heading.textContent = title;
  const description = document.createElement('p'); description.id = 'confirmation-description'; description.textContent = message;
  const actions = document.createElement('div'); actions.className = 'confirmation-actions';
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
