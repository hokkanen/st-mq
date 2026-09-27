import { EXPLORER_SERIES_BY_KEY, filterExplorerSeries } from './series-explorer.js';
import { CHART_VIEWS, CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';

const views = CHART_VIEWS.map(view => ({ ...view,
  searchText: [view.key, view.label, view.group, view.description, view.unit,
    ...[...view.leftSignals, ...view.rightSignals, ...view.tracks].map(key => EXPLORER_SERIES_BY_KEY[key]?.label ?? key)].join(' ').toLowerCase(),
}));

/** A temporary picker leaves the selected chart in place while searching. */
export function createSeriesPicker({ getSelected, onSelect, onOpen = () => {} }) {
  const $ = id => document.getElementById(id);
  const dialog = $('chart-series-picker'), toggle = $('chart-series-toggle');
  const search = $('chart-series-search'), list = $('chart-series');
  const listeners = [];
  const queries = { views: '', series: '' };
  let mode = 'views';
  let matches = [], options = [], active = -1, closed = false, backdropPress = false;
  const listen = (node, event, handler) => {
    node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler));
  };
  function selectedKey() {
    const selected = getSelected();
    return mode === 'views' ? selected.view === 'explorer' ? undefined : selected.view
      : selected.view === 'explorer' ? selected.series : undefined;
  }
  function activate(index, scroll = false) {
    active = index;
    options.forEach((option, i) => { option.dataset.active = String(i === index); });
    if (options[index]) {
      search.setAttribute('aria-activedescendant', options[index].id);
      if (scroll) options[index].scrollIntoView({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }
  function render() {
    queries[mode] = search.value;
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = mode === 'views' ? views.filter(row => terms.every(term => row.searchText.includes(term))) : filterExplorerSeries(search.value);
    matches = [...new Set(filtered.map(row => row.group))].flatMap(group => filtered.filter(row => row.group === group)); options = [];
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('p'); empty.className = 'chart-series-empty';
      empty.textContent = mode === 'views' ? 'No matching views. Try a different topic or browse All series.'
        : 'No matching series. Try a different name, unit or signal.'; list.append(empty);
    }
    let group;
    for (const row of matches) {
      if (group !== row.group) {
        group = row.group;
        const heading = document.createElement('div'); heading.className = 'chart-series-group';
        heading.setAttribute('role', 'presentation'); heading.textContent = group; list.append(heading);
      }
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.className = 'chart-series-option'; option.id = `chart-${mode}-option-${row.key}`;
      option.dataset[mode === 'views' ? 'viewKey' : 'seriesKey'] = row.key; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(row.key === selectedKey()));
      const title = document.createElement('span'); title.className = 'chart-series-option-title';
      const name = document.createElement('span'); name.textContent = row.label;
      const unit = document.createElement('span'); unit.className = 'chart-series-unit'; unit.textContent = row.unit;
      title.append(name, unit);
      const detail = document.createElement('span'); detail.className = 'chart-series-option-detail';
      detail.textContent = mode === 'views' ? row.description : row.description === row.basis ? row.basis : `${row.basis} · ${row.description}`;
      option.append(title, detail); list.append(option); options.push(option);
    }
    const noun = mode === 'views' ? matches.length === 1 ? 'view' : 'views' : 'series';
    $('chart-series-count').textContent = `${matches.length} ${noun}${search.value.trim() ? matches.length === 1 ? ' matches your search' : ' match your search' : ' available to explore'}`;
    $('chart-series-clear').hidden = !search.value;
    activate(matches.length ? Math.max(0, matches.findIndex(row => row.key === selectedKey())) : -1);
    if (dialog.open) options[active]?.scrollIntoView({ block: 'nearest' });
  }
  function setMode(next) {
    mode = next; search.value = queries[mode];
    for (const key of ['views', 'series']) $(`chart-series-mode-${key}`).setAttribute('aria-pressed', String(mode === key));
    $('chart-series-help').textContent = mode === 'views'
      ? 'Choose a ready-made view to compare related measurements and activity.'
      : 'Browse every supported measurement, state and calculation. Availability depends on what was recorded for the selected dates.';
    $('chart-series-search-label').textContent = mode === 'views' ? 'Find a view' : 'Find a series';
    search.placeholder = mode === 'views' ? 'Heating, weather, charging…' : 'Temperature, pump, energy…';
    list.setAttribute('aria-label', mode === 'views' ? 'Matching views' : 'Matching series');
    render();
  }
  function dismiss({ restoreFocus = true } = {}) {
    if (!dialog.open) return;
    dialog.close(); toggle.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !closed) toggle.focus({ preventScroll: true });
  }
  function update() {
    const selected = getSelected(), individual = selected.view === 'explorer';
    const row = individual ? EXPLORER_SERIES_BY_KEY[selected.series] : CHART_VIEW_BY_KEY[selected.view];
    const label = individual ? `${row.label} · ${row.unit}` : row.label;
    $('chart-series-toggle-label').textContent = individual ? 'Selected series' : 'Selected view';
    $('chart-series-selected').textContent = label;
    toggle.title = label;
    toggle.setAttribute('aria-label', `Explore chart. Selected ${individual ? 'series' : 'view'}: ${label}`);
  }
  function open() {
    if (closed || dialog.open) return;
    onOpen(); setMode(getSelected().view === 'explorer' ? 'series' : 'views'); dialog.showModal();
    options[active]?.scrollIntoView({ block: 'nearest' });
    toggle.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true');
    // Browsing must not summon the touch keyboard. Search takes focus only when
    // the user selects it; reopening retains the query without selecting text.
    $(`chart-series-mode-${mode}`).focus({ preventScroll: true });
  }
  function select(key) {
    if (!matches.some(row => row.key === key)) return;
    onSelect(mode === 'views' ? { view: key } : { view: 'explorer', series: key }); update(); dismiss();
  }
  listen(toggle, 'click', open);
  listen($('chart-series-close'), 'click', () => dismiss());
  for (const key of ['views', 'series']) listen($(`chart-series-mode-${key}`), 'click', () => {
    setMode(key); $(`chart-series-mode-${key}`).focus({ preventScroll: true });
  });
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
    const option = event.target.closest('[role="option"]');
    if (option && list.contains(option)) select(mode === 'views' ? option.dataset.viewKey : option.dataset.seriesKey);
  });
  listen($('chart-series-clear'), 'click', () => { search.value = ''; render(); search.focus(); });
  listen(document, 'fullscreenchange', () => dismiss({ restoreFocus: false }));
  update();
  return { open, dismiss, update, close() { closed = true; dismiss({ restoreFocus: false }); listeners.forEach(remove => remove()); } };
}
