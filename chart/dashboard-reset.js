/** Collapse navigation without changing saved controls, forms or chart choices. */
export function createDashboardReset({ document, button }) {
  const reset = () => {
    for (const fold of document.querySelectorAll('details[open]')) fold.open = false;
    const comparison = document.getElementById('comparison-toggle');
    if (comparison?.getAttribute('aria-expanded') === 'true') comparison.click();
    document.defaultView?.scrollTo({ top: 0, behavior: 'auto' });
    button?.focus({ preventScroll: true });
  };
  button?.addEventListener('click', reset);
  return { close: () => button?.removeEventListener('click', reset) };
}
