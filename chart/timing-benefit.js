import { heatingScopeDisplay } from './heating-scope.js';
import { chargingTimingDisplay, timingExplanations } from './timing-model.js';
import { firewoodDisplay, firewoodExplanations } from './firewood-benefit.js';
import { heatingExplanations } from './heating-benefit.js';

/** Keep native folds mounted while the chart refreshes their figures and notes. */
export function createTimingBenefit(root) {
  if (!root) return { render() {}, refreshLayout() {}, close() {} };
  const document = root.ownerDocument;
  const view = document.defaultView;
  let alignmentFrame = null;
  let lastFingerprint, closed = false, notes, notesContent, devices, overviewObserver, overviewHeight, selectionHeight;
  let latestPayload, modeStatus, heatingMode = 'model', heatingScope = 'home', chargingScope = 'total';
  const preferenceKey = 'stmq.heatingSavingMode';
  try { if (document.defaultView.localStorage?.getItem(preferenceKey) === 'timing') heatingMode = 'timing'; } catch {}
  const cards = new Map();
  const modeButtons = [], scopeButtons = [], chargingButtons = [];
  function chooseChargingScope(event) {
    if (closed) return;
    chargingScope = event.currentTarget.dataset.chargingScope;
    render(latestPayload);
  }
  function chooseScope(event) {
    if (closed) return;
    heatingScope = event.currentTarget.dataset.scope;
    if (heatingScope !== 'home') heatingMode = 'timing';
    render(latestPayload);
    const display = cards.get('heatPump').display;
    modeStatus.textContent = `${heatingScope}: ${display.amount ?? 'Unavailable'}${display.qualification ? `, ${display.qualification}` : ''}.`;
  }

  function chooseMode(event) {
    if (closed || heatingScope !== 'home' && event.currentTarget.dataset.mode === 'model') return;
    heatingMode = event.currentTarget.dataset.mode;
    try { document.defaultView.localStorage?.setItem(preferenceKey, heatingMode); } catch {}
    render(latestPayload);
    const display = cards.get('heatPump').display;
    modeStatus.textContent = `Heating: ${heatingMode === 'model' ? 'estimated cost difference' : 'timing cost difference'}. ${display.amount ?? 'Unavailable'}${display.outcome ? `, ${display.outcome}` : ''}.`;
  }

  function navigateOptions(event) {
    const buttons = (event.currentTarget.dataset.chargingScope ? chargingButtons : event.currentTarget.dataset.scope ? scopeButtons : modeButtons).filter(button => !button.disabled);
    const current = buttons.indexOf(event.currentTarget);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current + buttons.length - 1) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next].focus(); buttons[next].click();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function paragraph(parent, text, className = '') {
    if (text) parent.append(element('p', className, text));
  }
  function selectionRow(label, options) {
    const row = element('div', 'heating-selection-row');
    row.append(element('span', 'heating-selection-label', label), options);
    return row;
  }
  function selectionPanel(parent, rows) {
    const panel = element('div', 'heating-selection');
    const content = element('div', 'heating-selection-content');
    content.append(...rows); panel.append(content); parent.append(panel);
    return content;
  }
  function explanation(parent, title, paragraphs, className = '') {
    const section = element('section', `timing-explanation ${className}`.trim());
    section.append(element('h3', '', title));
    for (const text of paragraphs) paragraph(section, text);
    parent.append(section);
    return section;
  }
  function reconciliation(parent, display) {
    if (!display.reconciliation?.length) return;
    const section = element('section', 'timing-calculation');
    section.append(element('h4', '', 'Calculation for this selection'));
    const values = element('dl', 'timing-calculation-values');
    for (const { label, value } of display.reconciliation) {
      const row = element('div');
      row.append(element('dt', '', label), element('dd', '', value));
      values.append(row);
    }
    section.append(values);
    paragraph(section, display.reconciliationExplanation, 'timing-calculation-note');
    parent.append(section);
  }
  function alignOverviews() {
    // Keep the last visible alignment while the comparison panel is hidden.
    if (closed || root.closest('[hidden]') || root.getBoundingClientRect().width <= 0) return;
    // Match the control area before measuring the results. The inner content
    // keeps its natural height, so wrapping can both grow and shrink the row.
    const controlHeight = Math.ceil(Math.max(...[...cards.values()].map(card => card.selection.getBoundingClientRect().height)));
    if (!Number.isFinite(controlHeight) || controlHeight <= 0) return;
    if (controlHeight !== selectionHeight) {
      selectionHeight = controlHeight;
      devices.style.setProperty('--timing-selection-height', `${controlHeight}px`);
    }
    // Measure only intrinsic summary content. Expanded details must never set
    // the other card's height; observing the inner nodes also avoids feedback.
    const height = Math.ceil(Math.max(...[...cards.values()].map(card => card.overview.getBoundingClientRect().height)));
    if (!Number.isFinite(height) || height <= 0) return;
    if (height === overviewHeight) return;
    overviewHeight = height;
    devices.style.setProperty('--timing-overview-height', `${height}px`);
  }
  function scheduleAlignment() {
    if (closed) return;
    if (root.closest('[hidden]')) {
      if (alignmentFrame !== null) view.cancelAnimationFrame(alignmentFrame);
      alignmentFrame = null;
      return;
    }
    if (alignmentFrame === null) alignmentFrame = view.requestAnimationFrame(() => {
      alignmentFrame = null;
      alignOverviews();
    });
  }
  function initialize(displays) {
    devices = element('div', 'timing-devices');
    for (const display of displays) {
      const card = element('article', `timing-card timing-device${display.key === 'firewood' ? ' firewood-card' : ''}`); card.dataset.device = display.key;
      const overviewBox = element('div', 'timing-device-overview');
      const overview = element('div', 'timing-overview-content'); overviewBox.append(overview);
      const heading = element('div', 'timing-device-heading');
      let selection;
      const title = element('h3', 'timing-device-name', display.name);
      const period = element('span', 'timing-period'); heading.append(title, period);
      const comparison = element('div', 'timing-comparison');
      if (display.key === 'heatPump') {
        comparison.className += ' timing-comparison-switch';
        comparison.setAttribute('role', 'group'); comparison.setAttribute('aria-label', 'Heating cost comparison');
        for (const [mode, label] of [['model', 'Model estimate'], ['timing', 'Timing cost']]) {
          const button = element('button', 'timing-comparison-option', label);
          button.type = 'button'; button.dataset.mode = mode;
          button.setAttribute('aria-controls', 'heating-saving-result');
          button.addEventListener('click', chooseMode);
          button.addEventListener('keydown', navigateOptions);
          modeButtons.push(button); comparison.append(button);
        }
      } else comparison.append(element('span', 'timing-comparison-fixed', display.key === 'firewood' ? 'Model estimate' : 'Timing cost'));
      const label = element('p', 'timing-comparison-label');
      const figures = element('div', 'timing-figures');
      const result = element('div', 'timing-saving-result');
      result.append(label, figures);
      if (display.key === 'heatPump') {
        result.id = 'heating-saving-result';
        modeStatus = element('span', 'timing-selection-status');
        modeStatus.setAttribute('role', 'status');
        modeStatus.setAttribute('aria-live', 'polite'); modeStatus.setAttribute('aria-atomic', 'true');
      }
      overview.append(heading);
      if (display.key === 'heatPump') {
        const scopes = element('div', 'heating-scope-switch');
        scopes.setAttribute('role', 'group'); scopes.setAttribute('aria-label', 'Heating cost comparison scope');
        for (const [scope, text] of [['home', 'Home'], ['garage', 'Garage'], ['total', 'Total']]) {
          const button = element('button', 'timing-comparison-option', text);
          button.type = 'button'; button.dataset.scope = scope;
          button.setAttribute('aria-controls', 'heating-saving-result');
          button.addEventListener('click', chooseScope);
          button.addEventListener('keydown', navigateOptions);
          scopeButtons.push(button); scopes.append(button);
        }
        selection = selectionPanel(overview, [selectionRow('Area', scopes), selectionRow('Compare', comparison)]);
      } else if (display.key === 'charger') {
        const scopes = element('div', 'heating-scope-switch');
        scopes.setAttribute('role', 'group'); scopes.setAttribute('aria-label', 'Charging cost comparison scope');
        result.id = 'charging-saving-result';
        result.setAttribute('aria-live', 'polite');
        for (const [scope, text] of [['charger1', 'Charger 1'], ['charger2', 'Charger 2'], ['total', 'Total']]) {
          const button = element('button', 'timing-comparison-option', text);
          button.type = 'button'; button.dataset.chargingScope = scope;
          button.setAttribute('aria-controls', 'charging-saving-result');
          button.addEventListener('click', chooseChargingScope);
          button.addEventListener('keydown', navigateOptions);
          chargingButtons.push(button); scopes.append(button);
        }
        selection = selectionPanel(overview, [selectionRow('Charger', scopes), selectionRow('Compare', comparison)]);
      } else {
        selection = selectionPanel(overview, [selectionRow('Source', element('span', 'timing-selection-value', 'Logged wood')),
          selectionRow('Compare', comparison)]);
      }
      overview.append(result);
      if (display.key === 'heatPump') overview.append(modeStatus);
      const details = element('details', 'timing-device-detail'); details.dataset.device = display.key;
      details.append(element('summary', '', `${display.name} details`));
      const content = element('div', 'timing-detail-content');
      details.append(content); card.append(overviewBox, details); devices.append(card);
      cards.set(display.key, { overview, selection, content, figures, period, label });
    }
    notes = element('details', 'timing-explanations');
    notesContent = element('div', 'timing-explanations-content');
    notes.append(element('summary', '', 'How these comparisons work'), notesContent);
    root.replaceChildren(devices, notes);
    // Equal heights are a layout enhancement. Older appliance browsers must
    // still render the figures and controls when ResizeObserver is unavailable.
    if (typeof view.ResizeObserver === 'function') {
      overviewObserver = new view.ResizeObserver(scheduleAlignment);
      for (const card of cards.values()) {
        overviewObserver.observe(card.overview);
        overviewObserver.observe(card.selection);
      }
    }
    // The disclosure owner also requests layout when it reveals this panel.
    view.addEventListener('resize', scheduleAlignment);
  }
  function deviceOverview(display) {
    const overview = document.createDocumentFragment();
    const result = element('p', 'timing-result');
    if (display.available) {
      result.append(element('strong', 'timing-amount', display.amount), element('span', 'timing-outcome', display.outcome));
    } else result.append(element('strong', 'timing-unavailable', display.noChargingDetected ? 'No charging detected' : 'Comparison unavailable'));
    overview.append(result);
    if (!display.available && !display.noChargingDetected) paragraph(overview, display.unavailableReason, 'timing-unavailable-reason');
    paragraph(overview, display.smallDifferenceExplanation, 'timing-small-difference');
    paragraph(overview, display.qualification, 'timing-dates');

    const meta = element('div', 'timing-meta');
    if (display.basis) {
      const basis = element('span', 'timing-basis', display.basis);
      basis.dataset.basis = display.sources.length > 1 ? 'mixed' : display.sources[0]?.key;
      meta.append(basis);
    }
    meta.append(element('span', 'timing-coverage', display.coverageLabel));
    if (display.assumedRates) meta.append(element('span', 'timing-assumed', 'Assumed rates'));
    overview.append(meta);
    paragraph(overview, display.calculationPeriod, 'timing-dates');
    return overview;
  }
  function deviceDetail(display) {
    const content = document.createDocumentFragment();
    reconciliation(content, display);
    const energy = element('section', 'timing-energy');
    energy.append(element('h4', '', display.available ? 'Energy used in the comparison' : 'What data is needed'));
    paragraph(energy, display.energyExplanation);
    if (display.available && display.sources.length) {
      const track = element('div', 'timing-evidence-track'); track.setAttribute('aria-hidden', 'true');
      for (const source of display.sources) {
        const segment = element('span'); segment.dataset.source = source.key; segment.style.flexGrow = String(source.share);
        track.append(segment);
      }
      energy.append(track);
      for (const source of display.sources) {
        const row = element('div', 'timing-source'); row.dataset.source = source.key;
        const title = element('div', 'timing-source-heading');
        title.append(element('strong', '', source.label), element('span', 'timing-source-share', `${source.percentage} of ${display.includedTimeLabel}`));
        row.append(title);
        paragraph(row, source.explanation);
        paragraph(row, source.dates, 'timing-source-dates');
        energy.append(row);
      }
      if (display.sources.some(source => source.dates)) paragraph(energy, display.evidenceExplanation, 'timing-evidence-note');
    }
    for (const text of display.auxiliaryNotes) paragraph(energy, text);
    paragraph(energy, display.availablePowerPeriod, 'timing-dates');
    content.append(energy);

    const coverage = element('section', 'timing-time');
    coverage.append(element('h4', '', display.coverageHeading));
    paragraph(coverage, display.coverageSummary, 'timing-coverage-summary');
    paragraph(coverage, display.coverageExplanation);
    paragraph(coverage, display.periodExplanation, 'timing-period-explanation');
    content.append(coverage);
    if (display.assumedRates) {
      const rates = element('div', 'timing-device-rates');
      paragraph(rates, display.rateSummary, 'timing-assumed');
      paragraph(rates, display.ratePeriod, 'timing-dates');
      content.append(rates);
    }
    for (const text of display.breakdown ?? []) paragraph(content, text, 'timing-dates');
    return content;
  }
  function firewoodOverview(display) {
    const overview = document.createDocumentFragment();
    const result = element('p', 'timing-result');
    result.append(element('strong', display.available ? 'timing-amount' : 'timing-unavailable', display.amount ?? 'Estimate unavailable'));
    if (display.available) result.append(element('span', 'timing-outcome', display.outcome));
    overview.append(result);
    if (!display.available) paragraph(overview, display.unavailableReason, 'timing-unavailable-reason');
    if (display.available) paragraph(overview, display.electricity, 'firewood-energy');
    const meta = element('div', 'timing-meta');
    const status = element('span', 'timing-basis firewood-status', display.statusLabel);
    status.dataset.basis = 'firewood'; status.dataset.status = display.status;
    meta.append(status, element('span', 'timing-coverage', display.coverageLabel));
    if (display.assumedRates) meta.append(element('span', 'timing-assumed', 'Assumed rates'));
    overview.append(meta);
    paragraph(overview, display.woodCost, 'timing-dates');
    paragraph(overview, display.calculationPeriod, 'timing-dates');
    return overview;
  }
  function firewoodDetail(display) {
    const content = document.createDocumentFragment();
    const evidence = element('section', 'timing-energy');
    evidence.append(element('h4', '', 'How to read this estimate'));
    paragraph(evidence, display.statusExplanation);
    paragraph(evidence, display.uncertainty, 'firewood-range');
    for (const text of display.evidence) paragraph(evidence, text);
    content.append(evidence);
    const fuel = element('section', 'timing-time');
    fuel.append(element('h4', '', 'Recorded wood and assumptions'));
    paragraph(fuel, display.loads); paragraph(fuel, display.loadExplanation); paragraph(fuel, display.woodCost);
    for (const text of display.assumptions) paragraph(fuel, text);
    content.append(fuel);
    const coverage = element('section', 'timing-time');
    coverage.append(element('h4', '', 'Time included'));
    paragraph(coverage, display.coverageSummary, 'timing-coverage-summary');
    paragraph(coverage, display.coverageExplanation);
    paragraph(coverage, display.coveredPeriod, 'timing-dates'); content.append(coverage);
    if (display.remaining) {
      const remaining = element('section', 'firewood-remaining');
      remaining.append(element('h4', '', display.remaining.label));
      for (const text of [display.remaining.amount, display.remaining.energy, display.remaining.fuel,
        display.remaining.uncertainty, display.remaining.unavailable, display.remaining.through, display.remaining.reason, display.remaining.explanation]) paragraph(remaining, text);
      content.append(remaining);
    }
    return content;
  }

  function heatingOverview(display) {
    const overview = document.createDocumentFragment();
    const result = element('p', 'timing-result');
    result.append(element('strong', display.available ? 'timing-amount' : 'timing-unavailable', display.amount ?? 'Estimate unavailable'));
    if (display.available) result.append(element('span', 'timing-outcome', display.outcome));
    overview.append(result);
    if (!display.available) paragraph(overview, display.unavailableReason, 'timing-unavailable-reason');
    const meta = element('div', 'timing-meta');
    const basis = element('span', 'timing-basis', 'Completed-cycle estimate'); basis.dataset.basis = 'modelled';
    meta.append(basis); overview.append(meta);
    paragraph(overview, display.cycleSummary, 'heating-cycle-summary');
    paragraph(overview, display.qualification, 'timing-dates');
    paragraph(overview, 'Space heating · includes recovery', 'timing-dates');
    paragraph(overview, display.calculationPeriod, 'timing-dates');
    return overview;
  }
  function heatingDetail(display) {
    const content = document.createDocumentFragment();
    reconciliation(content, display);
    const comparison = element('section', 'timing-energy');
    comparison.append(element('h4', '', 'How to read this estimate'));
    for (const text of display.explanations ?? heatingExplanations) paragraph(comparison, text);
    paragraph(comparison, display.uncertainty, 'heating-range'); content.append(comparison);
    const cycles = element('section', 'timing-time');
    cycles.append(element('h4', '', 'Cycles included'));
    paragraph(cycles, display.cycleSummary);
    paragraph(cycles, display.excludedSummary);
    paragraph(cycles, display.periodExplanation);
    paragraph(cycles, display.coveredPeriod, 'timing-dates'); content.append(cycles);
    for (const text of display.breakdown ?? []) paragraph(content, text, 'timing-dates');
    return content;
  }
  function render(payload) {
    if (closed) return;
    latestPayload = payload;
    const displays = [heatingScopeDisplay(payload, heatingScope, heatingMode), chargingTimingDisplay(payload, chargingScope),
      firewoodDisplay(payload?.firewoodBenefit, payload)];
    const visibleAssumedRates = displays.some(display => display.assumedRates);
    const periodAssumedRates = Boolean(payload?.meta?.priceAssumptions?.used);
    const fingerprint = JSON.stringify({ displays, periodAssumedRates, heatingMode, heatingScope, chargingScope });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (!notes) initialize(displays);
    modeStatus.textContent = '';
    for (const button of chargingButtons) button.setAttribute('aria-pressed', String(button.dataset.chargingScope === chargingScope));
    for (const button of scopeButtons) button.setAttribute('aria-pressed', String(button.dataset.scope === heatingScope));
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === heatingMode));
      button.disabled = heatingScope !== 'home' && button.dataset.mode === 'model';
      button.title = button.disabled ? 'The heating model estimate applies to Home only.' : '';
    }
    for (const display of displays) {
      const card = cards.get(display.key);
      const modelHeating = display.key === 'heatPump' && heatingMode === 'model';
      const cardFingerprint = JSON.stringify({ display, modelHeating });
      if (cardFingerprint === card.fingerprint) continue;
      card.fingerprint = cardFingerprint; card.display = display;
      card.period.textContent = display.periodLabel ?? '';
      card.label.textContent = display.key === 'firewood' || modelHeating ? 'Estimated cost difference' : 'Timing cost difference';
      card.figures.replaceChildren(display.key === 'firewood' ? firewoodOverview(display) : modelHeating ? heatingOverview(display) : deviceOverview(display));
      card.content.replaceChildren(display.key === 'firewood' ? firewoodDetail(display) : modelHeating ? heatingDetail(display) : deviceDetail(display));
    }
    alignOverviews();
    notesContent.replaceChildren();
    explanation(notesContent, 'Timing cost comparison', timingExplanations.comparison);
    explanation(notesContent, 'Timing coverage and energy sources', [...timingExplanations.coverage, ...timingExplanations.evidence]);
    explanation(notesContent, 'Heating model estimate', heatingExplanations);
    explanation(notesContent, 'Fireplace model estimate', firewoodExplanations);
    if (periodAssumedRates || visibleAssumedRates) {
      const rates = explanation(notesContent, 'When contract rates are assumed', timingExplanations.rates, 'timing-rate-explanation');
      if (periodAssumedRates) {
        const context = element('div', 'timing-period-rates');
        paragraph(context, 'Selected period uses assumed rates', 'timing-assumed');
        paragraph(context, 'Some dates in this comparison period use assumed contract rates. Affected comparisons are marked “Assumed rates” in their results.');
        rates.append(context);
      }
    }
  }
  return {
    render,
    refreshLayout: scheduleAlignment,
    close() {
      closed = true; overviewObserver?.disconnect();
      if (alignmentFrame !== null) view.cancelAnimationFrame(alignmentFrame);
      alignmentFrame = null;
      view.removeEventListener('resize', scheduleAlignment);
      for (const button of modeButtons) button.removeEventListener('click', chooseMode);
      for (const button of scopeButtons) button.removeEventListener('click', chooseScope);
      for (const button of chargingButtons) button.removeEventListener('click', chooseChargingScope);
      for (const button of [...modeButtons, ...scopeButtons, ...chargingButtons]) button.removeEventListener('keydown', navigateOptions);
    },
  };
}
