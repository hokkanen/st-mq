// Browser-side geometry check, serialized by the synthetic browser fixtures.
// This checks the visible result, including inherited rules and media queries.
export function uiSpacingFailures() {
  const failures = [];
  const root = getComputedStyle(document.documentElement);
  const inset = Number.parseFloat(root.getPropertyValue('--ui-inset'));
  const surfaceInset = Number.parseFloat(root.getPropertyValue('--ui-surface-inset'));
  const narrow = matchMedia('(max-width: 480px)').matches, medium = matchMedia('(max-width: 800px)').matches;
  if (inset !== (narrow ? 8 : medium ? 10 : 12)) failures.push({ rule: 'nested inset', actual: inset });
  if (surfaceInset !== (narrow ? 16 : medium ? 20 : 24)) failures.push({ rule: 'card/window inset', actual: surfaceInset });
  const visible = node => node.checkVisibility() && node.getBoundingClientRect().width > 0;
  const number = (style, property) => Number.parseFloat(style[property]) || 0;
  const name = node => node.id || node.className || node.tagName;
  for (const fold of document.querySelectorAll('details')) {
    if (!visible(fold)) continue;
    const summary = fold.querySelector(':scope > summary');
    if (!summary) continue;
    const style = getComputedStyle(fold), heading = getComputedStyle(summary);
    // A card can own the step with padding; a plain fold can own it with margin.
    const step = number(style, 'marginInlineStart') + number(style, 'paddingInlineStart') + number(heading, 'paddingInlineStart');
    const expected = fold.matches('#pairing-details, .heating-explorer-footnotes') ? surfaceInset : inset;
    if (step < 0 || step > 0.5 && Math.abs(step - expected) > 0.5) failures.push({ rule: 'one disclosure step', node: name(fold), actual: step });
  }
  // These own the outside border's breathing room, rather than a nested step.
  const outerSurfaces = '.panel, .timing-card, .control-dialog, .confirmation-dialog, .pairing-reset-dialog, '
    + '.pairing-reset-header, .pairing-reset-body, .pairing-reset-actions, '
    + '.charging-report-dialog, .charging-priority-dialog, .chart-series-picker, .recording-status-overview, '
    + '.recording-status-notices:has(> :not([hidden])), .pairing-content, .pairing-opener, .pairing-attention, '
    + '.heating-explorer-header, .heating-explorer-snapshot, .heating-explorer-message, .heating-explorer-footnotes, '
    + '.history-recovery-header, .history-recovery-body';
  const unpadded = '.panel.pairing-panel, .history-panel[data-fullscreen="true"], .history-recovery-dialog, .heating-explorer-dialog';
  for (const node of document.querySelectorAll(outerSurfaces)) {
    if (!visible(node) || node.matches(unpadded)) continue;
    const style = getComputedStyle(node);
    // This segmented window delegates its inset to the aligned header, body and
    // footer. Its wrapper must stay unpadded to avoid adding a second inset.
    const expected = node.matches('.pairing-reset-dialog') ? 0 : surfaceInset;
    for (const property of ['paddingInlineStart', 'paddingInlineEnd']) {
      const actual = number(style, property);
      if (Math.abs(actual - expected) > 0.5) failures.push({ rule: 'card/window padding', node: name(node), property, actual });
    }
  }
  const surfaces = '.panel, #error, .notice, .read-only-help, .timing-card, .section-fold-body, .learning-section-body, '
    + '.equipment-device-body, .recording-health-body, .recording-task-status, .recording-status-overview, '
    + '.recording-status-notices, .recording-source-counts, .control-dialog, .confirmation-dialog, .pairing-reset-dialog, '
    + '.charging-report-dialog, .charging-report-result, .charging-priority-dialog, .configuration-location, '
    + '.configuration-review, .status-detail-popover, .heating-hold-warning, .heating-policy-decision, '
    + '.heating-explorer-header, .heating-explorer-snapshot, .heating-explorer-message, .heating-explorer-metric, '
    + '.heating-explorer-constraint, .heating-explorer-opportunity, .heating-explorer-footnotes, '
    + '.history-recovery-header, .history-recovery-body, .history-recovery-review, .comparison-range-controls, '
    + '.secure-web-access-security, .pairing-content, .pairing-opener, .pairing-attention';
  for (const node of document.querySelectorAll(surfaces)) {
    if (!visible(node) || node.matches(outerSurfaces) || node.matches(unpadded)) continue;
    const style = getComputedStyle(node);
    for (const property of ['paddingInlineStart', 'paddingInlineEnd']) {
      const actual = number(style, property);
      if (actual > 12.5) failures.push({ rule: 'compact content inset', node: name(node), property, actual });
    }
  }
  return failures;
}
