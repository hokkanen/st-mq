const clockPattern = '(?:[01][0-9]|2[0-3]):[0-5][0-9]';
const validClock = value => new RegExp(`^${clockPattern}$`).test(value);

// Native time dialogs belong to the browser and can be clipped in DeX. Keep
// keyboard entry and use one viewport-bounded dialog for the charging fields.
export function createChargingTime({ document, idPrefix = 'charging-time' }) {
  const entries = new Map(), listeners = [];
  let dialog, form, hour, minute, active, title, description;
  const make = (tag, text = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (id) node.id = id;
    return node;
  };
  const bind = (node, event, action) => {
    node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action));
  };
  function createDialog() {
    dialog = make('dialog', '', `${idPrefix}-dialog`); dialog.className = 'control-dialog charging-time-dialog';
    dialog.setAttribute('aria-labelledby', `${idPrefix}-title`);
    dialog.setAttribute('aria-describedby', `${idPrefix}-description`);
    title = make('h2', '', `${idPrefix}-title`);
    description = make('p', '', `${idPrefix}-description`);
    form = make('form', '', `${idPrefix}-form`);
    const fields = make('div'); fields.className = 'charging-time-fields';
    const clockPart = (name, max) => {
      const input = make('input', '', `${idPrefix}-${name.toLowerCase()}`);
      input.type = 'number'; input.min = 0; input.max = max; input.step = 1; input.required = true; input.inputMode = 'numeric';
      const label = make('label', name); label.htmlFor = input.id; label.append(input); fields.append(label);
      return input;
    };
    hour = clockPart('Hour', 23); minute = clockPart('Minute', 59);
    const content = make('div'); content.className = 'charging-time-content'; content.append(title, description, fields);
    const actions = make('div'); actions.className = 'charging-time-actions';
    const cancel = make('button', 'Cancel', `${idPrefix}-cancel`); cancel.type = 'button'; cancel.className = 'secondary-button';
    const apply = make('button', 'Set', `${idPrefix}-set`); apply.type = 'submit';
    actions.append(cancel, apply); form.append(content, actions); dialog.append(form); document.body.append(dialog);
    bind(cancel, 'click', () => dialog.close());
    bind(dialog, 'close', () => {
      const button = active?.button; active = null;
      if (button?.isConnected && !button.disabled) button.focus({ preventScroll: true });
    });
    bind(form, 'submit', event => {
      event.preventDefault();
      if (!active || active.input.disabled || !form.reportValidity()) return;
      const hours = Number(hour.value), minutes = Number(minute.value);
      if (hour.value === '' || minute.value === '' || !Number.isInteger(hours) || !Number.isInteger(minutes)
        || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return;
      const input = active.input, value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      dialog.close();
      if (input.value === value) return;
      input.value = value;
      input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    });
  }
  return {
    attach(input, container, options = {}) {
      input.type = 'text'; input.pattern = clockPattern; input.placeholder = 'HH:mm'; input.maxLength = 5;
      input.title = '24-hour time, HH:mm'; input.autocomplete = 'off'; input.spellcheck = false;
      container.classList.add('charging-time-field');
      const button = make('button', 'Choose time', `${input.id}-choose`); button.type = 'button';
      button.className = 'secondary-button charging-time-choose'; button.disabled = input.disabled;
      button.setAttribute('aria-label', options.label ?? 'Choose ready-by time'); button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', `${idPrefix}-dialog`); container.append(button);
      const entry = { input, button, scope: null }; entries.set(input, entry);
      bind(button, 'click', () => {
        if (input.disabled || button.disabled) return;
        if (!dialog) createDialog();
        if (dialog.open) return;
        title.textContent = typeof options.title === 'function' ? options.title() : options.title ?? 'Ready-by time · local';
        description.textContent = options.description ?? 'Choose a time, then save the session settings.';
        const value = validClock(input.value) ? input.value : '00:00';
        [hour.value, minute.value] = value.split(':'); active = entry;
        dialog.showModal(); hour.focus();
      });
    },
    update(input, scope) {
      const entry = entries.get(input); if (!entry) return;
      entry.button.disabled = input.disabled;
      if (active === entry && (input.disabled || entry.scope !== scope)) dialog.close();
      entry.scope = scope;
    },
    remove(input) {
      if (active?.input === input) dialog.close();
      entries.delete(input);
    },
    dismiss() { if (dialog?.open) dialog.close(); },
    close() {
      if (dialog?.open) dialog.close();
      for (const remove of listeners) remove();
      dialog?.remove(); entries.clear();
    },
  };
}
