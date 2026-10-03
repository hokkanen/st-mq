// Independent access, replica and pending-request restrictions share one native
// baseline. Releasing one restriction must never restore another one's lock.
const states = new WeakMap();

function attribute(control, name, value) {
  if (control.getAttribute(name) === value) return;
  if (value === null) control.removeAttribute(name);
  else control.setAttribute(name, value);
}

function apply(control, state) {
  const locked = state.owners.size > 0;
  if ('disabled' in control && control.disabled !== (locked || state.disabled))
    control.disabled = locked || state.disabled;
  const reasons = [...state.owners.values()].filter(reason => reason !== null);
  attribute(control, 'title', reasons.at(-1) ?? state.title);
  attribute(control, 'aria-disabled', locked ? 'true' : state.ariaDisabled);
}

export function lockControl(control, owner, reason = null) {
  let state = states.get(control);
  if (!state) {
    state = { disabled: control.disabled, title: control.getAttribute('title'),
      ariaDisabled: control.getAttribute('aria-disabled'), owners: new Map() };
    states.set(control, state);
  }
  state.owners.set(owner, reason);
  apply(control, state);
}

export function unlockControl(control, owner, { preserveDisabled = false } = {}) {
  const state = states.get(control);
  if (!state?.owners.delete(owner)) return;
  if (preserveDisabled && !state.owners.size) state.disabled = control.disabled;
  apply(control, state);
  if (!state.owners.size) states.delete(control);
}
