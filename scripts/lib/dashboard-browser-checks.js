import assert from 'node:assert/strict';

export async function checkDashboardDisclosures({ evaluate, keyPress, until }) {
  const folds = ['home-heat-pump-details', 'garage-heating-details', 'fireplace-details',
    'home-equipment-details', 'garage-equipment-details', 'learning-panel-details', 'garage-learning-details'];
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.controller-column'))
    .map(column => [...column.querySelectorAll(':scope > article')].map(card => card.id))`),
  [['home-control', 'providers-controls'], ['garage-control', 'house-model']],
  'Desktop columns pair Home with Data & settings, and Garage with Learning models');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#home-control .control-badge > span, #garage-control .control-badge > span')]
    .map(node => node.textContent.trim())`), ['Heat control', 'Heat control']);
  assert.equal(await evaluate(`document.getElementById('charging-devices').closest('#garage-control') !== null
    && document.getElementById('charging-devices').closest('details') === null
    && document.querySelectorAll('#garage-equipment-details [id^=charger]').length === 0`), true,
  'Garage chargers remain visible outside the heating and equipment folds without duplicates');
  assert.deepEqual(await evaluate(`${JSON.stringify(folds)}.map(id => document.getElementById(id).open)`),
    folds.map(() => false), 'The dashboard folds start closed');
  for (const id of folds) {
    await evaluate(`document.querySelector('#${id} > summary').focus()`);
    await keyPress('Enter');
    assert.deepEqual(await evaluate(`${JSON.stringify(folds)}.map(id => document.getElementById(id).open)`),
      folds.map(fold => fold === id), `${id} opens independently with Enter`);
    if (id === 'home-heat-pump-details' || id === 'garage-heating-details') {
      const area = id === 'home-heat-pump-details' ? 'home' : 'garage';
      assert.equal(await evaluate(`document.getElementById('${area}-manual-controls').checkVisibility()`), true,
        `${area} heating configuration is visible in the top fold`);
    }
    await keyPress(' ');
    assert.equal(await evaluate(`document.getElementById('${id}').open`), false, `${id} closes with Space`);
  }
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
  const cards = await evaluate(`['home-control', 'garage-control', 'providers-controls', 'house-model'].map(id => {
    const box = document.getElementById(id).getBoundingClientRect();
    return { id, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  })`);
  const [home, garage, data, learning] = cards;
  if (width > 800) {
    assert.ok(Math.abs(home.top - garage.top) <= 1 && home.right < garage.left,
      'Desktop places Home at the upper left and Garage at the upper right');
    assert.ok(data.top > home.bottom && Math.abs(data.left - home.left) <= 1,
      'Desktop places Data & settings beneath Home');
    assert.ok(learning.top > garage.bottom && Math.abs(learning.left - garage.left) <= 1,
      'Desktop places Learning models beneath Garage');
  } else {
    assert.deepEqual(cards.slice().sort((first, second) => first.top - second.top).map(card => card.id),
      ['home-control', 'garage-control', 'providers-controls', 'house-model'],
      `The ${width}px mobile layout orders Home, Garage, Data & settings, Learning models`);
    assert.ok(cards.every((card, index) => index === 0 || card.top > cards[index - 1].bottom),
      'Mobile cards remain in separate rows');
  }
  assert.equal(await evaluate(`['home', 'garage'].every(area => {
    const card = document.getElementById(area + '-control').getBoundingClientRect();
    const button = document.getElementById(area === 'home' ? 'chart-shortcut' : 'garage-chart-shortcut').getBoundingClientRect();
    return button.left > (card.left + card.right) / 2 && button.top >= card.top
      && button.bottom < card.top + 90 && button.right <= card.right;
  })`), true, `Both chart shortcuts remain at the top right at ${width}px`);
}
