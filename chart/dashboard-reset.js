/** Collapse navigation without changing saved controls, forms or chart choices. */
export function createDashboardReset({ document, button }) {
  const view = document.defaultView;
  let closed = false;
  function clearClosedDestination(fold) {
    if (fold.tagName !== 'DETAILS' || fold.open || !view?.location?.hash) return;
    let id;
    try { id = decodeURIComponent(view.location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (!target || !fold.contains(target)) return;
    // A summary remains visible when its own fold closes.
    if (fold.querySelector(':scope > summary')?.contains(target)) return;
    // Keep the current entry, query and ingress path. A stale fragment would
    // otherwise reveal this fold again on reload, including through the browser.
    view.history.replaceState(view.history.state, '', view.location.pathname + view.location.search);
  }
  const onToggle = event => {
    const fold = event.target, hash = view?.location?.hash;
    if (fold.tagName !== 'DETAILS' || fold.open || !hash) return;
    // A queued toggle can precede a newer hashchange. Let that navigation open
    // its destination before deciding whether the fragment has become stale.
    view.setTimeout(() => {
      if (!closed && view.location.hash === hash) clearClosedDestination(fold);
    }, 0);
  };
  // Native details toggle events do not bubble; capture also covers new folds.
  document.addEventListener('toggle', onToggle, { capture: true });
  const reset = () => {
    for (const fold of document.querySelectorAll('details[open]')) {
      fold.open = false;
      clearClosedDestination(fold);
    }
    const comparison = document.getElementById('comparison-toggle');
    if (comparison?.getAttribute('aria-expanded') === 'true') comparison.click();
    document.defaultView?.scrollTo({ top: 0, behavior: 'auto' });
    button?.focus({ preventScroll: true });
  };
  button?.addEventListener('click', reset);
  return { close() {
    closed = true;
    button?.removeEventListener('click', reset);
    document.removeEventListener('toggle', onToggle, { capture: true });
  } };
}
