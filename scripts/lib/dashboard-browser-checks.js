import assert from 'node:assert/strict';

export async function checkDashboardDisclosures({ evaluate, keyPress, until }) {
  const folds = ['home-heat-pump-details', 'garage-heating-details',
    'home-equipment-details', 'garage-equipment-details', 'connections-details', 'learning-panel-details'];
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.controller-column'))
    .map(column => [...column.querySelectorAll(':scope > article')].map(card => card.id))`),
  [['home-control', 'providers-controls'], ['garage-control']],
  'Desktop columns pair Home with Data & settings, with Garage on the right');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#home-control .control-badge > span, #garage-control .control-badge > span')]
    .map(node => node.textContent.trim())`), ['Heat control', 'Mode']);
  assert.equal(await evaluate(`document.getElementById('charging-devices').closest('#garage-control') !== null
    && document.getElementById('charging-devices').closest('details') === null
    && document.querySelectorAll('#garage-equipment-details [id^=charger]').length === 0`), true,
  'Garage chargers remain visible outside the heating and equipment folds without duplicates');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#home-control .home-support > details')].map(node => node.id)`),
    ['home-equipment-details'], 'Sensors & Equipment occupies the Home support area on its own');
  assert.equal(await evaluate("document.querySelector('#fireplace-details, #chart-shortcut') === null"), true,
    'The Home fireplace disclosure and chart shortcut have been replaced');
  assert.equal(await evaluate("document.getElementById('fireplace-dialog').open"), false,
    'The fireplace window starts closed');
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
    const parent = id === 'learning-panel-details' ? 'home-heat-pump-details' : null;
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
  const originalKg = await evaluate("document.getElementById('fireplace-kg').value");
  for (const expanded of [false, true]) {
    await evaluate(`document.getElementById('home-heat-pump-details').open=${expanded};
      document.getElementById('home-equipment-details').open=${expanded};
      document.getElementById('fireplace-shortcut').focus()`);
    await keyPress('Enter');
    await until("document.getElementById('fireplace-dialog').matches(':modal')");
    assert.equal(await evaluate("document.getElementById('fireplace-shortcut').getAttribute('aria-expanded')"), 'true');
    assert.equal(await evaluate("document.getElementById('fireplace-dialog').contains(document.activeElement)"), true,
      'Opening Fireplace moves keyboard focus into the window');
    assert.equal(await evaluate("document.getElementById('fireplace-form').checkVisibility()"), true,
      'Fireplace controls are visible independently of the Home folds');
    assert.deepEqual(await evaluate("['home-heat-pump-details', 'home-equipment-details'].map(id => document.getElementById(id).open)"),
      [expanded, expanded], 'Opening Fireplace preserves the Home and equipment folds');
    await evaluate("document.getElementById('fireplace-kg').value='6'; document.getElementById('fireplace-kg').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.getElementById('fireplace-amount').textContent"), '6 kg');
    if (expanded) {
      await evaluate("document.getElementById('fireplace-close').focus()");
      await keyPress('Enter');
    } else await keyPress('Escape');
    await until("!document.getElementById('fireplace-dialog').open && document.getElementById('fireplace-shortcut').getAttribute('aria-expanded') === 'false'");
    assert.equal(await evaluate("document.getElementById('fireplace-shortcut').getAttribute('aria-expanded')"), 'false');
    assert.equal(await evaluate("document.activeElement === document.getElementById('fireplace-shortcut')"), true,
      'Closing Fireplace restores focus to its Home shortcut');
    await keyPress('Enter');
    await until("document.getElementById('fireplace-dialog').open");
    assert.equal(await evaluate("document.getElementById('fireplace-kg').value"), '6',
      'The selected firewood amount survives closing and reopening the window');
    await keyPress('Escape');
    await until("!document.getElementById('fireplace-dialog').open && document.getElementById('fireplace-shortcut').getAttribute('aria-expanded') === 'false'");
  }
  await evaluate(`document.getElementById('fireplace-kg').value=${JSON.stringify(originalKg)};
    document.getElementById('fireplace-kg').dispatchEvent(new Event('input'));
    document.getElementById('home-heat-pump-details').open=false;
    document.getElementById('home-equipment-details').open=false`);
  for (const [id, fold] of [['garage-chart-shortcut', 'garage-heating-details']]) {
    for (const expanded of [false, true]) {
      await evaluate(`document.getElementById('${fold}').open=${expanded};
        document.getElementById('${id}').focus(); document.getElementById('${id}').click()`);
      await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'");
      assert.equal(await evaluate(`document.getElementById('${fold}').open`), expanded,
        `${id} opens the chart without changing its heating disclosure`);
      assert.equal(await evaluate("document.getElementById('garage-chart-shortcut').getAttribute('aria-expanded')"),
        'true', 'The Garage chart shortcut reflects the open chart');
      await keyPress('Escape');
      assert.equal(await evaluate("document.querySelector('.history-panel').dataset.fullscreen"), 'true',
        'Escape preserves the chart inspection view');
      await evaluate("document.getElementById('chart-fullscreen').focus()");
      await keyPress('Enter');
      await until("document.querySelector('.history-panel').dataset.fullscreen === 'false'");
      assert.equal(await evaluate(`document.activeElement === document.getElementById('${id}')`), true,
        `${id} receives focus when the chart closes`);
      assert.equal(await evaluate("document.getElementById('garage-chart-shortcut').getAttribute('aria-expanded')"),
        'false', 'The Garage chart shortcut reflects the closed chart');
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
    const button = document.getElementById(area === 'home' ? 'fireplace-shortcut' : 'garage-chart-shortcut').getBoundingClientRect();
    return button.left > (card.left + card.right) / 2 && button.top >= card.top
      && button.bottom < card.top + 90 && button.right <= card.right;
  })`), true, `Home Fireplace and Garage chart shortcuts remain at the top right at ${width}px`);
  assert.equal(await evaluate(`(() => {
    const overview = document.querySelector('#home-control .overview-zone');
    const bounds = overview.getBoundingClientRect(), cells = [...overview.children].map(node => node.getBoundingClientRect());
    return cells.length === 3 && cells.every((cell, index) => cell.left >= bounds.left - 1 && cell.right <= bounds.right + 1
      && Math.abs(cell.top - cells[0].top) <= 1 && (index === 0 || cell.left >= cells[index - 1].right));
  })()`), true, `Home aligns the tops of its three overview columns at ${width}px`);
  assert.equal(await evaluate(`(() => {
    const overview = document.querySelector('#garage-control .overview-zone'), bounds = overview.getBoundingClientRect();
    const temperature = overview.querySelector('.overview-reading').getBoundingClientRect();
    const target = overview.querySelector('.overview-request').getBoundingClientRect();
    const doors = overview.querySelector('.overview-doors').getBoundingClientRect();
    const button = document.getElementById('garage-doors-shortcut').getBoundingClientRect();
    return Math.abs(temperature.top-target.top)<=1 && Math.abs(temperature.top-doors.top)<=1
      && temperature.right<=doors.left && doors.right<=target.left
      && temperature.left>=bounds.left-1 && target.right<=bounds.right+1
      && button.width<=120 && button.height>=44 && button.left>=doors.left-1 && button.right<=doors.right+1
      && overview.querySelector('.garage-facade').checkVisibility();
  })()`), true, `Garage keeps a compact permanent facade between its rear sensor and room target at ${width}px`);
  assert.equal(await evaluate(`['indoor', 'outdoor', 'requested', 'price', 'garage-temperature', 'garage-door-summary', 'garage-requested', 'garage-price'].every(id => {
    const value = document.getElementById(id), cell = value.closest('.overview-zone > div').getBoundingClientRect();
    return [...value.querySelectorAll('.status-detail-trigger, .status-detail-label')].every(trigger => {
      const box = trigger.getBoundingClientRect();
      return box.left >= cell.left - 1 && box.right <= cell.right + 1;
    });
  })`), true, `Overview values and explanation buttons stay inside their columns at ${width}px`);
  await checkOverviewTemperatureFit({ evaluate, width });
  await checkDashboardCompactLayout({ evaluate, width });
  const support = await evaluate(`(() => {
    const root = document.querySelector('#home-control .home-support');
    const bounds = root.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, border: getComputedStyle(root).borderTopWidth,
      items: [...root.children].map(node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          border: getComputedStyle(node).borderTopWidth };
      }) };
  })()`);
  const [equipment] = support.items;
  assert.equal(support.items.length, 1);
  assert.ok(Math.abs(equipment.left - support.left) <= 1 && Math.abs(equipment.right - support.right) <= 1,
    `Closed Sensors & Equipment fills the Home support width at ${width}px`);
  assert.deepEqual([support.border, equipment.border], ['1px', '0px'],
    `Home support has one consistent divider at ${width}px`);
  assert.equal(await evaluate(`['home-equipment-details', 'garage-equipment-details', 'connections-details'].every(id => {
    const summary = document.querySelector('#' + id + ' > summary');
    const meta = summary.querySelector(':scope > small');
    const card = summary.closest('.panel'), cardStyle = getComputedStyle(card);
    const contentWidth = card.clientWidth - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight);
    const title = summary.querySelector(':scope > span').getBoundingClientRect();
    const bounds = summary.getBoundingClientRect(), box = meta.getBoundingClientRect();
    if (contentWidth <= 420) return Math.abs(box.left - title.left) <= 1 && box.top >= title.bottom
      && box.right <= bounds.right - 1 && box.height >= parseFloat(getComputedStyle(meta).lineHeight);
    if (!meta.textContent.trim()) return true;
    return box.left >= title.right - 1 && box.right <= bounds.right - 1
      && box.top < title.bottom && title.top < box.bottom;
  })`), true, `Equipment and Connections stack supporting text in narrow cards and keep it beside the title in wide cards at ${width}px`);
  await checkProviderLayout({ evaluate, width });
  for (const id of ['home-equipment-details']) {
    await evaluate(`document.querySelector('#${id} > summary').click()`);
    assert.equal(await evaluate(`(() => {
      const root = document.querySelector('#home-control .home-support'), bounds = root.getBoundingClientRect();
      const open = document.getElementById('${id}'), box = open.getBoundingClientRect();
      return open.open && Math.abs(box.left - bounds.left) <= 1 && Math.abs(box.right - bounds.right) <= 1
        && document.documentElement.scrollWidth <= innerWidth;
    })()`), true, `${id} expands to the full Home width without overflow at ${width}px`);
    await evaluate(`document.querySelector('#${id} > summary').click()`);
  }
  await evaluate("document.getElementById('fireplace-shortcut').click()");
  assert.equal(await evaluate(`(() => {
    const dialog = document.getElementById('fireplace-dialog'), bounds = dialog.getBoundingClientRect();
    return dialog.matches(':modal') && bounds.left >= 0 && bounds.right <= innerWidth
      && bounds.top >= 0 && bounds.bottom <= innerHeight
      && dialog.scrollWidth <= dialog.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  })()`), true, `Fireplace window stays inside the viewport without horizontal overflow at ${width}px`);
  await evaluate("document.getElementById('fireplace-close').click()");
}

/** Exercise the widest available readings without changing fixture evidence or controls. */
export async function checkOverviewTemperatureFit({ evaluate, width }) {
  const layout = await evaluate(`(() => {
    const values = ['indoor', 'outdoor', 'garage-temperature', 'garage-requested'].map(id => {
      const value = document.getElementById(id), label = value.querySelector('.status-detail-label') ?? value;
      return { id, value, label, children: [...label.childNodes], unavailable: value.classList.contains('metric-unavailable') };
    });
    const bounds = node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
    };
    const textBounds = node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width,
        lines: range.getClientRects().length };
    };
    try {
      // Measuring each digit in the actual rendered font proves the two-digit
      // extrema cover every one-decimal reading, without enumerating the range.
      const digits = values.map(({ id, value, label }) => {
        value.classList.remove('metric-unavailable');
        const widths = [...'0123456789'].map(digit => {
          label.textContent = '-' + digit + digit + '.' + digit + ' °C';
          return textBounds(label).width;
        });
        return { id, widths };
      });
      const samples = ['-99.9 °C', '99.9 °C'].map(text => {
        for (const { label } of values) label.textContent = text;
        const indoor = document.getElementById('indoor'), outdoor = document.getElementById('outdoor');
        const indoorText = textBounds(values.find(value => value.id === 'indoor').label);
        const intersectingPaths = [...document.querySelectorAll('.home-facade-building path')].flatMap(path => {
          const length = path.getTotalLength(), matrix = path.getScreenCTM();
          // Test the drawn outline in screen coordinates, independently of its
          // SVG dimensions or the responsive CSS used to position the house.
          const steps = Math.ceil(length * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) * 2);
          for (let step = 0; step <= steps; step++) {
            const point = path.getPointAtLength(length * step / Math.max(steps, 1)).matrixTransform(matrix);
            if (point.x >= indoorText.left - 1 && point.x <= indoorText.right + 1
              && point.y >= indoorText.top - 1 && point.y <= indoorText.bottom + 1) return [{
                path: path.getAttribute('class'), x: point.x, y: point.y, text: indoorText }];
          }
          return [];
        });
        const font = node => {
          const style = getComputedStyle(node);
          return [style.fontSize, style.lineHeight, style.letterSpacing];
        };
        return { text,
          values: values.map(({ id, value, label }) => ({ id, text: textBounds(label),
            trigger: bounds(value.querySelector('.status-detail-trigger') ?? value),
            column: bounds(value.closest('.overview-zone > div')) })),
          indoorFont: font(indoor), outdoorFont: font(outdoor),
          walls: bounds(document.querySelector('.home-facade-wall')),
          intersectingPaths,
          indoorNoteGap: document.querySelector('.overview-indoor > .overview-note').getBoundingClientRect().top
            - indoor.getBoundingClientRect().bottom,
          homeColumns: [...document.querySelector('#home-control .overview-zone').children].map(bounds),
          viewportFits: document.documentElement.scrollWidth <= innerWidth };
      });
      return { digits, samples };
    } finally {
      for (const { value, label, children, unavailable } of values) {
        label.replaceChildren(...children);
        value.classList.toggle('metric-unavailable', unavailable);
      }
    }
  })()`);
  for (const { id, widths } of layout.digits) {
    assert.ok(Math.max(...widths) - Math.min(...widths) <= .1,
      `${id} uses equally wide rendered digits at ${width}px`);
  }
  for (const sample of layout.samples) {
    for (const { id, text, trigger, column } of sample.values) {
      assert.ok(text.lines === 1 && text.left >= column.left - .5 && text.right <= column.right + .5
        && trigger.left >= column.left - .5 && trigger.right <= column.right + .5,
      `${id} fits ${sample.text} on one line inside its column at ${width}px: ${JSON.stringify({ text, trigger, column })}`);
    }
    const indoor = sample.values.find(value => value.id === 'indoor').text;
    assert.ok(indoor.left >= sample.walls.left + 1 && indoor.right <= sample.walls.right - 1
      && indoor.top >= sample.walls.top && indoor.bottom <= sample.walls.bottom,
    `Indoor ${sample.text} fits inside the exterior walls at ${width}px: ${JSON.stringify({ indoor, walls: sample.walls })}`);
    assert.deepEqual(sample.intersectingPaths, [],
      `The house outline and upper window leave ${sample.text} unobstructed at ${width}px`);
    assert.deepEqual(sample.indoorFont, sample.outdoorFont,
      `Indoor preserves the original overview temperature typography at ${width}px`);
    assert.ok(Math.abs(sample.indoorNoteGap - 5) <= .5,
      `Indoor average follows the temperature with its natural 5px gap at ${width}px`);
    assert.ok(sample.homeColumns.every(column => Math.abs(column.top - sample.homeColumns[0].top) <= 1),
      `The three Home items align at the top for ${sample.text} at ${width}px`);
    assert.equal(sample.viewportFits, true, `The ${sample.text} overview fits the ${width}px viewport`);
  }
  // Restoring the real readings can schedule the overview observer after these
  // temporary width probes. Let its shared height settle before other checks.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
}

export async function checkDashboardCompactLayout({ evaluate, width }) {
  const layout = await evaluate(`(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const textBaseline = selector => {
      const root = document.querySelector(selector);
      const label = root.querySelector('.status-detail-label') ?? root;
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline';
      label.append(marker);
      try { return marker.getBoundingClientRect().top; } finally { marker.remove(); }
    };
    const outdoor = box('#outdoor'), indoor = box('#indoor'), garage = box('#garage-temperature');
    const homeHeading = box('#control-title'), garageHeading = box('#garage-title');
    const plan = box('#home-planned-change'), explore = box('.home-plan-open');
    const overviews = ['home', 'garage'].map(area => {
      const root = document.querySelector('#' + area + '-control .overview-space');
      const wrapper = root.getBoundingClientRect();
      const overview = root.querySelector('.home-overview').getBoundingClientRect();
      const temperature = box(area === 'home' ? '#outdoor' : '#garage-temperature');
      const request = box(area === 'home' ? '#requested' : '#garage-requested');
      const caption = root.querySelector('.overview-reading > .overview-note:not([id])').getBoundingClientRect();
      const priceLabel = box(area === 'home' ? '#price-label' : '#garage-price-label');
      const next = box(area === 'home' ? '#home-planned-change' : '#charging-devices > details');
      const naturalBottom = Math.max(...[...root.children].filter(node => node.checkVisibility())
        .map(node => node.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(node).marginBottom) || 0)));
      return { area, height: wrapper.height, naturalHeight: naturalBottom - wrapper.top,
        nextBlockAdjacent: area === 'home' || !document.getElementById('garage-heating-details').open,
        valueBottomDifference: Math.abs(temperature.bottom - request.bottom),
        textBaselineDifference: Math.abs(textBaseline(area === 'home' ? '#outdoor' : '#garage-temperature')
          - textBaseline(area === 'home' ? '#requested' : '#garage-requested')),
        captionTopDifference: Math.abs(caption.top - priceLabel.top),
        nextGap: next.top - wrapper.bottom, overviewTop: overview.top };
    });
    const chargerBottom = Math.max(...[...document.querySelectorAll('#charging-devices > details')]
      .map(node => node.getBoundingClientRect().bottom));
    return { homeReadingsAligned: Math.abs(indoor.top - outdoor.top) <= 1,
      temperatureRowDifference: Math.abs((outdoor.top - homeHeading.top) - (garage.top - garageHeading.top)),
      absoluteTemperatureDifference: Math.abs(outdoor.top - garage.top),
      exploreCenterDifference: Math.abs((explore.top + explore.bottom - plan.top - plan.bottom) / 2),
      chargerFooterGap: box('#garage-equipment-details').top - chargerBottom, overviews,
      middleItems: ['home', 'garage'].map(area => {
        const overview = document.querySelector('#' + area + '-control .overview-zone');
        const left = overview.querySelector('.overview-reading').getBoundingClientRect();
        const right = overview.querySelector('.overview-request').getBoundingClientRect();
        const visual = overview.querySelector(area === 'home' ? '.home-facade' : '.garage-facade').getBoundingClientRect();
        const center = (visual.left + visual.right) / 2;
        return { area, midpointDifference: Math.abs(center - (left.right + right.left) / 2),
          relativeCenter: center - box('#' + area + '-control').left };
      }) };
  })()`);
  assert.equal(layout.homeReadingsAligned, true, `${width}px: Home temperatures share a row`);
  assert.ok(layout.temperatureRowDifference <= 1,
    `${width}px: Home and Garage temperatures use the same offset below their headings (${layout.temperatureRowDifference}px)`);
  if (width > 800) assert.ok(layout.absoluteTemperatureDifference <= 1,
    `${width}px: Home outdoor and Garage temperature rows align (${layout.absoluteTemperatureDifference}px)`);
  assert.ok(layout.exploreCenterDifference <= 1,
    `${width}px: Explore is vertically centered in the heating plan (${layout.exploreCenterDifference}px)`);
  assert.ok(Math.abs(layout.chargerFooterGap - 14) <= 1,
    `${width}px: Garage keeps its natural 14px gap below the chargers (${layout.chargerFooterGap}px)`);
  for (const overview of layout.overviews) {
    assert.ok(overview.valueBottomDifference <= 1,
      `${width}px: ${overview.area} request and temperature values share a row (${overview.valueBottomDifference}px)`);
    assert.ok(overview.textBaselineDifference <= 1,
      `${width}px: ${overview.area} request and temperature text share a baseline (${overview.textBaselineDifference}px)`);
    assert.ok(overview.captionTopDifference <= 1,
      `${width}px: ${overview.area} All-in price aligns with the reading caption (${overview.captionTopDifference}px)`);
    const needed = width > 800 ? Math.max(...layout.overviews.map(row => row.naturalHeight)) : overview.naturalHeight;
    assert.ok(Math.abs(overview.height - needed) <= 1,
      `${width}px: ${overview.area} overview reserves only the current content height (${overview.height}px, needed ${needed}px)`);
    if (overview.nextBlockAdjacent) assert.ok(Math.abs(overview.nextGap - 16) <= 1,
      `${width}px: ${overview.area} keeps a compact 16px gap before its next block (${overview.nextGap}px)`);
  }
  if (width > 800) {
    assert.ok(Math.abs(layout.overviews[0].height - layout.overviews[1].height) <= 1,
      `${width}px: desktop Home and Garage share the taller natural overview height`);
  }
  for (const item of layout.middleItems) assert.ok(item.midpointDifference <= 1,
    `${width}px: ${item.area} facade sits midway between its outer reading groups (${item.midpointDifference}px)`);
  assert.ok(Math.abs(layout.middleItems[0].relativeCenter - layout.middleItems[1].relativeCenter) <= 1,
    `${width}px: Home and Garage facades share a horizontal position within their cards`);
}

export async function checkHomeRoofHeaderClearance({ evaluate, width, scenario = 'normal' }) {
  const intersections = await evaluate(`(() => {
    const controls = [...document.querySelectorAll('#control-title, #home-control .home-heading-actions > *')]
      .map(node => ({ name: node.id || node.className, bounds: node.getBoundingClientRect() }));
    return [...document.querySelectorAll('.home-facade-roof')].flatMap(path => {
      const length = path.getTotalLength(), matrix = path.getScreenCTM();
      const steps = Math.ceil(length * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) * 2);
      for (let step = 0; step <= steps; step++) {
        const point = path.getPointAtLength(length * step / Math.max(steps, 1)).matrixTransform(matrix);
        const control = controls.find(({ bounds }) => point.x >= bounds.left - 1 && point.x <= bounds.right + 1
          && point.y >= bounds.top - 1 && point.y <= bounds.bottom + 1);
        if (control) return [{ control: control.name, x: point.x, y: point.y }];
      }
      return [];
    });
  })()`);
  assert.deepEqual(intersections, [], `${width}px ${scenario}: the drawn Home roof clears the title and header controls`);
}

export async function checkProviderLayout({ evaluate, width }) {
  const headings = await evaluate(`(() => [...document.querySelectorAll('#providers .provider-heading')].map(heading => {
    const bounds = heading.getBoundingClientRect();
    const title = heading.querySelector('.provider-category-title').getBoundingClientRect();
    const state = heading.querySelector('.provider-category-state').getBoundingClientRect();
    const source = heading.querySelector('.provider-category-meta').getBoundingClientRect();
    return { title: heading.querySelector('.provider-category-title').textContent,
      aligned: state.top >= title.bottom - 1 && source.top >= state.bottom - 1
        && source.left >= state.left && source.left < state.right,
      contained: title.left >= bounds.left - 1 && source.right <= bounds.right + 1
        && state.left >= bounds.left - 1 && state.right <= bounds.right + 1 };
  }))()`);
  for (const heading of headings) {
    assert.equal(heading.aligned && heading.contained, true,
      `${heading.title} keeps source names beneath availability at ${width}px`);
  }
}
