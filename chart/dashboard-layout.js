/** Align desktop columns only when their natural heights are already close. */
export function createDashboardLayout(root) {
  const view = root?.ownerDocument.defaultView;
  if (!view?.ResizeObserver) return { close() {} };
  const columns = [...root.children].filter(node => node.classList.contains('controller-column'));
  const desktop = view.matchMedia('(min-width: 801px)');
  let frame = null;

  function align() {
    frame = null;
    // Remove growth before measuring so the threshold always uses natural sizes.
    root.classList.remove('columns-aligned');
    if (!desktop.matches || columns.length !== 2) return;
    const bounds = columns.map(column => column.getBoundingClientRect());
    if (bounds.some(bound => bound.width === 0)) return;
    root.classList.toggle('columns-aligned', Math.abs(bounds[0].height - bounds[1].height) <= 48);
  }
  function schedule() {
    if (frame === null) frame = view.requestAnimationFrame(align);
  }
  const observer = new view.ResizeObserver(schedule);
  observer.observe(root);
  // Intrinsic content still resizes when a stretched card absorbs its changes;
  // observing card boxes instead would miss shrinking content and feed back growth.
  for (const content of root.querySelectorAll('.controller-column > .panel > *')) observer.observe(content);
  desktop.addEventListener('change', schedule);
  schedule();

  return { close() {
    observer.disconnect();
    desktop.removeEventListener('change', schedule);
    if (frame !== null) view.cancelAnimationFrame(frame);
    root.classList.remove('columns-aligned');
  } };
}
