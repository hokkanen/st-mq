import { timingDisplay, timingExplanations } from './timing-model.js';

/** Inline explanations live inside the native fold, which survives chart refreshes. */
export function createTimingBenefit(root) {
  if (!root) return { render() {}, close() {} };
  const document = root.ownerDocument;
  let lastFingerprint, closed = false;

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
  function deviceCard(display) {
    const card = element('article', 'timing-card timing-device'); card.dataset.device = display.key;
    const heading = element('div', 'timing-device-heading');
    heading.append(element('h3', 'timing-device-name', display.name));
    if (display.periodLabel) heading.append(element('span', 'timing-period', display.periodLabel));
    card.append(heading);
    const result = element('p', 'timing-result');
    if (display.available) {
      result.append(element('strong', 'timing-amount', display.amount), element('span', 'timing-outcome', display.outcome));
    } else result.append(element('strong', 'timing-unavailable', 'Comparison unavailable'));
    card.append(result);
    if (!display.available) paragraph(card, display.unavailableReason, 'timing-unavailable-reason');
    paragraph(card, display.smallDifferenceExplanation, 'timing-small-difference');

    const meta = element('div', 'timing-meta');
    if (display.basis) {
      const basis = element('span', 'timing-basis', display.basis);
      basis.dataset.basis = display.sources.length > 1 ? 'mixed' : display.sources[0]?.key;
      meta.append(basis);
    }
    meta.append(element('span', 'timing-coverage', display.coverageLabel));
    if (display.assumedRates) meta.append(element('span', 'timing-assumed', 'Assumed rates'));
    card.append(meta);
    paragraph(card, display.calculationPeriod, 'timing-dates');
    return card;
  }

  function deviceDetail(display) {
    const card = element('article', 'timing-card timing-device-detail'); card.dataset.device = display.key;
    card.append(element('h3', 'timing-device-name', `${display.name} details`));
    const energy = element('section', 'timing-energy');
    energy.append(element('h4', '', display.available ? 'Energy behind this figure' : 'Energy needed for a comparison'));
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
        title.append(element('strong', '', source.label), element('span', 'timing-source-share', `${source.percentage} of included time`));
        row.append(title);
        paragraph(row, source.explanation);
        paragraph(row, source.dates, 'timing-source-dates');
        energy.append(row);
      }
      if (display.sources.some(source => source.dates)) paragraph(energy, display.evidenceExplanation, 'timing-evidence-note');
    }
    for (const text of display.auxiliaryNotes) paragraph(energy, text);
    paragraph(energy, display.availablePowerPeriod, 'timing-dates');
    card.append(energy);

    const coverage = element('section', 'timing-time');
    coverage.append(element('h4', '', 'Which periods are included'));
    paragraph(coverage, display.coverageSummary, 'timing-coverage-summary');
    paragraph(coverage, display.coverageExplanation);
    paragraph(coverage, display.periodExplanation, 'timing-period-explanation');
    card.append(coverage);
    if (display.assumedRates) {
      const rates = element('div', 'timing-device-rates');
      paragraph(rates, display.rateSummary, 'timing-assumed');
      paragraph(rates, display.ratePeriod, 'timing-dates');
      card.append(rates);
    }
    return card;
  }

  return {
    render(payload) {
      if (closed) return;
      const displays = ['heatPump', 'charger'].map(key => timingDisplay(key, payload?.timingBenefit?.[key], payload));
      const chartAssumedRates = Boolean(payload?.meta?.priceAssumptions?.used) && !displays.some(display => display.assumedRates);
      const fingerprint = JSON.stringify({ displays, chartAssumedRates });
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      const intro = element('div', 'timing-intro');
      paragraph(intro, 'Compare heating and charging with the same daily energy at each full day’s average all-in price.');
      paragraph(intro, 'Positive = cheaper timing · Negative = dearer timing', 'timing-sign-guide');
      const devices = element('div', 'timing-devices');
      for (const display of displays) devices.append(deviceCard(display));
      const notes = element('div', 'timing-explanations');
      explanation(notes, 'How the comparison works', timingExplanations.comparison);
      explanation(notes, 'What time coverage means', timingExplanations.coverage);
      explanation(notes, 'How to read the energy sources', timingExplanations.evidence);
      if (chartAssumedRates || displays.some(display => display.assumedRates)) {
        const rates = explanation(notes, 'When contract rates are assumed', timingExplanations.rates, 'timing-rate-explanation');
        if (chartAssumedRates) {
          const context = element('div', 'timing-chart-rates');
          paragraph(context, 'Chart uses assumed rates', 'timing-assumed');
          paragraph(context, 'The price chart uses assumed rates in this selection. No device comparison shown here includes affected time; an unavailable comparison remains unavailable.');
          rates.append(context);
        }
      }
      const evidence = element('div', 'timing-evidence-devices');
      for (const display of displays) evidence.append(deviceDetail(display));
      root.replaceChildren(intro, devices, notes, evidence);
    },
    close() { closed = true; },
  };
}
