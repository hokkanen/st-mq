/** Balance desktop columns within a small spacing budget for each card. */
export function createDashboardLayout(root) {
  const view = root?.ownerDocument.defaultView;
  if (!view?.ResizeObserver) return { close() {} };
  const columns = [...root.children].filter(node => node.classList.contains('controller-column'));
  const cards = columns.map(column => [...column.children].filter(node => node.classList.contains('panel')));
  const desktop = view.matchMedia('(min-width: 801px)');
  let frame = null;

  function reset() {
    root.classList.remove('columns-aligned');
    for (const card of cards.flat()) card.style.removeProperty('--dashboard-balance-space');
  }
  function align() {
    frame = null;
    // Measure without added spacing, including after folds close or content shrinks.
    reset();
    if (!desktop.matches || columns.length !== 2) return;
    const bounds = columns.map(column => column.getBoundingClientRect());
    if (bounds.some(bound => bound.width === 0)) return;
    const shorter = bounds[0].height <= bounds[1].height ? 0 : 1;
    const difference = Math.abs(bounds[0].height - bounds[1].height);
    const budgets = cards[shorter].map(card => {
      const height = card.getBoundingClientRect().height;
      // One slot between each displayed section, plus space above the footer
      // label. Fixed outer padding keeps headings and bottom insets aligned.
      const slots = [...card.children].filter(node => node.getClientRects().length > 0).length;
      return { card, slots, growth: Math.min(slots * 12, height * .1) };
    });
    const capacity = budgets.reduce((total, budget) => total + budget.growth, 0);
    if (!capacity || difference > capacity) return;
    for (const { card, slots, growth } of budgets) {
      if (slots) card.style.setProperty('--dashboard-balance-space', `${difference * growth / capacity / slots}px`);
    }
    root.classList.add('columns-aligned');
  }
  function schedule() {
    if (frame === null) frame = view.requestAnimationFrame(align);
  }
  const observer = new view.ResizeObserver(schedule);
  observer.observe(root);
  // Watch sections, including their padding, so shrinking the shorter column is
  // detected even when the overall dashboard height stays unchanged.
  for (const content of root.querySelectorAll('.controller-column > .panel > *')) observer.observe(content, { box: 'border-box' });
  desktop.addEventListener('change', schedule);
  schedule();

  return { close() {
    observer.disconnect();
    desktop.removeEventListener('change', schedule);
    if (frame !== null) view.cancelAnimationFrame(frame);
    reset();
  } };
}
