let nextPickerId = 0;

const optionDisabled = option => option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled;
const optionHidden = option => option.hidden || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.hidden;
const property = (node, name) => {
  for (let prototype = node; prototype; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) return descriptor;
  }
};

/** Keep form controls as the value/validation source; render every single-choice
 * dropdown with the same application listbox, including controls added later. */
export function createSelectPickers(document) {
  const window = document.defaultView, entries = new Map(), listeners = [];
  let active, disposed = false, invalidFocus = false;
  const listen = (node, type, listener, capture = false, removers = listeners) => {
    node.addEventListener(type, listener, capture);
    removers.push(() => node.removeEventListener(type, listener, capture));
  };
  const make = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const attribute = (node, name, value) => {
    if (value === null || value === undefined || value === '') {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  };
  const disabled = entry => entry.select.disabled || entry.select.matches(':disabled');
  const available = entry => entry.select.isConnected && !disabled(entry) && !entry.select.hidden
    && !entry.select.closest('[hidden], [inert]') && Boolean(entry.button.getClientRects().length);
  const options = entry => [...entry.select.options];
  const choices = entry => options(entry).filter(option => !optionDisabled(option) && !optionHidden(option));
  function dismiss() {
    if (!active) return;
    const entry = active; active = null;
    if (typeof entry.popup.hidePopover === 'function' && entry.popup.matches(':popover-open')) entry.popup.hidePopover();
    entry.popup.hidden = true;
    attribute(entry.button, 'aria-expanded', 'false');
    attribute(entry.button, 'aria-activedescendant', null);
    entry.search = '';
  }
  function position() {
    if (!active) return;
    const { button, popup } = active, anchor = button.getBoundingClientRect();
    if (!button.getClientRects().length) { dismiss(); return; }
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0, margin = 8;
    popup.style.minWidth = `${Math.min(anchor.width, width - margin * 2)}px`;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    const below = top + height - anchor.bottom - margin - 4;
    const above = anchor.top - top - margin - 4;
    const downward = below >= Math.min(popup.scrollHeight, 320) || below >= above;
    popup.style.maxHeight = `${Math.max(0, Math.min(320, downward ? below : above))}px`;
    const box = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(left + margin, Math.min(anchor.left, left + width - box.width - margin))}px`;
    popup.style.top = `${Math.max(top + margin, downward ? anchor.bottom + 4 : anchor.top - box.height - 4)}px`;
  }
  function highlight(entry, option) {
    entry.highlighted = option;
    for (const [source, row] of entry.rows) row.dataset.active = String(source === option);
    const row = entry.rows.get(option);
    attribute(entry.button, 'aria-activedescendant', row?.id);
    if (row) {
      if (row.offsetTop < entry.popup.scrollTop) entry.popup.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > entry.popup.scrollTop + entry.popup.clientHeight)
        entry.popup.scrollTop = row.offsetTop + row.offsetHeight - entry.popup.clientHeight;
    }
  }
  function renderOptions(entry) {
    const { popup, select } = entry;
    entry.rows.clear(); popup.replaceChildren();
    let group;
    for (const [index, option] of options(entry).entries()) {
      if (optionHidden(option)) continue;
      const parent = option.parentElement;
      if (parent.tagName === 'OPTGROUP' && parent !== group) {
        popup.append(make('div', 'app-select-group', parent.label)); group = parent;
      }
      const row = make('div', 'app-select-option', option.label);
      row.id = `${popup.id}-option-${index}`; row.dataset.index = String(index);
      attribute(row, 'role', 'option'); attribute(row, 'aria-selected', String(option.selected));
      attribute(row, 'aria-disabled', String(optionDisabled(option)));
      entry.rows.set(option, row); popup.append(row);
    }
    const candidates = choices(entry);
    const selected = select.options[select.selectedIndex];
    position();
    highlight(entry, candidates.includes(entry.highlighted) ? entry.highlighted : candidates.includes(selected) ? selected : candidates[0]);
  }
  function nameFor(entry) {
    const { select, button } = entry;
    const explicit = select.getAttribute('aria-label');
    if (explicit) return explicit;
    const labelText = node => node === select || node === button || node === entry.error ? ''
      : node.nodeType === 3 ? node.textContent : [...node.childNodes].map(labelText).join(' ');
    return [...(select.labels ?? [])].map(labelText).join(' ').replace(/\s+/g, ' ').trim() || 'Choose an option';
  }
  function sync(entry) {
    const { select, button, value, error } = entry;
    const selected = select.options[select.selectedIndex], text = selected?.label || 'Choose an option';
    if (value.textContent !== text) value.textContent = text;
    const isDisabled = disabled(entry);
    if (button.disabled !== isDisabled) button.disabled = isDisabled;
    if (button.hidden !== select.hidden) button.hidden = select.hidden;
    const labelledBy = select.getAttribute('aria-labelledby');
    attribute(button, 'aria-labelledby', labelledBy ? `${labelledBy} ${value.id}` : null);
    attribute(button, 'aria-label', labelledBy ? null : `${nameFor(entry)}: ${text}`);
    attribute(button, 'title', select.getAttribute('title'));
    attribute(button, 'aria-required', select.required ? 'true' : null);
    const invalid = entry.invalid && !select.validity.valid;
    attribute(button, 'aria-invalid', invalid || select.getAttribute('aria-invalid') === 'true' ? 'true' : null);
    if (error.hidden !== !invalid) error.hidden = !invalid;
    if (invalid && error.textContent !== select.validationMessage) error.textContent = select.validationMessage;
    attribute(button, 'aria-describedby', [select.getAttribute('aria-describedby'), invalid ? error.id : null].filter(Boolean).join(' '));
    if (active === entry) {
      if (!available(entry) || !button.getClientRects().length) dismiss();
      else {
        const signature = JSON.stringify(options(entry).map(option => [option.label, option.value, option.selected, optionDisabled(option), optionHidden(option), option.parentElement?.label]));
        if (entry.signature !== signature) { entry.signature = signature; renderOptions(entry); }
        position();
      }
    }
  }
  function show(entry) {
    sync(entry);
    if (!available(entry)) return;
    dismiss(); active = entry;
    const owner = entry.select.closest('dialog[open]') || document.fullscreenElement || document.body;
    if (entry.popup.parentElement !== owner) owner.append(entry.popup);
    entry.popup.hidden = false;
    entry.popup.showPopover?.();
    attribute(entry.button, 'aria-expanded', 'true');
    entry.highlighted = entry.select.options[entry.select.selectedIndex];
    renderOptions(entry); position(); entry.button.focus({ preventScroll: true });
  }
  function commit(entry, option, pointer = false) {
    if (!available(entry) || !options(entry).includes(option) || optionDisabled(option) || optionHidden(option)) return;
    const changed = !option.selected;
    // Existing setting editors use the input method to decide whether to move
    // focus to their value field after a choice. Forward that before change.
    entry.select.dispatchEvent(new window.Event(pointer ? 'pointerdown' : 'keydown', { bubbles: true }));
    entry.select.selectedIndex = options(entry).indexOf(option);
    dismiss(); entry.button.focus({ preventScroll: true });
    if (changed) {
      entry.select.dispatchEvent(new window.Event('input', { bubbles: true }));
      entry.select.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    sync(entry);
  }
  function keydown(entry, event) {
    if (event.ctrlKey || event.metaKey || !available(entry)) return;
    const open = active === entry;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key === 'Tab') { dismiss(); return; }
    if (event.key === 'Enter' || event.key === ' ' && (!entry.search || Date.now() - entry.searchAt >= 700)) {
      event.preventDefault();
      if (open) commit(entry, entry.highlighted); else show(entry);
      return;
    }
    if (event.altKey && event.key === 'ArrowUp' && open) { event.preventDefault(); dismiss(); return; }
    const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (navigation.includes(event.key)) {
      event.preventDefault(); if (!open) show(entry);
      const candidates = choices(entry), index = candidates.indexOf(entry.highlighted);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? candidates.length - 1
        : !open ? Math.max(0, index) : Math.max(0, Math.min(candidates.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      highlight(entry, candidates[target]); return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault(); if (!open) show(entry);
      const now = Date.now(); entry.search = now - entry.searchAt < 700 ? entry.search + event.key.toLowerCase() : event.key.toLowerCase(); entry.searchAt = now;
      const candidates = choices(entry), start = candidates.indexOf(entry.highlighted);
      const repeated = [...entry.search].every(char => char === entry.search[0]);
      const query = repeated ? entry.search[0] : entry.search;
      const ordered = repeated ? [...candidates.slice(start + 1), ...candidates.slice(0, start + 1)] : candidates;
      const match = ordered.find(option => option.label.trim().toLowerCase().startsWith(query));
      if (match) highlight(entry, match);
    }
  }
  function enhance(select) {
    if (entries.has(select) || select.multiple) return;
    const id = `app-select-${++nextPickerId}`;
    const button = make('button', 'app-select-trigger'), value = make('span', 'app-select-value');
    button.type = 'button'; button.id = `${id}-trigger`; value.id = `${id}-value`;
    const arrow = make('span', 'app-select-arrow', '⌄'); arrow.setAttribute('aria-hidden', 'true'); button.append(value, arrow);
    const popup = make('div', 'app-select-popup'); popup.id = `${id}-list`; popup.hidden = true;
    attribute(button, 'role', 'combobox'); attribute(button, 'aria-haspopup', 'listbox'); attribute(button, 'aria-expanded', 'false'); attribute(button, 'aria-controls', popup.id);
    attribute(popup, 'role', 'listbox'); attribute(popup, 'aria-labelledby', button.id);
    if (typeof popup.showPopover === 'function') popup.setAttribute('popover', 'manual');
    const error = make('span', 'app-select-error'); error.id = `${id}-error`; error.hidden = true; error.setAttribute('role', 'alert');
    const entry = { select, button, value, popup, error, rows: new Map(), removers: [], search: '', searchAt: 0,
      attributes: { tabindex: select.getAttribute('tabindex'), 'aria-hidden': select.getAttribute('aria-hidden') } };
    entries.set(select, entry); select.after(button, error); select.classList.add('app-select-source');
    select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    // Programmatic assignments do not emit DOM mutations or change events.
    // Observe only these instances, leaving the browser prototypes untouched.
    for (const name of ['value', 'selectedIndex', 'disabled', 'hidden']) {
      const own = Object.getOwnPropertyDescriptor(select, name), descriptor = property(select, name);
      if (!descriptor?.get || !descriptor?.set || own?.configurable === false) continue;
      Object.defineProperty(select, name, { configurable: true, get() { return descriptor.get.call(this); },
        set(next) { descriptor.set.call(this, next); sync(entry); } });
      entry.removers.push(() => { if (own) Object.defineProperty(select, name, own); else delete select[name]; });
    }
    for (const name of ['focus', 'blur']) {
      const own = Object.getOwnPropertyDescriptor(select, name);
      Object.defineProperty(select, name, { configurable: true, value: (...args) => { sync(entry); button[name](...args); } });
      entry.removers.push(() => { if (own) Object.defineProperty(select, name, own); else delete select[name]; });
    }
    listen(button, 'click', () => { if (active === entry) dismiss(); else show(entry); }, false, entry.removers);
    listen(button, 'keydown', event => keydown(entry, event), false, entry.removers);
    listen(popup, 'pointerdown', event => event.preventDefault(), false, entry.removers);
    listen(popup, 'click', event => {
      const row = event.target.closest('[data-index]');
      if (row && popup.contains(row)) commit(entry, select.options[Number(row.dataset.index)], true);
    }, false, entry.removers);
    listen(select, 'click', event => { event.preventDefault(); show(entry); }, false, entry.removers);
    listen(select, 'invalid', event => {
      event.preventDefault(); entry.invalid = true; sync(entry);
      if (!invalidFocus) { invalidFocus = true; button.focus(); window.queueMicrotask(() => { invalidFocus = false; }); }
    }, false, entry.removers);
    sync(entry);
  }
  function remove(entry) {
    if (active === entry) dismiss();
    for (const remove of entry.removers) remove();
    entry.button.remove(); entry.popup.remove(); entry.error.remove();
    entry.select.classList.remove('app-select-source');
    for (const [name, value] of Object.entries(entry.attributes)) attribute(entry.select, name, value);
    entries.delete(entry.select);
  }
  function refresh() {
    if (disposed) return;
    for (const entry of entries.values()) if (!entry.select.isConnected) remove(entry);
    for (const select of document.querySelectorAll('select')) enhance(select);
    for (const entry of entries.values()) sync(entry);
  }
  const outside = event => {
    if (active && event.target !== active.button && !active.button.contains(event.target) && !active.popup.contains(event.target)) dismiss();
  };
  listen(document, 'pointerdown', outside, true);
  listen(document, 'focusin', outside);
  listen(document, 'change', event => { const entry = entries.get(event.target); if (entry) sync(entry); });
  listen(document, 'input', event => { const entry = entries.get(event.target); if (entry) sync(entry); });
  listen(document, 'reset', () => window.queueMicrotask(refresh));
  listen(document, 'scroll', position, true); listen(window, 'resize', position);
  if (window.visualViewport) { listen(window.visualViewport, 'resize', position); listen(window.visualViewport, 'scroll', position); }
  listen(document, 'fullscreenchange', dismiss);
  listen(document, 'close', event => { if (active && event.target.contains(active.select)) dismiss(); }, true);
  const observer = new window.MutationObserver(records => {
    if (records.some(record => record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('select, option, optgroup') || node.querySelector('select')))
      || record.target.closest?.('select') || record.type === 'attributes' && ['hidden', 'inert', 'open', 'disabled'].includes(record.attributeName))) refresh();
  });
  refresh();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'inert', 'open', 'selected', 'label', 'value', 'required', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-invalid', 'title'] });
  return { refresh, dismiss, close() {
    disposed = true; observer.disconnect(); dismiss();
    for (const removeListener of listeners) removeListener();
    for (const entry of entries.values()) remove(entry);
  } };
}
