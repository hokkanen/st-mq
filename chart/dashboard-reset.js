/** Collapse navigation without changing saved controls, forms or chart choices. */
export function createDashboardReset({ document, button }) {
  const reset = () => {
    for (const fold of document.querySelectorAll('details[open]')) fold.open = false;
    document.defaultView?.scrollTo({ top: 0, behavior: 'auto' });
    button?.focus({ preventScroll: true });
  };
  button?.addEventListener('click', reset);
  return { close: () => button?.removeEventListener('click', reset) };
}
