import { timingDisplay } from './timing-model.js';

let nextPopoverId = 0;

/** A small, touch-friendly explanation surface owned by the chart lifecycle. */
export function createTimingBenefit(root) {
  if (!root) return { render() {}, close() {} };
  const document = root.ownerDocument, window = document.defaultView;
  const popover = document.createElement('div');
  popover.className = 'timing-popover'; popover.id = `timing-popover-${++nextPopoverId}`;
  popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-modal', 'false'); popover.hidden = true;
  document.body.append(popover);
  let active = null, pinned = false, timer, lastFingerprint, lastRange, closed = false, suppressFocus = null;
  const listeners = [];
  const details = new Map();
  function listen(node, event, handler, options) { node.addEventListener(event, handler, options); listeners.push(() => node.removeEventListener(event, handler, options)); }
  function cancelClose() { window.clearTimeout(timer); }
  function hide(restoreFocus = false) {
    cancelClose();
    const previous = active;
    if (active) { active.setAttribute('aria-expanded', 'false'); active.removeAttribute('aria-describedby'); }
    active = null; pinned = false; popover.hidden = true;
    if (restoreFocus && previous) { suppressFocus = previous; previous.focus({ preventScroll: true }); suppressFocus = null; }
  }
  function place() {
    if (!active || popover.hidden) return;
    const view = window.visualViewport;
    const width = view?.width ?? window.innerWidth, height = view?.height ?? window.innerHeight;
    const x = view?.offsetLeft ?? 0, y = view?.offsetTop ?? 0, margin = 12;
    popover.style.maxHeight = `${Math.max(80, height - margin * 2)}px`;
    popover.style.width = `${Math.min(380, width - margin * 2)}px`;
    const anchor = active.getBoundingClientRect(), box = popover.getBoundingClientRect();
    const left = Math.max(x + margin, Math.min(anchor.left + anchor.width / 2 - box.width / 2, x + width - box.width - margin));
    const above = anchor.top - box.height - 9;
    const top = above >= y + margin ? above : Math.min(anchor.bottom + 9, y + height - box.height - margin);
    popover.style.left = `${left}px`; popover.style.top = `${Math.max(y + margin, top)}px`;
  }
  function paragraph(text) { const p = document.createElement('p'); p.textContent = text; return p; }
  function show(button) {
    if (closed) return;
    cancelClose();
    if (active === button) return;
    hide(); active = button;
    const detail = details.get(button);
    if (!detail) return hide();
    const title = document.createElement('strong'); title.className = 'timing-popover-title'; title.textContent = detail.title;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'timing-popover-close'; close.setAttribute('aria-label', 'Close explanation'); close.textContent = '×';
    const header = document.createElement('div'); header.className = 'timing-popover-header'; header.append(title, close);
    const content = document.createElement('div'); content.className = 'timing-popover-content'; content.tabIndex = 0; content.setAttribute('aria-label', detail.title);
    if (detail.sources?.length) content.append(paragraph('Share of included time · based on the historical power values used in this calculation.'));
    for (const source of detail.sources ?? []) {
      const row = document.createElement('div'); row.className = 'timing-source'; row.dataset.source = source.key;
      const label = document.createElement('strong'); label.textContent = source.label;
      const share = document.createElement('span'); share.className = 'timing-source-share'; share.textContent = `${source.percentage} of included time`;
      const heading = document.createElement('div'); heading.className = 'timing-source-heading'; heading.append(label, share);
      row.append(heading, paragraph(source.explanation));
      if (source.dates) { const dates = paragraph(source.dates); dates.className = 'timing-source-dates'; row.append(dates); }
      content.append(row);
    }
    for (const text of detail.paragraphs) content.append(paragraph(text));
    popover.replaceChildren(header, content); popover.setAttribute('aria-label', detail.title); popover.hidden = false; content.scrollTop = 0;
    active.setAttribute('aria-expanded', 'true'); active.setAttribute('aria-describedby', popover.id);
    place();
  }
  function delayedHide() {
    cancelClose();
    timer = window.setTimeout(() => {
      if (!pinned && document.activeElement !== active && !popover.contains(document.activeElement) && !popover.matches(':hover')) hide();
    }, 180);
  }
  function help(display, kind, label, className = '') {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `timing-help ${className}`.trim(); button.dataset.detail = kind;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', popover.id);
    button.setAttribute('aria-label', `${display.name}: ${label}. Show explanation`);
    button.textContent = label;
    const heading = { comparison: 'Timing difference', evidence: 'Energy basis', coverage: 'Time included', rates: 'Assumed contract rates' }[kind] ?? label;
    details.set(button, { title: `${display.name} · ${heading}`, paragraphs: display.details[kind], sources: kind === 'evidence' ? display.sources : [] });
    return button;
  }
  function trigger(event) { return event.target.closest?.('.timing-help'); }
  listen(root, 'pointerover', event => { if (event.pointerType !== 'touch') { const button = trigger(event); if (button && !button.contains(event.relatedTarget) && !pinned) show(button); } });
  listen(root, 'pointerout', event => { const button = trigger(event); if (button && !button.contains(event.relatedTarget)) delayedHide(); });
  listen(root, 'focusin', event => { const button = trigger(event); if (button && button !== suppressFocus) show(button); });
  listen(root, 'focusout', delayedHide);
  listen(root, 'click', event => {
    const button = trigger(event); if (!button) return;
    if (active === button && pinned) hide();
    else { show(button); pinned = true; if (event.detail === 0) popover.querySelector('.timing-popover-content').focus({ preventScroll: true }); }
  });
  listen(popover, 'click', event => { if (event.target.closest('.timing-popover-close')) hide(true); });
  listen(popover, 'focusout', delayedHide);
  listen(popover, 'pointerenter', cancelClose);
  listen(popover, 'pointerleave', delayedHide);
  listen(document, 'pointerdown', event => { if (active && !active.contains(event.target) && !popover.contains(event.target)) hide(); });
  listen(document, 'focusin', event => { if (active && !active.contains(event.target) && !popover.contains(event.target)) hide(); });
  listen(document, 'keydown', event => { if (event.key === 'Escape' && active) { event.preventDefault(); hide(popover.contains(document.activeElement)); } });
  listen(window, 'resize', place);
  listen(window, 'scroll', place, true);
  if (window.visualViewport) { listen(window.visualViewport, 'resize', place); listen(window.visualViewport, 'scroll', place); }
  return {
    render(payload) {
      if (closed) return;
      const displays = ['heatPump', 'charger'].map(key => timingDisplay(key, payload?.timingBenefit?.[key], payload));
      const chartAssumedRates = payload?.meta?.priceAssumptions?.used && !displays.some(display => display.assumedRates);
      const fingerprint = JSON.stringify({ displays, chartAssumedRates, range: payload?.range });
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      // A poll may change time shares while someone is reading. Keep the same
      // explanation open, but rebuild its contents from the new calculation.
      const range = JSON.stringify(payload?.range);
      const restore = active && range === lastRange ? { device: active.closest('[data-device]').dataset.device, kind: active.dataset.detail, pinned, focused: document.activeElement === active || popover.contains(document.activeElement), panelFocused: popover.contains(document.activeElement), scrollTop: popover.querySelector('.timing-popover-content')?.scrollTop ?? 0 } : null;
      lastRange = range;
      hide(); details.clear(); root.replaceChildren();
      for (const display of displays) {
        const card = document.createElement('article'); card.className = 'timing-device'; card.dataset.device = display.key;
        const name = document.createElement('h3'); name.className = 'timing-device-name'; name.textContent = display.name; card.append(name);
        if (display.available) {
          const main = help(display, 'comparison', `${display.amount} ${display.outcome}`, 'timing-result');
          const amount = document.createElement('span'); amount.className = 'timing-amount'; amount.textContent = display.amount;
          const outcome = document.createElement('span'); outcome.className = 'timing-outcome'; outcome.textContent = display.outcome;
          main.replaceChildren(amount, outcome); card.append(main);
          const meta = document.createElement('div'); meta.className = 'timing-meta';
          const basis = help(display, 'evidence', display.basis, 'timing-basis');
          basis.dataset.basis = display.sources.length > 1 ? 'mixed' : display.sources[0]?.key;
          const basisLabel = document.createElement('span'); basisLabel.className = 'timing-basis-label'; basisLabel.textContent = display.basis;
          basis.replaceChildren(basisLabel); meta.append(basis, help(display, 'coverage', display.coverageLabel));
          if (display.assumedRates) meta.append(help(display, 'rates', 'Assumed rates', 'timing-assumed'));
          if (display.periodLabel) meta.append(help(display, 'period', display.periodLabel));
          card.append(meta);
          const breakdown = help(display, 'evidence', `Of included time: ${display.sources.map(source => `${source.percentage} ${source.short}`).join(' · ')}`, 'timing-breakdown');
          const track = document.createElement('span'); track.className = 'timing-evidence-track'; track.setAttribute('aria-hidden', 'true');
          for (const source of display.sources) { const segment = document.createElement('span'); segment.dataset.source = source.key; segment.style.flexGrow = String(source.share); track.append(segment); }
          const caption = document.createElement('span'); caption.className = 'timing-evidence-caption'; caption.textContent = breakdown.textContent;
          breakdown.replaceChildren(track, caption); card.append(breakdown);
        } else {
          card.append(help(display, 'unavailable', 'Comparison unavailable', 'timing-unavailable'));
          const reason = paragraph(display.unavailableReason); reason.className = 'timing-unavailable-reason'; card.append(reason);
          const meta = document.createElement('div'); meta.className = 'timing-meta'; meta.append(help(display, 'coverage', display.coverageLabel));
          if (display.periodLabel) meta.append(help(display, 'period', display.periodLabel));
          card.append(meta);
        }
        root.append(card);
      }
      const note = paragraph('Same daily energy at each full day’s average all-in price. Positive = cheaper timing; negative = dearer. A comparison, not proven controller savings.');
      note.className = 'timing-explanation'; root.append(note);
      if (chartAssumedRates) {
        const display = timingDisplay('charger', {}, payload); display.name = 'Selected dates';
        display.details.rates.push('The price chart uses assumed rates in this selection. No device comparison shown here includes affected time; an unavailable comparison remains unavailable.');
        const context = document.createElement('span'); context.className = 'timing-chart-rates'; context.dataset.device = 'chart';
        context.append(help(display, 'rates', 'Chart uses assumed rates', 'timing-assumed')); note.append(context);
      }
      if (restore) {
        const replacement = root.querySelector(`[data-device="${restore.device}"] [data-detail="${restore.kind}"]`);
        if (replacement) {
          if (restore.focused) replacement.focus({ preventScroll: true });
          show(replacement); pinned = restore.pinned;
          const content = popover.querySelector('.timing-popover-content');
          content.scrollTop = restore.scrollTop;
          if (restore.panelFocused) content.focus({ preventScroll: true });
        }
      }
    },
    close() { closed = true; hide(); listeners.forEach(remove => remove()); details.clear(); popover.remove(); },
  };
}
