/** Balance desktop columns with bounded gaps between sections, never inside folds. */
export function createDashboardLayout(root) {
  const view = root?.ownerDocument.defaultView;
  if (!view?.ResizeObserver) return { close() {} };
  const columns = [...root.children].filter(node => node.classList.contains('controller-column'));
  const cards = columns.map(column => [...column.children].filter(node => node.classList.contains('panel')));
  const desktop = view.matchMedia('(min-width: 801px)');
  let frame = null;

  function reset() {
    apply(new Map(), false);
  }
  function apply(spacing, aligned) {
    for (const card of cards.flat()) {
      const value = spacing.get(card) || '';
      if (card.style.getPropertyValue('--dashboard-balance-space') === value) continue;
      if (value) card.style.setProperty('--dashboard-balance-space', value);
      else card.style.removeProperty('--dashboard-balance-space');
    }
    if (root.classList.contains('columns-aligned') !== aligned) root.classList.toggle('columns-aligned', aligned);
  }
  function align() {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    if (!desktop.matches || columns.length !== 2) return reset();
    const bounds = columns.map(column => column.getBoundingClientRect());
    if (bounds.some(bound => bound.width === 0)) return reset();
    // Subtract existing gaps instead of temporarily removing them. This keeps
    // measurements stable and avoids a reset/reapply loop on every resize.
    const measurements = cards.map(column => column.map(card => {
      const slots = Math.max(0, [...card.children].filter(node => node.getClientRects().length > 0).length - 1);
      const added = (parseFloat(card.style.getPropertyValue('--dashboard-balance-space')) || 0) * slots;
      const height = card.getBoundingClientRect().height - added;
      return { card, slots, added, growth: Math.min(slots * 12, height * .1) };
    }));
    const heights = bounds.map((bound, index) => bound.height - measurements[index].reduce((total, card) => total + card.added, 0));
    const shorter = heights[0] <= heights[1] ? 0 : 1;
    const difference = Math.abs(heights[0] - heights[1]);
    const budgets = measurements[shorter];
    const capacity = budgets.reduce((total, budget) => total + budget.growth, 0);
    if (!capacity || difference > capacity) return reset();
    const spacing = new Map();
    for (const { card, slots, growth } of budgets) {
      // Match browser layout precision so subpixel rounding cannot churn styles.
      const gap = slots ? Math.floor(difference * growth / capacity / slots * 64) / 64 : 0;
      if (gap) spacing.set(card, `${gap}px`);
    }
    apply(spacing, true);
  }
  function schedule() {
    if (frame === null) frame = view.requestAnimationFrame(align);
  }
  const observer = new view.ResizeObserver(schedule);
  observer.observe(root);
  // Watch sections, including their padding, so shrinking the shorter column is
  // detected even when the overall dashboard height stays unchanged.
  for (const content of root.querySelectorAll('.controller-column > .panel > *')) observer.observe(content, { box: 'border-box' });
  // A disclosure must open with its final spacing on the first painted frame.
  // ResizeObserver alone would defer adjustment to the following animation frame.
  const folds = new view.MutationObserver(align);
  folds.observe(root, { subtree: true, attributes: true, attributeFilter: ['open'] });
  desktop.addEventListener('change', schedule);
  schedule();

  return { close() {
    observer.disconnect();
    folds.disconnect();
    desktop.removeEventListener('change', schedule);
    if (frame !== null) view.cancelAnimationFrame(frame);
    reset();
  } };
}
