/** One small, nonmodal explanation shared by all compact status labels. */
const documents = new WeakMap();

function createDetails(document) {
  const window = document.defaultView;
  const entries = new WeakMap();
  const panel = document.createElement('div');
  panel.id = 'status-detail-popover';
  panel.className = 'status-detail-popover';
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'status-detail-heading');
  panel.hidden = true;
  const header = document.createElement('div');
  header.className = 'status-detail-header';
  const heading = document.createElement('strong');
  heading.id = 'status-detail-heading';
  heading.className = 'status-detail-heading';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'status-detail-close';
  closeButton.setAttribute('aria-label', 'Close details');
  closeButton.textContent = '×';
  header.append(heading, closeButton);
  const body = document.createElement('div');
  body.className = 'status-detail-body';
  panel.append(header, body);
  document.body.append(panel);
  let active = null;
  let activeKey = null;
  let pageScroll = null;
  let native = typeof panel.showPopover === 'function';
  const pagePosition = () => [window?.scrollX ?? document.documentElement.scrollLeft ?? 0,
    window?.scrollY ?? document.documentElement.scrollTop ?? 0];

  function close(restoreFocus = false) {
    if (!active) return;
    const trigger = active;
    active = null;
    activeKey = null;
    pageScroll = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (native) {
      try { panel.hidePopover(); } catch { /* Already dismissed by the browser. */ }
    }
    panel.hidden = true;
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function position() {
    if (!active?.isConnected) return;
    const viewport = window?.visualViewport;
    const width = viewport?.width ?? window?.innerWidth ?? document.documentElement.clientWidth;
    const height = viewport?.height ?? window?.innerHeight ?? document.documentElement.clientHeight;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
    const topEdge = (viewport?.offsetTop ?? 0) + 12;
    const availableWidth = Math.max(0, width - 24);
    const availableHeight = Math.max(0, height - 24);
    Object.assign(panel.style, {
      position: 'fixed', inset: 'auto', margin: '0', boxSizing: 'border-box',
      width: `${Math.min(352, availableWidth)}px`, maxWidth: `${availableWidth}px`,
      maxHeight: `${Math.min(288, availableHeight)}px`, overflowY: 'auto',
    });
    const anchor = active.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const below = topEdge + availableHeight - anchor.bottom - 8;
    const above = anchor.top - topEdge - 8;
    const preferredTop = below >= bounds.height || below >= above
      ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
    panel.style.left = `${Math.max(leftEdge, Math.min(anchor.left, leftEdge + availableWidth - bounds.width))}px`;
    panel.style.top = `${Math.max(topEdge, Math.min(preferredTop, topEdge + availableHeight - bounds.height))}px`;
  }

  function refresh(trigger, entry) {
    const scrollTop = panel.scrollTop;
    const bodyScrollTop = body.scrollTop;
    if (active && active !== trigger) active.setAttribute('aria-expanded', 'false');
    active = trigger;
    activeKey = entry.key;
    active.setAttribute('aria-expanded', 'true');
    if (heading.textContent !== entry.title) heading.textContent = entry.title;
    if (body.textContent !== entry.detail) body.textContent = entry.detail;
    position();
    panel.scrollTop = scrollTop;
    body.scrollTop = bodyScrollTop;
    // A rerender may prepare the new trigger before attaching its row.
    if (!trigger.isConnected) window?.requestAnimationFrame?.(() => {
      if (active?.isConnected) position();
      else close();
    });
  }

  function open(trigger) {
    const entry = entries.get(trigger);
    if (!entry) return;
    if (active === trigger) { close(true); return; }
    panel.hidden = false;
    pageScroll = pagePosition();
    panel.scrollTop = 0;
    body.scrollTop = 0;
    if (native) {
      try { panel.showPopover(); }
      catch {
        native = false;
        panel.removeAttribute('popover');
      }
    }
    refresh(trigger, entry);
    closeButton.focus({ preventScroll: true });
  }

  closeButton.addEventListener('click', () => close(true));
  document.addEventListener('pointerdown', event => {
    if (active && !panel.contains(event.target) && !active.contains(event.target)) close();
  }, true);
  document.addEventListener('keydown', event => {
    if (active && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }, true);
  document.addEventListener('scroll', event => {
    if (!active || panel.contains(event.target)) return;
    // Firefox may notify document scrolling during a status rerender even when
    // scroll anchoring leaves the page at the same position. Keep its open help.
    if (event.target === document || event.target === document.documentElement) {
      const current = pagePosition();
      if (pageScroll?.every((value, index) => value === current[index])) return;
    }
    close();
  }, true);
  panel.addEventListener('toggle', event => {
    if (native && event.newState === 'closed' && !panel.matches(':popover-open')) close();
  });
  window?.addEventListener('resize', position);
  window?.visualViewport?.addEventListener('resize', position);
  window?.visualViewport?.addEventListener('scroll', position);

  return {
    close,
    update(root, options) {
      const entry = {
        label: String(options.label ?? ''), title: String(options.title || 'Status details'),
        detail: String(options.detail ?? '').trim(), key: options.key ?? root,
      };
      let trigger = root.querySelector('.status-detail-trigger');
      if (!entry.detail) {
        if (active && (active === trigger || activeKey === entry.key)) close();
        root.textContent = entry.label;
        return null;
      }
      if (!trigger) {
        trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'status-detail-trigger';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-controls', panel.id);
        trigger.setAttribute('aria-expanded', 'false');
        const label = document.createElement('span');
        label.className = 'status-detail-label';
        trigger.append(label);
        trigger.addEventListener('click', () => open(trigger));
        root.replaceChildren(trigger);
      }
      const label = trigger.querySelector('.status-detail-label');
      if (label.textContent !== entry.label) label.textContent = entry.label;
      trigger.setAttribute('aria-label', `${entry.title}: ${entry.label}. Show details`);
      entries.set(trigger, entry);
      if (active && (active === trigger || activeKey === entry.key)) refresh(trigger, entry);
      return trigger;
    },
  };
}

/** Keep routine status concise; show its explanation on click, tap or keyboard activation.
 * Stable keys preserve an open explanation when its surrounding row is rerendered.
 * Without an explanation, render a plain label and return null.
 */
export function setStatusDetail(root, options = {}) {
  if (!root) return null;
  const document = root.ownerDocument;
  let details = documents.get(document);
  if (!details) {
    details = createDetails(document);
    documents.set(document, details);
  }
  return details.update(root, options);
}

/** Dismiss installation details when the authenticated session ends. */
export function closeStatusDetails(document) {
  documents.get(document)?.close();
}
