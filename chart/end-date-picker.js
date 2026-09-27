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

/** Native date controls omit change events when the selected date is unchanged.
 * Keep the editable input, but use explicit day buttons to confirm its suggestion. */
export function createEndDatePicker(input, { onSelect }) {
  const document = input.ownerDocument, window = document.defaultView;
  const listeners = [], originalAttributes = {};
  let open = false, month, focusedDate;
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
  const popup = element('div', 'end-date-picker');
  popup.id = `${input.id || 'end-date'}-picker-${++nextPickerId}`;
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Choose end date');
  const header = element('div', 'end-date-picker-header');
  const previous = button('end-date-picker-nav', '‹', 'Previous month');
  const caption = element('span', 'end-date-picker-caption');
  caption.setAttribute('aria-live', 'polite');
  const next = button('end-date-picker-nav', '›', 'Next month');
  header.append(previous, caption, next);
  const weekdays = element('div', 'end-date-picker-weekdays');
  weekdays.setAttribute('aria-hidden', 'true');
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) weekdays.append(element('span', '', day));
  const days = element('div', 'end-date-picker-days');
  const closeButton = button('end-date-picker-close', 'Close');
  popup.append(header, weekdays, days, closeButton);
  (input.closest('.history-panel') || document.body).append(popup);
  for (const [name, value] of Object.entries({ 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': popup.id })) {
    originalAttributes[name] = input.getAttribute(name);
    input.setAttribute(name, value);
  }

  const minimum = () => validDate(input.min) ? input.min : null;
  const maximum = () => validDate(input.max) ? input.max : null;
  const allowed = value => validDate(value) && (!minimum() || value >= minimum()) && (!maximum() || value <= maximum());
  const clamp = value => minimum() && value < minimum() ? minimum() : maximum() && value > maximum() ? maximum() : value;
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  const monthLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  function position() {
    if (!open) return;
    const width = window.innerWidth, height = window.innerHeight, margin = 8;
    popup.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const anchor = input.getBoundingClientRect(), box = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(margin, Math.min(anchor.left, width - box.width - margin))}px`;
    const below = anchor.bottom + 4;
    const top = below + box.height <= height - margin ? below : anchor.top - box.height - 4;
    popup.style.top = `${Math.max(margin, Math.min(top, height - box.height - margin))}px`;
  }
  function dismiss(restoreFocus = false) {
    if (!open) return;
    open = false;
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    if (restoreFocus) input.focus();
  }
  function select(value) {
    if (!allowed(value)) return;
    input.value = value;
    dismiss(true);
    onSelect(value);
  }
  function render(focus = false) {
    caption.textContent = monthLabel.format(timestamp(month));
    previous.disabled = Boolean(minimum() && month <= `${minimum().slice(0, 7)}-01`);
    next.disabled = Boolean(maximum() && month >= `${maximum().slice(0, 7)}-01`);
    days.textContent = '';
    for (let index = 0; index < mondayIndex(month); index++) days.append(element('span', ''));
    for (let value = month; value.slice(0, 7) === month.slice(0, 7); value = iso(timestamp(value) + DAY)) {
      const day = button('end-date-picker-day', String(Number(value.slice(8))), label.format(timestamp(value)));
      day.dataset.date = value;
      day.disabled = !allowed(value);
      day.tabIndex = !day.disabled && value === focusedDate ? 0 : -1;
      day.setAttribute('aria-pressed', String(value === input.value));
      days.append(day);
      if (focus && value === focusedDate && !day.disabled) day.focus();
    }
    position();
  }
  function show() {
    if (input.disabled) return;
    focusedDate = clamp(validDate(input.value) ? input.value : minimum() || iso(Date.now()));
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
  listen(days, 'click', event => {
    const day = event.target.closest('[data-date]');
    if (day && days.contains(day)) select(day.dataset.date);
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
  listen(window, 'resize', position);
  listen(document, 'scroll', position, true);

  return { dismiss, close() {
    dismiss();
    for (const remove of listeners) remove();
    popup.remove();
    for (const [name, value] of Object.entries(originalAttributes)) {
      if (value === null) input.removeAttribute(name);
      else input.setAttribute(name, value);
    }
  } };
}
