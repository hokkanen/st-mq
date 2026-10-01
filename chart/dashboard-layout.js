/** Match only the two compact overview areas; expanded controls stay independent. */
export function createDashboardOverviewLayout({ document }) {
  const view = document.defaultView;
  const root = document.querySelector('.controller-panels');
  const spaces = [...document.querySelectorAll('.controller-panels .zone-summary > .overview-space')];
  if (!view || !root || spaces.length !== 2) return { refreshLayout() {}, close() {} };

  const property = '--dashboard-overview-height';
  const desktop = view.matchMedia('(min-width: 801px)');
  let frame = null, closed = false;
  function apply(value) {
    if (root.style.getPropertyValue(property) === value) return;
    if (value) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }
  function align() {
    frame = null;
    if (closed) return;
    if (!desktop.matches) { apply(''); return; }
    // Reading the children instead of the equalized wrappers lets either area
    // shrink again. flow-root keeps their margins inside each wrapper.
    const height = Math.ceil(Math.max(0, ...spaces.map(space => {
      const bounds = space.getBoundingClientRect();
      if (!bounds.width) return 0;
      return Math.max(0, ...[...space.children].map(child => {
        if (!child.getClientRects().length) return 0;
        const bottomMargin = parseFloat(view.getComputedStyle(child).marginBottom) || 0;
        return child.getBoundingClientRect().bottom + bottomMargin - bounds.top;
      }));
    })));
    if (height > 0) apply(`${height}px`);
  }
  function refreshLayout() {
    if (closed || frame !== null) return;
    frame = view.requestAnimationFrame(align);
  }
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(refreshLayout) : null;
  for (const space of spaces) for (const child of space.children) observer?.observe(child);
  desktop.addEventListener('change', refreshLayout);
  view.addEventListener('resize', refreshLayout);
  refreshLayout();
  return {
    refreshLayout,
    close() {
      closed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      observer?.disconnect();
      desktop.removeEventListener('change', refreshLayout);
      view.removeEventListener('resize', refreshLayout);
      apply('');
    },
  };
}
