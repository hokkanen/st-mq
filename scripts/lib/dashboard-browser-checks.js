import assert from 'node:assert/strict';

export async function checkDashboardDisclosures({ evaluate, keyPress, until }) {
  const folds = ['home-heat-pump-details', 'garage-heating-details', 'fireplace-details',
    'home-equipment-details', 'garage-equipment-details', 'connections-details', 'learning-panel-details', 'garage-learning-details'];
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.controller-column'))
    .map(column => [...column.querySelectorAll(':scope > article')].map(card => card.id))`),
  [['home-control', 'providers-controls'], ['garage-control']],
  'Desktop columns pair Home with Data & settings, with Garage on the right');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#home-control .control-badge > span, #garage-control .control-badge > span')]
    .map(node => node.textContent.trim())`), ['Heat control', 'Heat control']);
  assert.equal(await evaluate(`document.getElementById('charging-devices').closest('#garage-control') !== null
    && document.getElementById('charging-devices').closest('details') === null
    && document.querySelectorAll('#garage-equipment-details [id^=charger]').length === 0`), true,
  'Garage chargers remain visible outside the heating and equipment folds without duplicates');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#home-control .home-support > details')].map(node => node.id)`),
    ['home-equipment-details', 'fireplace-details'], 'Home equipment and fireplace are sibling disclosures below the overview');
  assert.equal(await evaluate(`['outdoor', 'outdoor-age'].every(id => document.querySelector('#home-heat-pump-details > summary .overview-zone').contains(document.getElementById(id)))
    && ['home', 'garage'].every(area => {
      const prefix = area === 'home' ? '' : 'garage-';
      const request = document.querySelector('#' + area + '-control .overview-request');
      return ['price-label', 'price', 'price-unit'].every(suffix => {
        const id = prefix + suffix;
        return request.contains(document.getElementById(id)) && document.querySelectorAll('#' + id).length === 1;
      });
    })`), true,
  'Outdoor stays in the Home overview and each heating request contains its own all-in electricity price');
  assert.deepEqual(await evaluate(`${JSON.stringify(folds)}.map(id => document.getElementById(id).open)`),
    folds.map(() => false), 'The dashboard folds start closed');
  assert.equal(await evaluate(`(() => {
    const summaries = document.querySelectorAll('.controller-panels .dashboard-disclosure > summary, #providers .provider-fold > summary');
    return summaries.length > 0 && [...summaries].every(summary => {
      const marker = summary.querySelector('.zone-expand');
      return getComputedStyle(marker ?? summary, marker ? '::before' : '::after').content.includes('›');
    });
  })()`), true, 'Main dashboard and provider folds use arrow markers');
  for (const id of folds) {
    const parent = id === 'learning-panel-details' ? 'home-heat-pump-details'
      : id === 'garage-learning-details' ? 'garage-heating-details' : null;
    if (parent) await evaluate(`document.getElementById('${parent}').open=true`);
    await evaluate(`document.querySelector('#${id} > summary').focus()`);
    await keyPress('Enter');
    assert.deepEqual(await evaluate(`${JSON.stringify(folds)}.map(id => document.getElementById(id).open)`),
      folds.map(fold => fold === id || fold === parent), `${id} opens independently with Enter`);
    assert.equal(await evaluate(`(() => {
      const summary = document.querySelector('#${id} > summary'), marker = summary.querySelector('.zone-expand');
      return getComputedStyle(marker ?? summary, marker ? '::before' : '::after').transform !== 'none';
    })()`), true, `${id} rotates its arrow when expanded`);
    if (id === 'home-heat-pump-details' || id === 'garage-heating-details') {
      const area = id === 'home-heat-pump-details' ? 'home' : 'garage';
      assert.equal(await evaluate(`document.getElementById('${area}-manual-controls').checkVisibility()`), true,
        `${area} heating configuration is visible in the top fold`);
    }
    await keyPress(' ');
    assert.equal(await evaluate(`document.getElementById('${id}').open`), false, `${id} closes with Space`);
    if (parent) await evaluate(`document.getElementById('${parent}').open=false`);
  }
  for (const [metric, fold] of [['outdoor', 'home-heat-pump-details'], ['price', 'home-heat-pump-details'],
    ['requested', 'home-heat-pump-details'], ['garage-price', 'garage-heating-details'], ['garage-requested', 'garage-heating-details']]) {
    for (const expanded of [false, true]) {
      await evaluate(`document.getElementById('${fold}').open=${expanded};
        document.querySelector('#${metric} .status-detail-trigger').focus()`);
      await keyPress('Enter');
      assert.equal(await evaluate(`document.querySelector('#${metric} .status-detail-trigger').getAttribute('aria-expanded')`), 'true',
        `${metric} explanation opens from the compact overview with Enter`);
      assert.equal(await evaluate(`document.getElementById('${fold}').open`), expanded,
        `${metric} explanation leaves its heating disclosure unchanged`);
      await keyPress('Escape');
      assert.equal(await evaluate(`document.activeElement === document.querySelector('#${metric} .status-detail-trigger')`), true,
        `${metric} receives focus when its explanation closes`);
    }
    await evaluate(`document.getElementById('${fold}').open=false`);
  }
  await evaluate("document.querySelector('#home-equipment-details > summary').click(); document.querySelector('#fireplace-details > summary').click()");
  assert.equal(await evaluate("document.getElementById('home-equipment-details').open && document.getElementById('fireplace-details').open && document.getElementById('fireplace-form').checkVisibility()"), true,
    'Equipment and fireplace can remain open together');
  await evaluate("document.querySelector('#home-equipment-details > summary').click()");
  assert.equal(await evaluate("document.getElementById('fireplace-details').open && document.getElementById('fireplace-form').checkVisibility()"), true,
    'Closing equipment leaves the fireplace and its form open');
  await evaluate("document.querySelector('#fireplace-details > summary').click()");
  for (const [id, fold] of [['chart-shortcut', 'home-heat-pump-details'], ['garage-chart-shortcut', 'garage-heating-details']]) {
    for (const expanded of [false, true]) {
      await evaluate(`document.getElementById('${fold}').open=${expanded};
        document.getElementById('${id}').focus(); document.getElementById('${id}').click()`);
      await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'");
      assert.equal(await evaluate(`document.getElementById('${fold}').open`), expanded,
        `${id} opens the chart without changing its heating disclosure`);
      assert.deepEqual(await evaluate("['chart-shortcut', 'garage-chart-shortcut'].map(id => document.getElementById(id).getAttribute('aria-expanded'))"),
        ['true', 'true'], 'Both chart shortcuts reflect the open chart');
      await keyPress('Escape');
      await until("document.querySelector('.history-panel').dataset.fullscreen === 'false'");
      assert.equal(await evaluate(`document.activeElement === document.getElementById('${id}')`), true,
        `${id} receives focus when the chart closes`);
      assert.deepEqual(await evaluate("['chart-shortcut', 'garage-chart-shortcut'].map(id => document.getElementById(id).getAttribute('aria-expanded'))"),
        ['false', 'false'], 'Both chart shortcuts reflect the closed chart');
    }
    await evaluate(`document.getElementById('${fold}').open=false`);
  }
}

export async function checkDashboardLayout({ evaluate, width }) {
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true,
    `Dashboard fits the ${width}px viewport`);
  const cards = await evaluate(`['home-control', 'garage-control', 'providers-controls'].map(id => {
    const box = document.getElementById(id).getBoundingClientRect();
    return { id, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  })`);
  const [home, garage, data] = cards;
  if (width > 800) {
    assert.ok(Math.abs(home.top - garage.top) <= 1 && home.right < garage.left,
      'Desktop places Home at the upper left and Garage at the upper right');
    assert.ok(data.top > home.bottom && Math.abs(data.left - home.left) <= 1,
      'Desktop places Data & settings beneath Home');
  } else {
    assert.deepEqual(cards.slice().sort((first, second) => first.top - second.top).map(card => card.id),
      ['home-control', 'garage-control', 'providers-controls'],
      `The ${width}px mobile layout orders Home, Garage, Data & settings`);
    assert.ok(cards.every((card, index) => index === 0 || card.top > cards[index - 1].bottom),
      'Mobile cards remain in separate rows');
  }
  assert.equal(await evaluate(`['home', 'garage'].every(area => {
    const card = document.getElementById(area + '-control').getBoundingClientRect();
    const button = document.getElementById(area === 'home' ? 'chart-shortcut' : 'garage-chart-shortcut').getBoundingClientRect();
    return button.left > (card.left + card.right) / 2 && button.top >= card.top
      && button.bottom < card.top + 90 && button.right <= card.right;
  })`), true, `Both chart shortcuts remain at the top right at ${width}px`);
  assert.equal(await evaluate(`['home', 'garage'].every(area => {
    const overview = document.querySelector('#' + area + '-control .overview-zone');
    const bounds = overview.getBoundingClientRect(), cells = [...overview.children].map(node => node.getBoundingClientRect());
    return cells.length === 3 && cells.every((cell, index) => cell.left >= bounds.left - 1 && cell.right <= bounds.right + 1
      && Math.abs(cell.top - cells[0].top) <= 1 && (index === 0 || cell.left >= cells[index - 1].right));
  })`), true, `Home and Garage retain three aligned overview columns at ${width}px`);
  assert.equal(await evaluate(`['indoor', 'outdoor', 'requested', 'price', 'garage-temperature', 'garage-door-summary', 'garage-requested', 'garage-price'].every(id => {
    const value = document.getElementById(id), cell = value.closest('.overview-zone > div').getBoundingClientRect();
    return [...value.querySelectorAll('.status-detail-trigger, .status-detail-label')].every(trigger => {
      const box = trigger.getBoundingClientRect();
      return box.left >= cell.left - 1 && box.right <= cell.right + 1;
    });
  })`), true, `Overview values and explanation buttons stay inside their columns at ${width}px`);
  const support = await evaluate(`(() => {
    const root = document.querySelector('#home-control .home-support');
    return { width: root.getBoundingClientRect().width, border: getComputedStyle(root).borderTopWidth,
      items: [...root.children].map(node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          border: getComputedStyle(node).borderTopWidth };
      }) };
  })()`);
  const [equipment, fireplace] = support.items;
  assert.equal(support.items.length, 2);
  if (support.width > 360) {
    assert.ok(Math.abs(equipment.top - fireplace.top) <= 1 && equipment.right < fireplace.left,
      `Closed Home equipment and fireplace sit side by side at ${width}px`);
  } else {
    assert.ok(fireplace.top > equipment.bottom && Math.abs(equipment.left - fireplace.left) <= 1,
      `Closed Home equipment and fireplace use separate rows in the narrow ${width}px layout`);
  }
  assert.deepEqual([support.border, equipment.border, fireplace.border], ['1px', '0px', support.width > 360 ? '0px' : '1px'],
    `Home support has one consistent divider without a doubled Fireplace border at ${width}px`);
  assert.equal(await evaluate(`['home-equipment-details', 'fireplace-details', 'garage-equipment-details', 'connections-details'].every(id => {
    const summary = document.querySelector('#' + id + ' > summary');
    const meta = summary.querySelector(':scope > small');
    if (!meta?.textContent.trim()) return true;
    const title = summary.querySelector(':scope > span').getBoundingClientRect();
    const bounds = summary.getBoundingClientRect(), box = meta.getBoundingClientRect();
    return box.left >= title.right - 1 && box.right <= bounds.right - 1
      && box.top < title.bottom && title.top < box.bottom;
  })`), true, `Equipment, Fireplace and Connections keep their supporting text beside the title at ${width}px`);
  await checkProviderLayout({ evaluate, width });
  for (const id of ['home-equipment-details', 'fireplace-details']) {
    await evaluate(`document.querySelector('#${id} > summary').click()`);
    assert.equal(await evaluate(`(() => {
      const root = document.querySelector('#home-control .home-support'), bounds = root.getBoundingClientRect();
      const open = document.getElementById('${id}'), box = open.getBoundingClientRect();
      return open.open && Math.abs(box.left - bounds.left) <= 1 && Math.abs(box.right - bounds.right) <= 1
        && document.documentElement.scrollWidth <= innerWidth;
    })()`), true, `${id} expands to the full Home width without overflow at ${width}px`);
    await evaluate(`document.querySelector('#${id} > summary').click()`);
  }
}

export async function checkProviderLayout({ evaluate, width }) {
  const headings = await evaluate(`(() => [...document.querySelectorAll('#providers .provider-heading')].map(heading => {
    const bounds = heading.getBoundingClientRect();
    const title = heading.querySelector('.provider-category-title').getBoundingClientRect();
    const state = heading.querySelector('.provider-category-state').getBoundingClientRect();
    const source = heading.querySelector('.provider-category-meta').getBoundingClientRect();
    return { title: heading.querySelector('.provider-category-title').textContent,
      aligned: state.top >= title.bottom - 1 && source.top >= title.bottom - 1
        && state.right <= source.left + 1 && state.top < source.bottom && source.top < state.bottom,
      contained: title.left >= bounds.left - 1 && source.right <= bounds.right + 1
        && state.left >= bounds.left - 1 && state.right <= bounds.right + 1 };
  }))()`);
  for (const heading of headings) {
    assert.equal(heading.aligned && heading.contained, true,
      `${heading.title} keeps availability left and sources right beneath its title at ${width}px`);
  }
}
