// Keep the two stacks aligned only while the extra whitespace stays subtle.
export function balanceControllerColumns(container) {
  const columns = [...container.querySelectorAll(':scope > .controller-column')];
  if (columns.length !== 2) return;

  const stacked = window.matchMedia('(max-width: 800px)');
  const adjustments = [0, 0];
  let frame = null;
  const balance = () => {
    frame = null;
    // Subtract our own padding so content growth and shrinkage are measured
    // naturally, without clearing styles or feeding alignment back into itself.
    const heights = columns.map((column, index) => column.getBoundingClientRect().height - adjustments[index]);
    const shorter = Math.min(...heights), taller = Math.max(...heights);
    const align = !stacked.matches && taller - shorter <= Math.min(48, shorter * 0.06);
    columns.forEach((column, index) => {
      const adjustment = align ? taller - heights[index] : 0;
      if (adjustment === adjustments[index]) return;
      adjustments[index] = adjustment;
      column.style.setProperty('--column-height-adjustment', `${adjustment}px`);
    });
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(balance);
  };
  // Apply changes in the next frame to avoid a ResizeObserver layout loop.
  const observer = new ResizeObserver(schedule);
  columns.forEach(column => observer.observe(column));
  stacked.addEventListener('change', schedule);
  balance();
}
