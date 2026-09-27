import { EXPLORER_SERIES_BY_KEY, filterExplorerSeries } from './series-explorer.js';

/** A temporary picker leaves the selected chart in place while searching. */
export function createSeriesPicker({ getSelected, onSelect, onOpen = () => {} }) {
  const $ = id => document.getElementById(id);
  const dialog = $('chart-series-picker'), toggle = $('chart-series-toggle');
  const search = $('chart-series-search'), list = $('chart-series');
  const listeners = [];
  let matches = [], options = [], active = -1, closed = false, backdropPress = false;
  const listen = (node, event, handler) => {
    node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler));
  };
  function activate(index, scroll = false) {
    active = index;
    options.forEach((option, i) => { option.dataset.active = String(i === index); });
    if (options[index]) {
      search.setAttribute('aria-activedescendant', options[index].id);
      if (scroll) options[index].scrollIntoView({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }
  function render() {
    const filtered = filterExplorerSeries(search.value);
    matches = [...new Set(filtered.map(row => row.group))].flatMap(group => filtered.filter(row => row.group === group)); options = [];
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('p'); empty.className = 'chart-series-empty';
      empty.textContent = 'No matching series. Try a different name, unit or signal.'; list.append(empty);
    }
    let group;
    for (const row of matches) {
      if (group !== row.group) {
        group = row.group;
        const heading = document.createElement('div'); heading.className = 'chart-series-group';
        heading.setAttribute('role', 'presentation'); heading.textContent = group; list.append(heading);
      }
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.className = 'chart-series-option'; option.id = `chart-series-option-${row.key}`;
      option.dataset.seriesKey = row.key; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(row.key === getSelected()));
      const title = document.createElement('span'); title.className = 'chart-series-option-title';
      const name = document.createElement('span'); name.textContent = row.label;
      const unit = document.createElement('span'); unit.className = 'chart-series-unit'; unit.textContent = row.unit;
      title.append(name, unit);
      const detail = document.createElement('span'); detail.className = 'chart-series-option-detail';
      detail.textContent = row.description === row.basis ? row.basis : `${row.basis} · ${row.description}`;
      option.append(title, detail); list.append(option); options.push(option);
    }
    $('chart-series-count').textContent = `${matches.length} series${search.value.trim() ? matches.length === 1 ? ' matches your search' : ' match your search' : ' available to explore'}`;
    $('chart-series-clear').hidden = !search.value;
    activate(matches.length ? Math.max(0, matches.findIndex(row => row.key === getSelected())) : -1);
    if (dialog.open) { position(); options[active]?.scrollIntoView({ block: 'nearest' }); }
  }
  function position() {
    if (!dialog.open) return;
    // CSS supplies a bottom drawer on small screens, including fullscreen.
    if (window.innerWidth <= 640) { dialog.style.removeProperty('left'); dialog.style.removeProperty('top'); return; }
    const anchor = toggle.getBoundingClientRect(), bounds = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(16, Math.min(anchor.left, window.innerWidth - bounds.width - 16))}px`;
    dialog.style.top = `${Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 16))}px`;
  }
  function dismiss({ restoreFocus = true } = {}) {
    if (!dialog.open) return;
    dialog.close(); toggle.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !closed) toggle.focus({ preventScroll: true });
  }
  function update() {
    const row = EXPLORER_SERIES_BY_KEY[getSelected()];
    $('chart-series-selected').textContent = row ? `${row.label} · ${row.unit}` : 'Choose a series…';
    toggle.setAttribute('aria-label', row ? `Choose series. Selected: ${row.label}, ${row.unit}` : 'Choose a series');
  }
  function open() {
    if (closed || dialog.open) return;
    onOpen(); render(); dialog.showModal(); position();
    options[active]?.scrollIntoView({ block: 'nearest' });
    toggle.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true');
    search.focus({ preventScroll: true }); search.select();
  }
  function select(key) {
    if (!matches.some(row => row.key === key)) return;
    onSelect(key); update(); dismiss();
  }
  listen(toggle, 'click', open);
  listen($('chart-series-close'), 'click', () => dismiss());
  listen(dialog, 'cancel', event => { event.preventDefault(); dismiss(); });
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  listen(dialog, 'pointerdown', event => { backdropPress = event.target === dialog && outside(event); });
  listen(dialog, 'click', event => {
    if (backdropPress && event.target === dialog && outside(event)) dismiss();
    backdropPress = false;
  });
  listen(search, 'input', render);
  listen(search, 'keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      // Search inputs otherwise consume the first Escape by clearing the query.
      event.preventDefault(); event.stopPropagation(); dismiss();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) activate((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length, true);
    } else if (event.key === 'Enter') {
      event.preventDefault(); if (matches[active]) select(matches[active].key);
    }
  });
  listen(list, 'click', event => {
    const option = event.target.closest('[data-series-key]');
    if (option && list.contains(option)) select(option.dataset.seriesKey);
  });
  listen($('chart-series-clear'), 'click', () => { search.value = ''; render(); search.focus(); });
  listen(window, 'resize', position);
  listen(document, 'fullscreenchange', () => dismiss({ restoreFocus: false }));
  update();
  return { open, dismiss, update, close() { closed = true; dismiss({ restoreFocus: false }); listeners.forEach(remove => remove()); } };
}
