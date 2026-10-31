import { withReadDeadline } from './network.js';

const PAGE_SIZE = 40;
const MAX_ROWS = 200;
const AREAS = { home: 'Home', charging: 'Charging', garage: 'Garage', caravan: 'Caravan', system: 'System' };
const shortTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const preciseTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset' });
const validTime = value => Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const order = (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
export const eventLogTime = (at, full = false) => validTime(at) ? (full ? preciseTime : shortTime).format(at) : 'Time unavailable';

function checkedPage(value) {
  if (!value || typeof value.context !== 'string' || !value.context || !validTime(value.checkedAt)
    || !['live', 'snapshot'].includes(value.scope) || value.snapshotAt !== null && !validTime(value.snapshotAt)
    || !Array.isArray(value.events) || value.events.length > MAX_ROWS
    || !Array.isArray(value.retainedIds) || value.retainedIds.length > MAX_ROWS
    || value.retainedIds.some(id => typeof id !== 'string')
    || value.nextBefore !== null && typeof value.nextBefore !== 'string' || typeof value.coverage !== 'string')
    throw new TypeError('Invalid event history response');
  const ids = new Set();
  for (const event of value.events) {
    if (!event || typeof event.id !== 'string' || !event.id || ids.has(event.id) || !validTime(event.at)
      || !Object.hasOwn(AREAS, event.area) || !['info', 'warning', 'error'].includes(event.severity)
      || ['title', 'summary', 'evidence'].some(field => typeof event[field] !== 'string')
      || !Array.isArray(event.details) || event.details.length > 60
      || event.details.some(field => !field || typeof field.label !== 'string' || typeof field.value !== 'string')
      || event.related && (event.related.kind !== 'charging-report' || !['charger1', 'charger2'].includes(event.related.chargerId)
        || typeof event.related.reportId !== 'string' || !event.related.reportId))
      throw new TypeError('Invalid event history entry');
    ids.add(event.id);
  }
  return { ...value, events: [...value.events].sort(order) };
}

/** A bounded, read-only presentation of the current selected history. Refreshes
 * reconcile visible IDs at the server's read boundary, including entries that
 * have moved beyond the newest page. They never establish device authority. */
export function createEventLog({ document, request, onOpenReport = () => {},
  IntersectionObserverClass = document.defaultView?.IntersectionObserver }) {
  const $ = id => document.getElementById(id);
  const list = $('events'), status = $('event-log-status'), message = $('event-log-message');
  const view = $('event-log-view'), area = $('event-log-area');
  const refreshButton = $('event-log-refresh'), olderButton = $('event-log-older'), newerButton = $('event-log-new');
  const coverage = $('event-log-coverage'), range = $('event-log-range');
  const nodes = new Map();
  let epoch = 0, pending = null, cancellation = null, closed = false, pendingManual = false;
  let context = null, rows = [], nextBefore = null, hasNewEvents = false, hasSuccessfulCheck = false;
  let browsingHistory = false, failed = false, historyNotice = false;
  const window = document.defaultView;
  let enabled = false, inView = !IntersectionObserverClass, focused = document.hasFocus?.() ?? true;
  const readable = (manual = false) => enabled && (manual || inView && focused) && !document.hidden && !closed;

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
  function invalidate() {
    epoch++;
    cancellation?.abort(); cancellation = null; pending = null; pendingManual = false;
  }
  function controls() {
    // Refresh can replace a stalled read after browser suspension.
    refreshButton.disabled = false;
    olderButton.disabled = Boolean(pending);
    olderButton.hidden = !nextBefore;
    newerButton.disabled = Boolean(pending);
    newerButton.hidden = !hasNewEvents && !browsingHistory;
    newerButton.textContent = hasNewEvents && !browsingHistory ? 'New events · Show latest' : 'Back to latest events';
    list.setAttribute('aria-busy', pending ? 'true' : 'false');
    range.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? 'event' : 'events'} · newest first${browsingHistory ? ' · browsing history' : ''}` : '';
  }
  function showMessage(text, error = false) {
    message.textContent = text; message.hidden = !text;
    message.dataset.state = error ? 'error' : 'neutral';
  }
  function showStatus(page) {
    const checked = `Checked ${eventLogTime(page.checkedAt)}`;
    const snapshot = page.scope === 'snapshot' ? page.snapshotAt === null ? 'Recorded history' : `Snapshot ${eventLogTime(page.snapshotAt)}` : 'Recorded events';
    status.textContent = `${snapshot} · ${checked}`;
    status.title = `${page.scope === 'snapshot' && page.snapshotAt !== null ? `Snapshot: ${eventLogTime(page.snapshotAt, true)}. ` : ''}Last successful event check: ${eventLogTime(page.checkedAt, true)}.`;
  }
  function entry(event) {
    let parts = nodes.get(event.id);
    if (!parts) {
      const node = make('li', 'event-log-entry'); node.dataset.eventId = event.id;
      const disclosure = make('details', 'event-log-details'), summary = make('summary', 'event-log-summary');
      const meta = make('span', 'event-log-meta'), timestamp = make('time'), areaLabel = make('span', 'event-log-area');
      const severity = make('span', 'event-log-severity'), title = make('span', 'event-log-title');
      const description = make('span', 'event-log-description'), evidence = make('span', 'event-log-evidence');
      meta.append(areaLabel, timestamp, severity); summary.append(meta, title, description, evidence);
      const body = make('div', 'event-log-body'), facts = make('dl', 'event-log-facts');
      const report = make('button', 'secondary-button event-log-report', 'Open charging session report');
      report.type = 'button'; report.setAttribute('aria-haspopup', 'dialog');
      report.addEventListener('click', () => {
        const related = parts.event.related;
        if (related) onOpenReport(related.chargerId, related.reportId);
      });
      body.append(facts, report); disclosure.append(summary, body); node.append(disclosure);
      parts = { node, disclosure, timestamp, areaLabel, severity, title, description, evidence, facts, report, detailKey: null };
      nodes.set(event.id, parts);
    }
    parts.event = event;
    parts.node.dataset.severity = event.severity;
    setText(parts.areaLabel, AREAS[event.area]);
    setText(parts.timestamp, eventLogTime(event.at));
    parts.timestamp.dateTime = new Date(event.at).toISOString();
    parts.timestamp.title = eventLogTime(event.at, true);
    parts.severity.hidden = event.severity === 'info';
    setText(parts.severity, event.severity === 'error' ? 'Error' : event.severity === 'warning' ? 'Warning' : '');
    setText(parts.title, event.title); setText(parts.description, event.summary); setText(parts.evidence, event.evidence);
    parts.description.hidden = !event.summary; parts.evidence.hidden = !event.evidence;
    const details = [{ label: 'Event time', value: `${eventLogTime(event.at, true)} · ${new Date(event.at).toISOString()}` }, ...event.details];
    const key = JSON.stringify(details);
    if (key !== parts.detailKey) {
      parts.detailKey = key;
      parts.facts.replaceChildren();
      for (const field of details) parts.facts.append(make('dt', '', field.label), make('dd', '', field.value));
    }
    parts.report.hidden = !event.related;
    return parts.node;
  }
  function anchor() {
    if (!rows.length) return null;
    const top = list.getBoundingClientRect().top;
    for (const row of rows) {
      const node = nodes.get(row.id)?.node, rect = node?.getBoundingClientRect();
      if (rect && rect.bottom > top) return { id: row.id, offset: rect.top - top, scrollTop: list.scrollTop };
    }
    return null;
  }
  function paint(next, { preserve = true } = {}) {
    const saved = preserve ? anchor() : null;
    const keep = new Set(next.map(event => event.id));
    const focused = document.activeElement;
    const losingFocus = list.contains(focused) && [...nodes].some(([id, parts]) => !keep.has(id) && parts.node.contains(focused));
    for (const [id, parts] of nodes) if (!keep.has(id)) { parts.node.remove(); nodes.delete(id); }
    next.forEach((event, index) => {
      const node = entry(event);
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    });
    rows = next;
    if (!preserve) list.scrollTop = 0;
    else if (saved) {
      const node = nodes.get(saved.id)?.node;
      if (node) list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset;
      else list.scrollTop = Math.min(saved.scrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
    }
    if (losingFocus) list.focus({ preventScroll: true });
  }
  function clearRows() {
    rows = []; nodes.clear(); list.replaceChildren(); list.scrollTop = 0;
    nextBefore = null; hasNewEvents = false; browsingHistory = false;
  }
  function reading() {
    return browsingHistory || list.scrollTop > 16 || list.contains(document.activeElement)
      || [...nodes.values()].some(parts => parts.disclosure.open);
  }
  function url(kind) {
    const params = new URLSearchParams({ view: view.value, area: area.value, limit: String(kind === 'older' || kind === 'latest' ? PAGE_SIZE : Math.max(PAGE_SIZE, rows.length)) });
    if (kind === 'older') params.set('before', nextBefore);
    if (rows.length) params.set('visible', rows.map(event => event.id).join(','));
    return `/api/events?${params}`;
  }
  function accept(page, kind) {
    const changed = context !== null && page.context !== context;
    if (changed) {
      const hadFocus = list.contains(document.activeElement);
      clearRows();
      if (hadFocus) list.focus({ preventScroll: true });
    }
    context = page.context;
    const existing = new Set(rows.map(event => event.id));
    const retained = new Set(page.retainedIds);
    const updated = new Map(page.events.map(event => [event.id, event]));
    const survivors = rows.filter(event => retained.has(event.id)).map(event => updated.get(event.id) ?? event);
    const newHead = rows.length && page.events.some(event => !existing.has(event.id) && order(event, rows[0]) < 0);
    if (kind === 'older' && !changed) {
      const combined = new Map([...survivors, ...page.events].map(event => [event.id, event]));
      paint([...combined.values()].sort(order).slice(-MAX_ROWS));
      nextBefore = page.nextBefore; browsingHistory = true;
    } else if (!changed && survivors.length && kind !== 'latest' && reading() && (newHead || browsingHistory || hasNewEvents)) {
      paint(survivors);
      hasNewEvents = Boolean(newHead || hasNewEvents);
    } else {
      paint(page.events, { preserve: !changed && survivors.length > 0 && kind !== 'latest' });
      nextBefore = page.nextBefore; hasNewEvents = false; browsingHistory = false;
    }
    hasSuccessfulCheck = true; failed = false; showStatus(page); coverage.textContent = page.coverage;
    if (!rows.length) showMessage(view.value === 'important'
      ? 'No important events in this view. All events includes routine controller activity.'
      : 'No recorded events in this view.');
    else showMessage(changed || historyNotice ? 'The selected history changed. Showing its current events.' : '');
    historyNotice = false;
    controls();
  }
  async function load(kind = 'refresh', { manual = false } = {}) {
    if (!readable(manual)) return;
    if (pending) {
      if (!manual || kind !== 'refresh') return pending;
      invalidate();
    }
    if (kind === 'older' && !nextBefore) return;
    const captured = epoch, controller = cancellation = new AbortController();
    const path = url(kind);
    if (!hasSuccessfulCheck) showMessage('Loading recorded events…');
    failed = false;
    const operation = withReadDeadline(async signal => {
      try { return await request(path, { signal }); }
      catch (error) {
        // A suspended browser may discard its connection. Retry that read once
        // inside the same deadline; malformed responses and access failures
        // still follow their ordinary failure path.
        if (signal.aborted || captured !== epoch || !readable(manual)
          || !(error instanceof TypeError || [502, 503, 504].includes(error?.status))) throw error;
        return request(path, { signal });
      }
    }, { signal: controller.signal }).then(value => {
      if (closed || captured !== epoch || !readable(manual)) return;
      accept(checkedPage(value), kind);
    }).catch(error => {
      if (closed || captured !== epoch || !readable(manual)) return;
      if (kind === 'older' && error?.code === 'event_log_context_changed') {
        invalidate(); clearRows(); context = null; hasSuccessfulCheck = false; historyNotice = true;
        showMessage('The selected history changed. Loading its current events…');
        return load('latest', { manual });
      }
      failed = true;
      showMessage(rows.length ? 'Event history could not be refreshed. Showing the last successfully fetched events. Try Refresh again.'
        : 'Event history is unavailable. Try Refresh again.', true);
      if (!hasSuccessfulCheck) status.textContent = 'No successful event check yet';
    }).finally(() => {
      if (pending === operation) { pending = null; cancellation = null; pendingManual = false; controls(); }
    });
    pending = operation; pendingManual = manual; controls(); return operation;
  }
  function changeFilter() {
    invalidate(); clearRows(); context = null; hasSuccessfulCheck = false; failed = false; historyNotice = false;
    status.textContent = 'Loading this view…'; coverage.textContent = '';
    void load('refresh', { manual: true });
  }
  function visibilityChanged() {
    if (!readable()) { invalidate(); controls(); return; }
    void load();
  }
  function suspended() {
    focused = false; invalidate(); controls();
  }
  function resumed() {
    focused = true;
    if (!readable(true)) return;
    // Focus/pageshow can arrive before viewport notifications in suspended
    // mobile windows. Replace the old transport rather than joining it.
    invalidate();
    void load('refresh', { manual: true });
  }
  function documentVisibilityChanged() {
    if (document.hidden) { invalidate(); controls(); }
    else resumed();
  }
  window?.addEventListener('blur', suspended);
  window?.addEventListener('focus', resumed);
  window?.addEventListener('pagehide', suspended);
  window?.addEventListener('pageshow', resumed);
  const observer = IntersectionObserverClass ? new IntersectionObserverClass(entries => {
    const entry = entries.find(value => value.target === $('event-log-panel'));
    if (!entry || inView === entry.isIntersecting) return;
    inView = entry.isIntersecting;
    // A delayed offscreen notification must not cancel an explicit read.
    if (!inView && pendingManual) return;
    visibilityChanged();
  }) : null;
  observer?.observe($('event-log-panel'));
  document.addEventListener?.('visibilitychange', documentVisibilityChanged);
  view.addEventListener('change', changeFilter); area.addEventListener('change', changeFilter);
  // Explicit actions need not wait for a viewport observer to catch up after
  // backgrounding. Hidden documents and unavailable history remain fenced.
  refreshButton.addEventListener('click', () => { void load('refresh', { manual: true }); });
  olderButton.addEventListener('click', () => { void load('older', { manual: true }); });
  newerButton.addEventListener('click', () => {
    // Recheck the head when it is opened: a report may have expired or been
    // deleted since the new-events notice first appeared.
    if (!pending) {
      const captured = epoch;
      void load('latest', { manual: true }).then(() => {
        if (!closed && captured === epoch && !failed) list.focus({ preventScroll: true });
      });
    }
  });
  controls();
  return {
    refresh() { enabled = true; return load(); },
    clear() {
      enabled = false; invalidate(); clearRows(); context = null; hasSuccessfulCheck = false; failed = false; historyNotice = false;
      status.textContent = 'No event history loaded'; status.title = ''; coverage.textContent = '';
      showMessage(''); controls();
    },
    unavailable(text = 'Waiting for a verified history snapshot.') {
      enabled = false; invalidate(); failed = true;
      showMessage(rows.length ? `${text} Showing previously fetched events.` : text, true); controls();
    },
    close() {
      closed = true; invalidate(); observer?.disconnect();
      document.removeEventListener?.('visibilitychange', documentVisibilityChanged);
      window?.removeEventListener('blur', suspended);
      window?.removeEventListener('focus', resumed);
      window?.removeEventListener('pagehide', suspended);
      window?.removeEventListener('pageshow', resumed);
    },
  };
}
