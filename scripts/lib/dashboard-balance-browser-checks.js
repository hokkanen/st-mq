import assert from 'node:assert/strict';

// Exercise the live ResizeObserver against the disposable browser fixture.
export async function checkDashboardBalance({ evaluate, until }) {
  await evaluate(`(() => {
    const root = document.querySelector('.controller-panels');
    const columns = [...root.querySelectorAll(':scope > .controller-column')];
    const cards = [...root.querySelectorAll('.controller-column > .panel')];
    const pads = [document.querySelector('#home-control .home-support'), document.getElementById('garage-equipment-details')];
    const folds = [...root.querySelectorAll('details')].map(node => [node, node.open]);
    const originalPads = pads.map(node => ({ value: node.style.getPropertyValue('padding-bottom'),
      priority: node.style.getPropertyPriority('padding-bottom'), pixels: parseFloat(getComputedStyle(node).paddingBottom) }));
    const chargers = document.getElementById('charging-devices');
    const state = globalThis.dashboardBalanceSmoke = { root, columns, cards, pads, originalPads,
      folds, chargers, chargerNodes: [...chargers.childNodes], mutations: 0 };
    state.observer = new MutationObserver(records => state.mutations += records.length);
    state.observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    for (const card of cards) state.observer.observe(card, { attributes: true, attributeFilter: ['style'] });
    state.natural = callback => {
      const spacing = cards.map(card => card.style.getPropertyValue('--dashboard-balance-space'));
      for (const card of cards) card.style.removeProperty('--dashboard-balance-space');
      try { return callback(); }
      finally { cards.forEach((card, index) => {
        if (spacing[index]) card.style.setProperty('--dashboard-balance-space', spacing[index]);
      }); }
    };
    state.difference = (difference, common = 0) => {
      pads.forEach((node, index) => node.style.setProperty('padding-bottom', (originalPads[index].pixels + common) + 'px'));
      const current = state.natural(() => columns[1].getBoundingClientRect().height - columns[0].getBoundingClientRect().height);
      const adjustment = difference - current, index = adjustment > 0 ? 1 : 0;
      pads[index].style.setProperty('padding-bottom', (originalPads[index].pixels + common + Math.abs(adjustment)) + 'px');
    };
    state.restorePads = () => pads.forEach((node, index) => {
      const original = originalPads[index];
      if (original.value) node.style.setProperty('padding-bottom', original.value, original.priority);
      else node.style.removeProperty('padding-bottom');
    });
    for (const [node] of folds) node.open = false;
  })()`);

  const settle = async label => {
    const samples = await evaluate(`new Promise(resolve => {
      const state = globalThis.dashboardBalanceSmoke, samples = [];
      const frame = () => {
        samples.push({ mutations: state.mutations,
          heights: state.columns.map(node => node.getBoundingClientRect().height) });
        if (samples.length === 10) resolve(samples);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })`);
    for (const sample of samples.slice(-4)) assert.deepEqual(sample, samples.at(-1),
      `${label}: column sizing settles without repeated style writes or changing heights`);
  };
  const readExpression = `(() => {
    const state = globalThis.dashboardBalanceSmoke;
    const snapshot = () => ({
      columns: state.columns.map(node => { const box = node.getBoundingClientRect(); return { height: box.height, bottom: box.bottom }; }),
      headings: ['control-title', 'garage-title'].map(id => document.getElementById(id).getBoundingClientRect().top),
      cards: state.cards.map(node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        const footer = node.querySelector(':scope > .home-support, :scope > .dashboard-disclosure:last-child');
        const summary = footer.querySelector('summary');
        return { id: node.id, height: box.height, gap: parseFloat(style.rowGap),
          column: state.columns.indexOf(node.parentElement),
          slots: Math.max(0, [...node.children].filter(child => child.getClientRects().length > 0).length - 1),
          bottomPadding: parseFloat(style.paddingBottom), topPadding: parseFloat(style.paddingTop),
          footerPadding: parseFloat(getComputedStyle(footer).paddingTop),
          footerInset: box.bottom - summary.getBoundingClientRect().bottom };
      }),
      summaries: ['home-equipment-details', 'garage-equipment-details', 'connections-details'].map(id => {
        const summary = document.querySelector('#' + id + ' > summary'), style = getComputedStyle(summary);
        return { id, height: summary.getBoundingClientRect().height,
          topPadding: parseFloat(style.paddingTop), bottomPadding: parseFloat(style.paddingBottom) };
      }),
    });
    const actual = snapshot(), natural = state.natural(snapshot);
    return { aligned: state.root.classList.contains('columns-aligned'), actual, natural };
  })()`;
  const read = () => evaluate(readExpression);
  const checkBounds = (state, label) => {
    for (const [index, card] of state.actual.cards.entries()) {
      const natural = state.natural.cards[index], growth = card.height - natural.height;
      assert.ok(growth >= -1 && growth <= natural.height * .1 + 1,
        `${label}: ${card.id} grows by at most 10% (${growth}px of ${natural.height}px)`);
      assert.ok(card.gap >= 0 && card.gap <= 12.1,
        `${label}: ${card.id} keeps its added section gaps within 12px`);
      assert.equal(card.bottomPadding, natural.bottomPadding, `${label}: ${card.id} preserves its bottom padding`);
      assert.equal(card.footerPadding, natural.footerPadding,
        `${label}: ${card.id} does not stretch its footer`);
      assert.ok(Math.abs(card.footerInset - natural.footerInset) <= 1,
        `${label}: ${card.id} preserves its footer's bottom inset`);
      assert.equal(card.topPadding, natural.topPadding, `${label}: ${card.id} preserves its top padding`);
    }
    for (const [index, top] of state.actual.headings.entries()) assert.ok(Math.abs(top - state.natural.headings[index]) <= 1,
      `${label}: balancing preserves the Home and Garage heading positions`);
    assert.ok(Math.abs(state.actual.headings[0] - state.actual.headings[1]) <= 1,
      `${label}: the Home and Garage headings share a baseline`);
    assert.deepEqual(state.actual.summaries, state.natural.summaries,
      `${label}: balancing leaves footer title height and padding unchanged`);
  };
  const checkCapacity = (state, label) => {
    checkBounds(state, label);
    const heights = state.natural.columns.map(column => column.height);
    const shorter = heights[0] <= heights[1] ? 0 : 1;
    const capacity = state.natural.cards.filter(card => card.column === shorter)
      .reduce((sum, card) => sum + Math.min(card.slots * 12, card.height * .1), 0);
    const difference = Math.abs(heights[0] - heights[1]);
    assert.equal(state.aligned, capacity > 0 && difference <= capacity,
      `${label}: columns balance only within the available section-gap budget`);
    if (state.aligned) assert.ok(Math.abs(state.actual.columns[0].bottom - state.actual.columns[1].bottom) <= 1,
      `${label}: column bottoms align`);
    else for (const [index, card] of state.actual.cards.entries()) {
      assert.ok(Math.abs(card.height - state.natural.cards[index].height) <= 1,
        `${label}: ${card.id} keeps its natural height`);
      assert.equal(card.gap, state.natural.cards[index].gap,
        `${label}: ${card.id} releases balancing space when the difference is too large`);
    }
    return state;
  };
  const naturalLayout = async label => {
    await settle(label);
    return checkCapacity(await read(), label);
  };
  const aligned = async (label, shorter) => {
    await until(`(() => {
      const state = globalThis.dashboardBalanceSmoke;
      return state.root.classList.contains('columns-aligned')
        && Math.abs(state.columns[0].getBoundingClientRect().bottom - state.columns[1].getBoundingClientRect().bottom) <= 1;
    })()`);
    await settle(label);
    const state = await read();
    checkBounds(state, label);
    assert.ok(Math.abs(state.actual.columns[0].bottom - state.actual.columns[1].bottom) <= 1,
      `${label}: column bottoms align`);
    if (shorter !== undefined) {
      assert.ok(state.actual.columns[shorter].height - state.natural.columns[shorter].height > 1,
        `${label}: the shorter column receives the extra spacing`);
      assert.ok(Math.abs(state.actual.columns[1 - shorter].height - state.natural.columns[1 - shorter].height) <= 1,
        `${label}: the taller column keeps its natural height`);
      assert.ok(state.actual.cards.some((card, index) => card.gap > state.natural.cards[index].gap),
        `${label}: extra room is shared between sections`);
    }
    return state;
  };
  const unaligned = async label => {
    await until("!globalThis.dashboardBalanceSmoke.root.classList.contains('columns-aligned')");
    await settle(label);
    const state = await read();
    checkBounds(state, label);
    assert.ok(Math.abs(state.actual.columns[0].bottom - state.actual.columns[1].bottom) > 100,
      `${label}: large content differences retain different column heights`);
    for (const [index, card] of state.actual.cards.entries()) assert.ok(Math.abs(card.height - state.natural.cards[index].height) <= 1,
      `${label}: ${card.id} returns to its natural height`);
  };

  try {
    const entry = await naturalLayout('Collapsed desktop entry');
    assert.ok(entry.actual.summaries.every(summary => Math.abs(summary.height - entry.actual.summaries[0].height) <= 1),
      'Home equipment, Garage equipment and Connections use matching title heights');
    for (const [difference, shorter, label] of [[24, 0, 'Home and Data grow'], [-24, 1, 'Garage grows']]) {
      await evaluate(`globalThis.dashboardBalanceSmoke.difference(${difference})`);
      await aligned(label, shorter);
    }

    // The tallest column stays unchanged while the other column's content
    // shrinks. Watching only the root would miss this update.
    await evaluate('globalThis.dashboardBalanceSmoke.difference(12, 80)');
    const beforeShrink = await aligned('Before content shrinks', 0);
    await evaluate(`(() => {
      const node = globalThis.dashboardBalanceSmoke.pads[0];
      node.style.paddingBottom = (parseFloat(node.style.paddingBottom) - 6) + 'px';
    })()`);
    const afterShrink = await aligned('Shorter content shrinks while aligned', 0);
    assert.ok(Math.abs(beforeShrink.actual.columns[1].height - afterShrink.actual.columns[1].height) <= 1,
      'Shrinking the shorter column is detected even when the overall dashboard height stays unchanged');
    assert.ok(Math.abs(beforeShrink.natural.columns[0].height - afterShrink.natural.columns[0].height - 6) <= 1,
      'The content shrink is measured independently of the previous balancing space');

    for (const difference of [240, -240]) {
      await evaluate(`globalThis.dashboardBalanceSmoke.difference(${difference})`);
      await unaligned(`Oversized ${difference > 0 ? 'Garage' : 'Home'} column`);
    }
    await evaluate('globalThis.dashboardBalanceSmoke.restorePads()');
    await naturalLayout('Natural entry is restored');
    await evaluate("document.getElementById('garage-heating-details').open = true");
    await unaligned('Garage heating fold opens');
    await evaluate("document.getElementById('garage-heating-details').open = false");
    await naturalLayout('Garage heating fold closes');

    for (const { id } of entry.actual.summaries) {
      await evaluate(`document.getElementById('${id}').open = true`);
      const opened = await naturalLayout(`${id} opens`);
      assert.deepEqual(opened.actual.summaries, entry.actual.summaries,
        `${id}: opening leaves every footer title height and padding unchanged`);
      await evaluate(`document.getElementById('${id}').open = false`);
      const closed = await naturalLayout(`${id} closes`);
      assert.deepEqual(closed.actual.summaries, entry.actual.summaries,
        `${id}: closing restores content without changing footer title height or padding`);
    }

    // Start with balancing active, then read the first paint after each toggle.
    // An open fold must release old spacing before it can flash on screen.
    await evaluate('globalThis.dashboardBalanceSmoke.difference(-24)');
    await aligned('Before rapid footer toggles', 1);
    for (let index = 0; index < 6; index++) {
      const frame = await evaluate(`new Promise(resolve => {
        document.getElementById('garage-equipment-details').open = ${index % 2 === 0};
        requestAnimationFrame(() => resolve(${readExpression}));
      })`);
      const state = checkCapacity(frame, `Rapid footer toggle ${index + 1}`);
      assert.deepEqual(state.actual.summaries, entry.actual.summaries,
        'Footer titles retain their height and padding on the first frame after rapid toggles');
    }
    await settle('Rapid footer toggles finish');
    await evaluate('globalThis.dashboardBalanceSmoke.restorePads()');

    // A displayed empty wrapper still occupies a flex-gap position.
    await evaluate(`globalThis.dashboardBalanceSmoke.chargers.replaceChildren();
      globalThis.dashboardBalanceSmoke.difference(-18)`);
    assert.equal(await evaluate("document.querySelector('.garage-chargers').getBoundingClientRect().height"), 0,
      'The empty-charger scenario includes a displayed section with zero height');
    await aligned('Empty Garage charger section', 1);
  } finally {
    await evaluate(`(() => {
      const state = globalThis.dashboardBalanceSmoke;
      state.observer.disconnect();
      state.chargers.replaceChildren(...state.chargerNodes);
      state.restorePads();
      for (const [node, open] of state.folds) node.open = open;
      delete globalThis.dashboardBalanceSmoke;
    })()`);
  }
}
