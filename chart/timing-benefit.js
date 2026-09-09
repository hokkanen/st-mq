import { timingDisplay, timingExplanations } from './timing-model.js';
import { firewoodDisplay, firewoodExplanations } from './firewood-benefit.js';
import { heatingDisplay, heatingExplanations } from './heating-benefit.js';

/** Keep native folds mounted while the chart refreshes their figures and notes. */
export function createTimingBenefit(root) {
  if (!root) return { render() {}, close() {} };
  const document = root.ownerDocument;
  let lastFingerprint, closed = false, notes, devices, overviewObserver, overviewHeight;
  let latestPayload, modeStatus, heatingMode = 'model';
  const preferenceKey = 'stmq.heatingSavingMode';
  try { if (document.defaultView.localStorage?.getItem(preferenceKey) === 'timing') heatingMode = 'timing'; } catch {}
  const cards = new Map();
  const modeButtons = [];

  function chooseMode(event) {
    if (closed) return;
    heatingMode = event.currentTarget.dataset.mode;
    try { document.defaultView.localStorage?.setItem(preferenceKey, heatingMode); } catch {}
    render(latestPayload);
    const display = cards.get('heatPump').display;
    modeStatus.textContent = `Heating: ${heatingMode === 'model' ? 'model-estimated saving' : 'timing cost saving'}. ${display.amount ?? 'Unavailable'}${display.outcome ? `, ${display.outcome}` : ''}.`;
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
  function explanation(parent, title, paragraphs, className = '') {
    const section = element('section', `timing-explanation ${className}`.trim());
    section.append(element('h3', '', title));
    for (const text of paragraphs) paragraph(section, text);
    parent.append(section);
    return section;
  }
  function alignOverviews() {
    if (closed) return;
    // Measure only intrinsic summary content. Expanded details must never set
    // the other card's height; observing the inner nodes also avoids feedback.
    const height = Math.ceil(Math.max(...[...cards.values()].map(card => card.overview.getBoundingClientRect().height)));
    if (height === overviewHeight) return;
    overviewHeight = height;
    devices.style.setProperty('--timing-overview-height', `${height}px`);
  }
  function initialize(displays) {
    const intro = element('div', 'timing-intro');
    paragraph(intro, 'Explore Heating by model estimate or timing cost. Charging shows timing cost; Fireplace shows a model estimate.');
    paragraph(intro, 'These comparisons have different baselines and are not added together. Positive amounts mean lower estimated cost; negative amounts mean higher cost.', 'timing-sign-guide');
    devices = element('div', 'timing-devices');
    for (const display of displays) {
      const card = element('article', `timing-card timing-device${display.key === 'firewood' ? ' firewood-card' : ''}`); card.dataset.device = display.key;
      const overviewBox = element('div', 'timing-device-overview');
      const overview = element('div', 'timing-overview-content'); overviewBox.append(overview);
      const heading = element('div', 'timing-device-heading');
      const title = element('h3', 'timing-device-name', display.name);
      const period = element('span', 'timing-period'); heading.append(title, period);
      const comparison = element('div', 'timing-comparison');
      if (display.key === 'heatPump') {
        comparison.className += ' timing-comparison-switch';
        comparison.setAttribute('role', 'group'); comparison.setAttribute('aria-label', 'Heating savings comparison');
        for (const [mode, label] of [['model', 'Model estimate'], ['timing', 'Timing cost']]) {
          const button = element('button', 'timing-comparison-option', label);
          button.type = 'button'; button.dataset.mode = mode;
          button.setAttribute('aria-controls', 'heating-saving-result');
          button.addEventListener('click', chooseMode);
          modeButtons.push(button); comparison.append(button);
        }
      } else comparison.append(element('span', 'timing-comparison-fixed', display.key === 'firewood' ? 'Model estimate' : 'Timing cost'));
      const label = element('p', 'timing-comparison-label');
      const figures = element('div', 'timing-figures');
      if (display.key === 'heatPump') {
        figures.id = 'heating-saving-result';
        modeStatus = element('span', 'timing-selection-status');
        modeStatus.setAttribute('role', 'status');
        modeStatus.setAttribute('aria-live', 'polite'); modeStatus.setAttribute('aria-atomic', 'true');
      }
      overview.append(heading, comparison, label, figures);
      if (display.key === 'heatPump') overview.append(modeStatus);
      const details = element('details', 'timing-device-detail'); details.dataset.device = display.key;
      details.append(element('summary', '', `${display.name} details`));
      const content = element('div', 'timing-detail-content');
      details.append(content); card.append(overviewBox, details); devices.append(card);
      cards.set(display.key, { overview, content, figures, period, label });
    }
    notes = element('div', 'timing-explanations');
    root.replaceChildren(intro, devices, notes);
    overviewObserver = new document.defaultView.ResizeObserver(alignOverviews);
    for (const card of cards.values()) overviewObserver.observe(card.overview);
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
    meta.append(status, element('span', 'timing-coverage', display.coverageLabel)); overview.append(meta);
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
        display.remaining.unavailable, display.remaining.through, display.remaining.reason, display.remaining.explanation]) paragraph(remaining, text);
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
    paragraph(overview, 'Space heating · includes recovery', 'timing-dates');
    paragraph(overview, display.calculationPeriod, 'timing-dates');
    return overview;
  }
  function heatingDetail(display) {
    const content = document.createDocumentFragment();
    const comparison = element('section', 'timing-energy');
    comparison.append(element('h4', '', 'How to read this estimate'));
    for (const text of heatingExplanations) paragraph(comparison, text);
    paragraph(comparison, display.uncertainty, 'heating-range'); content.append(comparison);
    const cycles = element('section', 'timing-time');
    cycles.append(element('h4', '', 'Cycles included'));
    paragraph(cycles, display.cycleSummary);
    paragraph(cycles, display.excludedSummary);
    paragraph(cycles, display.periodExplanation);
    paragraph(cycles, display.coveredPeriod, 'timing-dates'); content.append(cycles);
    return content;
  }
  function render(payload) {
    if (closed) return;
    latestPayload = payload;
    const timingDisplays = ['heatPump', 'charger'].map(key => timingDisplay(key, payload?.timingBenefit?.[key], payload));
    const displays = [heatingMode === 'model' ? heatingDisplay(payload?.heatingBenefit, payload) : timingDisplays[0], timingDisplays[1],
      firewoodDisplay(payload?.firewoodBenefit, payload)];
    const chartAssumedRates = Boolean(payload?.meta?.priceAssumptions?.used) && !timingDisplays.some(display => display.assumedRates);
    const fingerprint = JSON.stringify({ displays, chartAssumedRates, heatingMode });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (!notes) initialize(displays);
    modeStatus.textContent = '';
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === heatingMode));
    for (const display of displays) {
      const card = cards.get(display.key);
      const modelHeating = display.key === 'heatPump' && heatingMode === 'model';
      const cardFingerprint = JSON.stringify({ display, modelHeating });
      if (cardFingerprint === card.fingerprint) continue;
      card.fingerprint = cardFingerprint; card.display = display;
      card.period.textContent = display.periodLabel ?? '';
      card.label.textContent = display.key === 'firewood' || modelHeating ? 'Model-estimated saving' : 'Timing cost saving';
      card.figures.replaceChildren(display.key === 'firewood' ? firewoodOverview(display) : modelHeating ? heatingOverview(display) : deviceOverview(display));
      card.content.replaceChildren(display.key === 'firewood' ? firewoodDetail(display) : modelHeating ? heatingDetail(display) : deviceDetail(display));
    }
    alignOverviews();
    notes.replaceChildren();
    explanation(notes, 'Timing cost comparison', timingExplanations.comparison);
    explanation(notes, 'Timing coverage and energy sources', [...timingExplanations.coverage, ...timingExplanations.evidence]);
    explanation(notes, 'Heating model estimate', heatingExplanations);
    explanation(notes, 'Fireplace model estimate', firewoodExplanations);
    if (chartAssumedRates || timingDisplays.some(display => display.assumedRates)) {
      const rates = explanation(notes, 'When contract rates are assumed', timingExplanations.rates, 'timing-rate-explanation');
      if (chartAssumedRates) {
        const context = element('div', 'timing-chart-rates');
        paragraph(context, 'Chart uses assumed rates', 'timing-assumed');
        paragraph(context, 'The price chart uses assumed rates, but no device comparison here includes the affected periods.');
        rates.append(context);
      }
    }
  }
  return {
    render,
    close() {
      closed = true; overviewObserver?.disconnect();
      for (const button of modeButtons) button.removeEventListener('click', chooseMode);
    },
  };
}
