const DAY = 86_400_000;
let nextPickerId = 0;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const timestamp = value => Date.parse(`${value}T00:00:00Z`);
const iso = time => new Date(time).toISOString().slice(0, 10);
const mondayIndex = value => (new Date(timestamp(value)).getUTCDay() + 6) % 7;
function moveMonth(value, amount) {
  const date = new Date(timestamp(value)), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const first = date.getTime();
  date.setUTCMonth(date.getUTCMonth() + 1);
  return iso(first + (Math.min(day, (date.getTime() - first) / DAY) - 1) * DAY);
}

/** Shared application calendar. Explicit day selection also confirms an unchanged
 * end-date suggestion; date/time drafts are committed only with Set. */
export function createDatePicker(input, { onSelect, label = 'Choose date', mode = 'date', now = () => Date.now() } = {}) {
  const document = input.ownerDocument, window = document.defaultView;
  const listeners = [], originalAttributes = {};
  let open = false, month, focusedDate, selectedDate;
  const withTime = mode === 'datetime-local';
  const originalType = input.type;
  for (const name of ['data-date-picker', 'autocomplete', 'spellcheck', 'placeholder', 'pattern']) originalAttributes[name] = input.getAttribute(name);
  input.type = 'text';
  input.setAttribute('data-date-picker', mode);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = withTime ? 'YYYY-MM-DDTHH:mm' : 'YYYY-MM-DD';
  input.setAttribute('pattern', withTime ? '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' : '[0-9]{4}-[0-9]{2}-[0-9]{2}');
  const listen = (node, type, listener, capture = false) => {
    node.addEventListener(type, listener, capture);
    listeners.push(() => node.removeEventListener(type, listener, capture));
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text, label) => {
    const node = element('button', className, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    return node;
  };
  const popup = element('div', 'date-picker');
  popup.id = `${input.id || 'date'}-picker-${++nextPickerId}`;
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', label);
  const header = element('div', 'date-picker-header');
  const previous = button('date-picker-nav', '‹', 'Previous month');
  const caption = element('span', 'date-picker-caption');
  caption.setAttribute('aria-live', 'polite');
  const next = button('date-picker-nav', '›', 'Next month');
  header.append(previous, caption, next);
  const weekdays = element('div', 'date-picker-weekdays');
  weekdays.setAttribute('aria-hidden', 'true');
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) weekdays.append(element('span', '', day));
  const days = element('div', 'date-picker-days');
  const closeButton = button('date-picker-close', 'Close');
  const footer = element('div', 'date-picker-actions');
  const clearButton = button('date-picker-clear', 'Clear');
  clearButton.hidden = input.required;
  footer.append(clearButton, closeButton);
  popup.append(header, weekdays, days);
  let hour, minute, apply;
  if (withTime) {
    const fields = element('div', 'date-picker-time');
    for (const [name, maximum] of [['Hour', 23], ['Minute', 59]]) {
      const field = element('input', '');
      field.type = 'number'; field.min = '0'; field.max = String(maximum); field.step = '1';
      field.required = true; field.inputMode = 'numeric';
      field.id = `${popup.id}-${name.toLowerCase()}`;
      const fieldLabel = element('label', '', name);
      fieldLabel.htmlFor = field.id; fieldLabel.append(field); fields.append(fieldLabel);
      if (name === 'Hour') hour = field; else minute = field;
    }
    popup.append(element('p', 'date-picker-time-label', 'Time · Finland'), fields);
    apply = button('date-picker-apply', 'Set'); footer.append(apply);
  }
  popup.append(footer);
  (input.closest('dialog') || input.closest('.history-panel') || document.body).append(popup);
  for (const [name, value] of Object.entries({ 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': popup.id })) {
    originalAttributes[name] = input.getAttribute(name);
    input.setAttribute(name, value);
  }

  const validValue = value => withTime
    ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && validDate(value.slice(0, 10))
    : validDate(value);
  const minimum = () => validDate(input.min?.slice(0, 10)) ? input.min.slice(0, 10) : null;
  const maximum = () => validDate(input.max?.slice(0, 10)) ? input.max.slice(0, 10) : null;
  const allowedDay = value => validDate(value) && (!minimum() || value >= minimum()) && (!maximum() || value <= maximum());
  const allowed = value => validValue(value) && (!input.min || value >= input.min) && (!input.max || value <= input.max);
  const unavailable = () => input.disabled || input.readOnly || input.matches?.(':disabled')
    || input.closest('[hidden], [inert]') || input.isConnected === false;
  function validate() {
    const valid = !input.value && !input.required || allowed(input.value);
    input.setCustomValidity(valid ? '' : withTime ? 'Enter a valid date and time within the allowed range.' : 'Enter a valid date within the allowed range.');
    return valid;
  }
  // Status polling assigns .value without events. Keep text-field validation in
  // sync so clearing an invalid draft or loading saved values never leaves a stale error.
  const valueDescriptor = window.HTMLInputElement && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  const ownValue = Object.getOwnPropertyDescriptor(input, 'value');
  if (valueDescriptor?.set && !ownValue) {
    Object.defineProperty(input, 'value', { configurable: true,
      get() { return valueDescriptor.get.call(this); },
      set(value) { valueDescriptor.set.call(this, value); validate(); },
    });
    listeners.push(() => { delete input.value; });
  }
  listen(input, 'input', validate);
  listen(input, 'change', validate);
  let observer;
  function observeContext() {
    if (!observer) return;
    observer.disconnect();
    observer.observe(input, { attributes: true, attributeFilter: ['min', 'max', 'disabled', 'hidden', 'required', 'readonly'] });
    for (let parent = input.parentElement; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ['disabled', 'hidden', 'inert'] });
  }
  if (window.MutationObserver) {
    observer = new window.MutationObserver(() => {
      validate();
      if (unavailable()) dismiss();
      else if (open) render();
    });
    observeContext();
    listeners.push(() => observer.disconnect());
  }
  const clamp = value => minimum() && value < minimum() ? minimum() : maximum() && value > maximum() ? maximum() : value;
  const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  const monthLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  function position() {
    if (!open) return;
    if (unavailable() || input.getClientRects && !input.getClientRects().length) { dismiss(); return; }
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight, margin = 8;
    const offsetLeft = viewport?.offsetLeft ?? 0, offsetTop = viewport?.offsetTop ?? 0;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    popup.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const anchor = input.getBoundingClientRect(), box = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(offsetLeft + margin, Math.min(anchor.left, offsetLeft + width - box.width - margin))}px`;
    const below = anchor.bottom + 4;
    const top = below + box.height <= offsetTop + height - margin ? below : anchor.top - box.height - 4;
    popup.style.top = `${Math.max(offsetTop + margin, Math.min(top, offsetTop + height - box.height - margin))}px`;
  }
  function dismiss(restoreFocus = false) {
    if (!open) return;
    open = false;
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    if (restoreFocus) input.focus();
  }
  function select(value) {
    if (unavailable() || (value === '' ? input.required : !allowed(value))) return;
    input.value = value; validate();
    dismiss(true);
    if (onSelect) onSelect(value);
    else {
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
  }
  function render(focus = false) {
    caption.textContent = monthLabel.format(timestamp(month));
    previous.disabled = Boolean(minimum() && month <= `${minimum().slice(0, 7)}-01`);
    next.disabled = Boolean(maximum() && month >= `${maximum().slice(0, 7)}-01`);
    days.textContent = '';
    for (let index = 0; index < mondayIndex(month); index++) days.append(element('span', ''));
    for (let value = month; value.slice(0, 7) === month.slice(0, 7); value = iso(timestamp(value) + DAY)) {
      const day = button('date-picker-day', String(Number(value.slice(8))), dayLabel.format(timestamp(value)));
      day.dataset.date = value;
      day.disabled = !allowedDay(value);
      day.tabIndex = !day.disabled && value === focusedDate ? 0 : -1;
      day.setAttribute('aria-pressed', String(value === (withTime ? selectedDate : input.value)));
      days.append(day);
      if (focus && value === focusedDate && !day.disabled) day.focus();
    }
    position();
  }
  function show() {
    if (unavailable()) return;
    observeContext();
    // The controller's local dates always mean Finland, independent of browser timezone.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now()).map(({ type, value }) => [type, value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    focusedDate = clamp(validDate(input.value.slice(0, 10)) ? input.value.slice(0, 10) : minimum() || today);
    selectedDate = focusedDate;
    if (withTime) {
      [hour.value, minute.value] = validValue(input.value) ? input.value.slice(11).split(':') : [parts.hour, parts.minute];
      minute.setCustomValidity('');
    }
    clearButton.hidden = input.required;
    month = `${focusedDate.slice(0, 7)}-01`;
    open = true;
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render(true);
  }
  function navigate(amount) {
    focusedDate = clamp(moveMonth(focusedDate, amount));
    month = `${focusedDate.slice(0, 7)}-01`;
    render();
  }
  listen(input, 'mousedown', event => { if (event.button === 0) event.preventDefault(); });
  listen(input, 'click', event => { event.preventDefault(); show(); });
  listen(input, 'keydown', event => {
    if (event.key === ' ' || (event.altKey && event.key === 'ArrowDown')) {
      event.preventDefault(); show();
    } else if (event.key === 'Enter' && !open) {
      event.preventDefault();
      if (input.checkValidity()) select(input.value);
    }
  });
  listen(previous, 'click', () => navigate(-1));
  listen(next, 'click', () => navigate(1));
  listen(closeButton, 'click', () => dismiss(true));
  listen(clearButton, 'click', () => select(''));
  function applyTime() {
    if (hour.value === '' || minute.value === '' || !Number.isInteger(Number(hour.value)) || !Number.isInteger(Number(minute.value))
      || Number(hour.value) < 0 || Number(hour.value) > 23 || Number(minute.value) < 0 || Number(minute.value) > 59) {
      hour.reportValidity(); minute.reportValidity(); return;
    }
    if (!hour.reportValidity() || !minute.reportValidity()) return;
    const value = `${selectedDate}T${String(Number(hour.value)).padStart(2, '0')}:${String(Number(minute.value)).padStart(2, '0')}`;
    if (!allowed(value)) {
      minute.setCustomValidity('Choose a time within the allowed range.'); minute.reportValidity(); return;
    }
    select(value);
  }
  if (withTime) {
    listen(apply, 'click', applyTime);
    for (const field of [hour, minute]) {
      listen(field, 'input', () => minute.setCustomValidity(''));
      listen(field, 'keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); applyTime(); }
      });
    }
  }
  listen(days, 'click', event => {
    const day = event.target.closest('[data-date]');
    if (!day || !days.contains(day) || day.disabled) return;
    if (withTime) {
      selectedDate = focusedDate = day.dataset.date;
      minute.setCustomValidity(''); render(true);
    } else select(day.dataset.date);
  });
  listen(popup, 'keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); dismiss(true); return;
    }
    const day = event.target.closest('[data-date]');
    if (!day) return;
    const value = day.dataset.date;
    let target;
    if (event.key === 'ArrowLeft') target = iso(timestamp(value) - DAY);
    else if (event.key === 'ArrowRight') target = iso(timestamp(value) + DAY);
    else if (event.key === 'ArrowUp') target = iso(timestamp(value) - 7 * DAY);
    else if (event.key === 'ArrowDown') target = iso(timestamp(value) + 7 * DAY);
    else if (event.key === 'Home') target = iso(timestamp(value) - mondayIndex(value) * DAY);
    else if (event.key === 'End') target = iso(timestamp(value) + (6 - mondayIndex(value)) * DAY);
    else if (event.key === 'PageUp') target = moveMonth(value, event.shiftKey ? -12 : -1);
    else if (event.key === 'PageDown') target = moveMonth(value, event.shiftKey ? 12 : 1);
    if (!target) return;
    event.preventDefault();
    focusedDate = clamp(target);
    month = `${focusedDate.slice(0, 7)}-01`;
    render(true);
  });
  const outside = event => { if (open && event.target !== input && !popup.contains(event.target)) dismiss(); };
  listen(document, 'mousedown', outside, true);
  listen(document, 'touchstart', outside, true);
  listen(document, 'focusin', outside);
  listen(document, 'toggle', event => {
    if (!event.target.open && event.target.contains?.(input)) dismiss();
  }, true);
  listen(document, 'close', event => { if (event.target.contains?.(input)) dismiss(); }, true);
  listen(window, 'resize', position);
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', position);
    listen(window.visualViewport, 'scroll', position);
  }
  listen(document, 'scroll', position, true);

  return { dismiss, close() {
    dismiss();
    for (const remove of listeners) remove();
    popup.remove();
    input.type = originalType;
    input.setCustomValidity('');
    for (const [name, value] of Object.entries(originalAttributes)) {
      if (value === null) input.removeAttribute(name);
      else input.setAttribute(name, value);
    }
  } };
}
