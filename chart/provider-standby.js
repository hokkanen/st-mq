import { STANDBY_CHECK_MS, STANDBY_SOURCES, standbyCheckOverdue } from '../src/domain/provider-standby.js';
import { durationText } from './reading-status.js';
import { setStatusDetail } from './status-details.js';

const titles = { outdoor: 'Outdoor temperature', weather: 'Weather forecast', market: 'Published prices' };
const names = { openmeteo: 'Open-Meteo', elering: 'Elering' };
const date = value => Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
const clock = (value, now) => Number.isFinite(value) && value >= 0 && value <= now;

export function standbyCheckRows(providers, keys, { now, formatTime, recorded = false }) {
  return keys.flatMap(key => {
    const health = providers?.[key], check = health?.standby;
    if (!check || check.source !== STANDBY_SOURCES[key]) return [];
    const checked = clock(check.lastCheckedAt, now), age = checked ? now - check.lastCheckedAt : null;
    const inUse = health.source === check.source || key === 'weather' && ['openmeteo', 'mixed'].includes(health.acquisition?.solarSource);
    const overdue = standbyCheckOverdue(check, now);
    const attention = !recorded && (['error', 'partial'].includes(check.status) || !inUse && overdue);
    const recordedState = checked && ['ok', 'partial', 'error'].includes(check.status)
      ? ({ ok: 'Usable', partial: 'Partial coverage', error: 'Check failed' })[check.status] : null;
    const state = recorded ? `Recorded · ${recordedState ?? 'Not checked'}` : check.checking === true ? 'Checking'
      : !checked || !['ok', 'partial', 'error'].includes(check.status) ? 'Not checked yet' : check.status === 'error' ? 'Check failed'
        : check.status === 'partial' ? 'Partial coverage' : inUse ? 'In use' : overdue ? 'Check overdue' : 'Usable at last check';
    const evidence = checked ? `Checked ${formatTime(check.lastCheckedAt)} · ${durationText(age)} ago` : 'Checked hourly when not in use';
    const detail = [recorded ? 'Saved master diagnostics; this computer does not check live backup feeds.'
      : inUse ? 'This provider is selected for the current feed. Ordinary acquisition checks it while selected; the last completed check is shown below.'
        : 'This provider is on standby. Its data is checked hourly while the primary feed is working.',
    checked ? `Last completed check ${formatTime(check.lastCheckedAt)}. A past check does not establish availability now.` : 'No completed backup check is available.',
    check.status === 'error' ? /^HTTP-[1-5]\d{2}$/.test(check.error ?? '') ? `Last check failed (${check.error.replace('-', ' ')}).`
      : 'The last check could not obtain usable data.' : '',
    date(check.coverage?.knownUntil) ? `Last checked coverage extends to ${formatTime(check.coverage.knownUntil)}.${check.coverage.gaps ? ' Some forecast or price intervals are missing.' : ''}` : '',
    key === 'weather' && ['available', 'partial', 'unavailable'].includes(check.solarStatus) ? `Solar radiation at last check: ${check.solarStatus}.` : '',
    key === 'market' && check.coverage?.completeToday === false ? 'Last checked prices did not cover the rest of today.' : '',
    !recorded && date(check.nextAttemptAt) ? `Next standby check ${formatTime(check.nextAttemptAt)}; provider retry delays take precedence.` : '',
    ].filter(Boolean).join('\n\n');
    return [{ key, label: `${titles[key]} · ${names[check.source]}`, state, evidence, detail,
      attention, tone: attention ? 'attention' : 'pending', intervalMs: STANDBY_CHECK_MS }];
  });
}

/** Keep keyed nodes and status-detail triggers through normal dashboard polls. */
export function renderStandbyChecks(container, rows) {
  const document = container.ownerDocument;
  const remove = node => {
    const expanded = node.querySelector('.status-detail-trigger[aria-expanded="true"]');
    const focused = node.contains(document.activeElement)
      || expanded && document.getElementById('status-detail-popover')?.contains(document.activeElement);
    setStatusDetail(node.children[1], { key: `standby-${node.dataset.check}`, label: '', detail: '' });
    if (focused) container.closest('details')?.querySelector(':scope > summary')?.focus({ preventScroll: true });
    node.remove();
  };
  let list = container.querySelector('ul');
  if (list) for (const existing of [...list.children]) if (!rows.some(row => row.key === existing.dataset.check)) remove(existing);
  container.hidden = rows.length === 0;
  if (!rows.length) return;
  if (!list) {
    const title = document.createElement('h4'); title.className = 'provider-source-title'; title.textContent = 'Backup checks';
    list = document.createElement('ul'); list.className = 'provider-standby-list'; container.append(title, list);
  }
  for (const [index, row] of rows.entries()) {
    let item = [...list.children].find(node => node.dataset.check === row.key);
    if (!item) {
      item = document.createElement('li'); item.dataset.check = row.key;
      const label = document.createElement('span'); label.className = 'provider-standby-label';
      const state = document.createElement('span'); state.className = 'provider-standby-state';
      const evidence = document.createElement('small'); evidence.className = 'provider-standby-evidence';
      item.append(label, state, evidence);
    }
    if (list.children[index] !== item) {
      const focused = item.contains(document.activeElement) ? document.activeElement : null;
      list.insertBefore(item, list.children[index] ?? null); focused?.focus({ preventScroll: true });
    }
    item.dataset.state = row.tone;
    item.children[0].textContent = row.label;
    setStatusDetail(item.children[1], { key: `standby-${row.key}`, label: row.state, title: row.label, detail: row.detail });
    item.children[2].textContent = row.evidence;
  }
}
