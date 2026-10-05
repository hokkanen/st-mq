// One shared preference, edited outside the dashboard's layout. The charging
// panel owns authorization, request serialization and authoritative revisions.
export function createChargingPriority({ document, save }) {
  const choices = ['balanced', 'charger1', 'charger2'], entries = new Map(), listeners = [];
  let charging, deviceScope, writable = false, busy = false, saving = false, disposed = false;
  let dialog, form, current, message, apply, cancel, invoker, draft, edited = false;
  const radios = new Map();
  const make = (tag, text = '', className = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    if (id) node.id = id;
    return node;
  };
  const bind = (node, event, action) => {
    node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action));
  };
  const committed = () => choices.includes(charging?.settings?.priority) ? charging.settings.priority : null;
  const label = value => value === 'balanced' ? 'Balanced'
    : charging?.chargers?.find(charger => charger.id === value)?.label
      ?? ({ charger1: 'Charger 1', charger2: 'Charger 2' })[value] ?? 'Unavailable';
  function refresh() {
    const selected = committed(), locked = busy || saving || !writable || !selected;
    for (const { button, value } of entries.values()) {
      value.textContent = label(selected);
      button.setAttribute('aria-label', `Shared charger priority: ${label(selected)}`);
      button.disabled = busy || saving;
    }
    if (!dialog) return;
    if (!dialog.open || !edited) draft = selected;
    current.textContent = `Saved: ${label(selected)}${!writable ? ' · Read-only' : ''}`;
    for (const [choice, nodes] of radios) {
      nodes.input.checked = draft === choice; nodes.input.disabled = locked;
      const charger = charging?.chargers?.find(item => item.id === choice);
      const provider = ({ easee: 'Easee', 'shelly-evse': 'Shelly' })[charger?.provider];
      nodes.title.textContent = label(choice);
      nodes.detail.textContent = choice === 'balanced'
        ? 'Share any unavoidable shortfall in proportion to each charger’s remaining request.'
        : `Favor this charging point when both requests cannot be met.${provider ? ` ${provider} · any connected vehicle.` : ' Applies to any connected vehicle.'}`;
    }
    apply.disabled = locked || !choices.includes(draft) || draft === selected;
    apply.textContent = saving ? 'Saving' : 'Save priority';
    cancel.disabled = saving;
    cancel.textContent = writable && draft !== selected ? 'Cancel' : 'Close';
    form.setAttribute('aria-busy', String(saving));
  }
  function createDialog() {
    dialog = make('dialog', '', 'charging-priority-dialog', 'charging-priority-dialog');
    dialog.setAttribute('aria-labelledby', 'charging-priority-title');
    dialog.setAttribute('aria-describedby', 'charging-priority-description');
    const title = make('h2', 'Charger priority', '', 'charging-priority-title');
    const description = make('p', 'Shared by both charging points. Stays in effect until you change it, including after unplugging.', '', 'charging-priority-description');
    current = make('p', '', 'charging-priority-current', 'charging-priority-current');
    current.setAttribute('role', 'status');
    form = make('form', '', '', 'charging-priority-form');
    const fieldset = make('fieldset', '', 'charging-priority-options');
    fieldset.append(make('legend', 'When charging capacity is limited'));
    for (const choice of choices) {
      const option = make('label', '', 'charging-priority-option');
      const input = make('input', '', '', `charging-priority-${choice}`);
      input.type = 'radio'; input.name = 'charging-priority'; input.value = choice;
      const text = make('span'), title = make('strong', '', '', `${input.id}-title`), detail = make('small', '', '', `${input.id}-description`);
      input.setAttribute('aria-labelledby', title.id);
      input.setAttribute('aria-describedby', detail.id);
      text.append(title, detail); option.append(input, text); fieldset.append(option);
      radios.set(choice, { input, title, detail });
      bind(input, 'change', () => {
        if (input.disabled) return;
        draft = choice; edited = true; message.textContent = ''; message.classList.remove('form-error'); refresh();
      });
    }
    const note = make('p', 'The planner protects both ready-by times where possible and chooses lower-cost charging periods. Priority does not override manual charging instructions.', 'charging-priority-note');
    message = make('p', '', 'temporary-status', 'charging-priority-message'); message.setAttribute('role', 'status');
    const actions = make('div', '', 'confirmation-actions');
    cancel = make('button', 'Close', 'secondary-button', 'charging-priority-cancel'); cancel.type = 'button';
    apply = make('button', 'Save priority', '', 'charging-priority-save'); apply.type = 'submit'; apply.setAttribute('data-write-control', '');
    actions.append(cancel, apply); form.append(fieldset, note, message, actions);
    dialog.append(title, description, current, form); document.body.append(dialog);
    bind(cancel, 'click', () => { if (!saving) dialog.close(); });
    bind(dialog, 'cancel', event => { if (saving) event.preventDefault(); });
    bind(dialog, 'close', () => {
      edited = false; draft = committed();
      if (invoker?.isConnected) invoker.focus({ preventScroll: true });
      invoker = null;
    });
    bind(form, 'submit', async event => {
      event.preventDefault(); if (apply.disabled || saving) return;
      const requested = draft;
      saving = true; refresh();
      try {
        const saved = await save(requested, message);
        if (disposed) return;
        if (saved && committed() === requested) {
          // Native close restores focus immediately; the invoking button must
          // already be enabled when that happens.
          saving = false; refresh(); dialog.close();
        }
        else if (saved) {
          message.textContent = 'The saved priority changed while saving. Review the current value and try again.';
          message.classList.add('form-error');
        }
      } finally { saving = false; if (!disposed) refresh(); }
    });
  }
  return {
    createEntry(id) {
      const button = make('button', '', 'charging-priority-entry', `${id}-shared-priority`); button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'charging-priority-dialog');
      const text = make('span'), title = make('strong', 'Charger priority'), scope = make('small', 'Shared by both chargers');
      text.append(title, scope);
      const value = make('span', '', 'charging-priority-entry-value', `${id}-shared-priority-value`);
      button.append(text, value); entries.set(id, { button, value });
      bind(button, 'click', () => {
        if (button.disabled || disposed) return;
        if (!dialog) createDialog();
        if (dialog.open) return;
        invoker = button; edited = false; draft = committed();
        message.textContent = ''; message.classList.remove('form-error'); refresh();
        dialog.showModal();
        const selected = radios.get(draft)?.input;
        (selected && !selected.disabled ? selected : cancel).focus();
      });
      refresh(); return button;
    },
    removeEntry(id) { entries.delete(id); },
    update(next, controls) {
      const nextScope = JSON.stringify((next?.chargers ?? []).map(charger => [charger.id, charger.association]));
      if (deviceScope !== undefined && deviceScope !== nextScope && dialog?.open) {
        edited = false; dialog.close();
      }
      deviceScope = nextScope; charging = next; writable = controls.writable; busy = controls.busy; refresh();
    },
    close() {
      disposed = true;
      if (dialog?.open) dialog.close();
      for (const remove of listeners) remove();
      dialog?.remove(); entries.clear();
    },
  };
}
