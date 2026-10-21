// Browser-side geometry check, serialized by the synthetic browser fixtures.
// This checks the visible result, including inherited rules and media queries.
export function uiSpacingFailures() {
  const failures = [];
  const inset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-inset'));
  if (inset !== 12) return [{ rule: 'shared inset', actual: inset }];
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
    if (step < 0 || step > 0.5 && Math.abs(step - inset) > 0.5) failures.push({ rule: 'one disclosure step', node: name(fold), actual: step });
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
    if (!visible(node) || node.matches('.history-panel[data-fullscreen="true"]')) continue;
    const style = getComputedStyle(node);
    for (const property of ['paddingInlineStart', 'paddingInlineEnd']) {
      const actual = number(style, property);
      if (actual > inset + 0.5) failures.push({ rule: 'surface inset', node: name(node), property, actual });
    }
  }
  return failures;
}
