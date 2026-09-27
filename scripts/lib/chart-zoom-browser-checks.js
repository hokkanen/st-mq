import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

// Exercises the shipped chart against the smoke harness's isolated simulation.
// Screenshots and browser instrumentation contain invented fixture data only.
export async function checkChartZoomBrowser({ evaluate, command, context, until }) {
  const canvas = "document.getElementById('history')";
  const fullscreen = "document.querySelector('.history-panel').dataset.fullscreen === 'true'";
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click(); true`);
  const selectView = view => evaluate(`document.getElementById('chart-series-toggle').click();
    document.getElementById('chart-series-mode-views').click();
    document.getElementById('chart-series-search').value='';
    document.getElementById('chart-series-search').dispatchEvent(new Event('input'));
    document.querySelector('#chart-series [data-view-key="${view}"]').click(); true`);
  const key = value => evaluate(`(() => { const canvas = document.getElementById('history'); canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, bubbles: true, cancelable: true })); return true; })()`);
  const state = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
    const data = ${canvas}.dataset;
    return { from: Number(data.viewFrom), to: Number(data.viewTo),
      selectedFrom: Number(data.selectedFrom), selectedTo: Number(data.selectedTo), zoom: Number(data.zoom),
      dates: ['date-start', 'date-end'].map(id => document.getElementById(id).value),
      rangeStart: data.rangeStart, rangeEnd: data.rangeEnd };
  })())`));
  const checkBounds = (view, selected, description) => {
    assert.ok(Number.isFinite(view.from) && Number.isFinite(view.to) && view.to > view.from, `${description}: finite visible interval`);
    assert.ok(view.from >= selected.selectedFrom - 1 && view.to <= selected.selectedTo + 1,
      `${description}: zoom and pan stay inside the applied dates`);
    for (const key of ['selectedFrom', 'selectedTo', 'dates', 'rangeStart', 'rangeEnd']) {
      assert.deepEqual(view[key], selected[key], `${description}: ${key} remains fixed`);
    }
  };
  const checkSameView = (actual, expected, description) => {
    assert.ok(Math.abs(actual.from - expected.from) <= 2 && Math.abs(actual.to - expected.to) <= 2,
      `${description}: visible interval is preserved`);
    assert.ok(Math.abs(actual.zoom - expected.zoom) < 0.001, `${description}: magnification is preserved`);
  };
  const checkWholeSelection = (view, description) => {
    assert.ok(Math.abs(view.from - view.selectedFrom) <= 2 && Math.abs(view.to - view.selectedTo) <= 2,
      `${description}: overview shows all selected dates`);
    assert.equal(view.zoom, 1, `${description}: baseline magnification`);
  };
  const checkAxisButton = async description => {
    assert.equal(await evaluate(`(() => {
      const axis = document.getElementById('chart-series-toggle').getBoundingClientRect();
      const button = document.getElementById('chart-fullscreen').getBoundingClientRect();
      return axis.width > 0 && button.width > 0 && button.left >= axis.right
        && button.left - axis.right <= 14 && Math.abs(axis.top + axis.height / 2 - button.top - button.height / 2) <= 2
        && button.right <= innerWidth;
    })()`), true, `${description}: fullscreen button sits immediately to the right of the chart selection button`);
  };
  const checkToolbar = async description => {
    await checkAxisButton(description);
    assert.equal(await evaluate(`(() => {
      const heading = document.querySelector('.chart-heading').getBoundingClientRect();
      const dates = ['date-start', 'date-end'].map(id => document.getElementById(id).getBoundingClientRect());
      const exit = document.getElementById('chart-fullscreen').getBoundingClientRect();
      const shortcuts = document.querySelector('.range-shortcuts');
      const wide = innerWidth >= 1000, inlineDates = innerWidth >= 600;
      return dates.every(rect => rect.width > 90 && rect.height >= 32
        && rect.left >= 0 && rect.right <= innerWidth
        && (inlineDates ? Math.abs(rect.top + rect.height / 2 - exit.top - exit.height / 2) <= 2
          : rect.top >= heading.bottom - 1))
        && (wide ? exit.top >= 28 : heading.height <= 70 && exit.right >= innerWidth - 20)
        && shortcuts.checkVisibility() === (innerWidth >= 1120)
        && (!shortcuts.checkVisibility() || [...shortcuts.children].every(button => {
          const rect = button.getBoundingClientRect();
          return rect.left >= dates[1].right && rect.right <= document.querySelector('.chart-axis-actions').getBoundingClientRect().left
            && Math.abs(rect.top + rect.height / 2 - exit.top - exit.height / 2) <= 2;
        }))
        && document.querySelectorAll('[aria-controls=chart-series-picker]').length === 1;
    })()`), true, `${description}: compact inspection controls keep both date pickers usable`);
  };
  const checkFits = async description => {
    assert.equal(await evaluate(`(() => {
      const panel = document.querySelector('.history-panel').getBoundingClientRect();
      const plot = ${canvas}.getBoundingClientRect();
      const exit = document.getElementById('chart-fullscreen').getBoundingClientRect();
      return panel.left >= -1 && panel.top >= -1 && panel.right <= innerWidth + 1 && panel.bottom <= innerHeight + 1
        && plot.width > 150 && plot.height > 80 && plot.left >= 0 && plot.top >= 0
        && plot.right <= innerWidth + 1 && plot.bottom <= innerHeight + 1
        && exit.width > 0 && exit.height > 0 && exit.left >= 0 && exit.top >= 0
        && exit.right <= innerWidth + 1 && exit.bottom <= innerHeight + 1
        && Boolean(document.elementFromPoint(exit.left + exit.width / 2, exit.top + exit.height / 2)?.closest('#chart-fullscreen'));
    })()`), true, `${description}: full plot height, axes and exit fit the viewport`);
  };
  const viewport = async (width, height) => {
    await command('browsingContext.setViewport', { context, viewport: { width, height }, devicePixelRatio: 1 });
    await settle();
  };
  const point = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
    const r = ${canvas}.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width };
  })())`));
  const drag = async (pointerType, distance) => {
    const { x, y } = await point();
    await command('input.performActions', { context, actions: [{ type: 'pointer', id: `chart-${pointerType}`, parameters: { pointerType },
      actions: [{ type: 'pointerMove', x, y, duration: 0 }, { type: 'pointerDown', button: 0 },
        ...[0.25, 0.5, 0.75, 1].map(fraction => ({ type: 'pointerMove', x: x + Math.round(distance * fraction), y, duration: 16 }))] }] });
    await settle();
    assert.equal(await evaluate(`(() => {
      const preview = document.querySelector('.chart-gesture-preview');
      return Boolean(preview && preview.width === ${canvas}.width && preview.height === ${canvas}.height
        && preview.getContext('2d').getImageData(0, 0, preview.width, preview.height).data.some((value, index) => index % 4 === 3 && value > 0));
    })()`), true, `${pointerType} dragging draws immediate visual feedback before release`);
    await command('input.performActions', { context, actions: [{ type: 'pointer', id: `chart-${pointerType}`, parameters: { pointerType },
      actions: [{ type: 'pointerUp', button: 0 }] }] });
    await settle();
  };
  const capture = async name => {
    await until("document.querySelector('.chart-gesture-preview') === null");
    mkdirSync('var', { recursive: true });
    const screenshot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    writeFileSync(`var/home-energy-chart-fullscreen-${name}.png`, Buffer.from(screenshot.data, 'base64'));
  };
  const checkNormal = async description => {
    await until(`!(${fullscreen})`);
    await settle();
    checkWholeSelection(await state(), description);
    await checkAxisButton(description);
    assert.equal(await evaluate(`${canvas}.hasAttribute('tabindex') || ${canvas}.hasAttribute('aria-description')`), false,
      `${description}: the normal canvas has no fullscreen gesture keyboard instructions`);
    assert.equal(await evaluate(`['#chart-overview', '.chart-gesture-help', '#chart-visible-range', '#chart-detail-status']
      .every(selector => [...document.querySelectorAll(selector)].every(node => !node.checkVisibility() && node.getClientRects().length === 0))`), true,
    `${description}: zoom controls, navigator and help add no visible normal-chart layout`);
    await evaluate(`(() => {
      window.chartNormalFixture = { fetch: window.fetch.bind(window), detailRequests: 0 };
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname.endsWith('/api/chart') && url.searchParams.has('viewFrom')) window.chartNormalFixture.detailRequests++;
        return window.chartNormalFixture.fetch(...args);
      };
      const navigator = document.getElementById('chart-navigator');
      navigator.value = navigator.max; navigator.dispatchEvent(new Event('input', { bubbles: true }));
      ${canvas}.focus({ preventScroll: true });
      for (const key of ['+', '=', 'ArrowRight', '-', 'ArrowLeft', 'Home']) {
        ${canvas}.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }
      return true;
    })()`);
    for (const ctrlKey of [false, true]) {
      assert.equal(await evaluate(`(() => {
        const r = ${canvas}.getBoundingClientRect();
        const event = new WheelEvent('wheel', { deltaY: -240, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
        ${canvas}.dispatchEvent(event); return event.defaultPrevented;
      })()`), false, `${description}: ${ctrlKey ? 'Ctrl-wheel' : 'wheel'} is not captured by normal chart zoom`);
    }
    await evaluate(`(() => {
      const r = ${canvas}.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (const [type, id, dx] of [['pointerdown', 101, -30], ['pointerdown', 102, 30],
        ['pointermove', 101, -80], ['pointermove', 102, 80], ['pointerup', 101, -80], ['pointerup', 102, 80]]) {
        ${canvas}.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x + dx,
          clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
      }
      return new Promise(resolve => setTimeout(() => resolve(true), 450));
    })()`);
    checkWholeSelection(await state(), `${description} after attempted interactions`);
    assert.equal(await evaluate("document.querySelector('.chart-gesture-preview') === null"), true,
      `${description}: normal chart does not create a gesture preview`);
    assert.equal(await evaluate('window.chartNormalFixture.detailRequests'), 0,
      `${description}: normal chart never starts refinement requests`);
    await evaluate('window.fetch=window.chartNormalFixture.fetch; delete window.chartNormalFixture; true');
  };
  await until(`${canvas}.dataset.ready === 'true' && Number.isFinite(Number(${canvas}.dataset.viewFrom))`);
  const initial = await state();
  const overflow = await evaluate('document.body.style.overflow');
  const theme = await evaluate('document.documentElement.dataset.theme');
  checkWholeSelection(initial, 'Initial desktop chart');
  await checkNormal('Normal desktop chart');
  await evaluate("document.querySelector('.history-panel').scrollIntoView({ block: 'start' }); true");
  await capture('normal-desktop');
  await evaluate("document.getElementById('chart-fullscreen').focus(); document.getElementById('chart-fullscreen').click(); true");
  await until(fullscreen);
  await settle();
  checkSameView(await state(), initial, 'Entering fullscreen');
  await checkFits('Desktop fullscreen');
  await checkToolbar('Desktop fullscreen');
  await capture('desktop');

  // Hold real detail requests at the browser boundary. Gestures must continue
  // while the response is pending, and an obsolete response must never replace
  // the complete overview while a newer viewport request is still loading.
  await evaluate(`(() => {
    window.chartZoomFixture = { fetch: window.fetch.bind(window), requests: [], release: [] };
    window.fetch = (...args) => {
      const url = new URL(args[0], location.href), fixture = window.chartZoomFixture;
      if (url.pathname.endsWith('/api/chart') && url.searchParams.has('viewFrom')) {
        fixture.requests.push(url.toString());
        return new Promise((resolve, reject) => fixture.release.push(() =>
          fixture.fetch(args[0], { ...args[1], signal: undefined }).then(resolve, reject)));
      }
      return fixture.fetch(...args);
    };
    document.getElementById('history').focus(); for (let i = 0; i < 4; i++) document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    return true;
  })()`);
  await until('window.chartZoomFixture.requests.length === 1');
  assert.equal(await evaluate("document.getElementById('chart-detail-status').dataset.state"), 'loading',
    'Pending refinement announces that detail is loading');
  const waitingView = await state();
  await evaluate("document.getElementById('chart-navigator').value=document.getElementById('chart-navigator').max; document.getElementById('chart-navigator').dispatchEvent(new Event('input', { bubbles: true })); true");
  await settle();
  const movedWhileLoading = await state();
  assert.ok(movedWhileLoading.from > waitingView.from, 'Panning responds while a detail response is held');
  checkBounds(movedWhileLoading, initial, 'Panning during refinement');
  assert.equal(await evaluate('window.chartZoomFixture.requests.length'), 1, 'The chart keeps only one detail request in flight');
  await evaluate('window.chartZoomFixture.release[0]().then(() => true)');
  await until('window.chartZoomFixture.requests.length === 2');
  assert.equal(await evaluate(`Number(${canvas}.dataset.dataFrom)`), initial.selectedFrom,
    'An obsolete detail response does not replace the overview start');
  assert.equal(await evaluate(`Number(${canvas}.dataset.dataTo)`), initial.selectedTo,
    'An obsolete detail response does not replace the overview end');
  checkSameView(await state(), movedWhileLoading, 'Discarding obsolete detail');
  await evaluate('window.chartZoomFixture.release[1]().then(() => true)');
  await until(`document.getElementById('chart-detail-status').dataset.state === 'idle'
    && Number(${canvas}.dataset.dataTo) - Number(${canvas}.dataset.dataFrom) < ${initial.selectedTo - initial.selectedFrom}`);
  const loadedDetail = JSON.parse(await evaluate(`JSON.stringify((() => {
    const requested = new URL(window.chartZoomFixture.requests[1]);
    return { requestedFrom: Number(requested.searchParams.get('viewFrom')), requestedTo: Number(requested.searchParams.get('viewTo')),
      dataFrom: Number(${canvas}.dataset.dataFrom), dataTo: Number(${canvas}.dataset.dataTo),
      start: requested.searchParams.get('start'), end: requested.searchParams.get('end') };
  })())`));
  assert.equal(loadedDetail.dataFrom, loadedDetail.requestedFrom, 'The latest detail start is published');
  assert.equal(loadedDetail.dataTo, loadedDetail.requestedTo, 'The latest detail end is published');
  assert.equal(loadedDetail.start, initial.rangeStart, 'Refinement retains the selected start date');
  assert.equal(loadedDetail.end, initial.rangeEnd, 'Refinement retains the selected end date');
  checkSameView(await state(), movedWhileLoading, 'Publishing finer detail');
  await evaluate('window.fetch=window.chartZoomFixture.fetch; delete window.chartZoomFixture; true');
  await key('Home');
  await settle();
  checkWholeSelection(await state(), 'Reset after asynchronous refinement');

  await key('+');
  await until(`Number(${canvas}.dataset.zoom) > 1`);
  const zoomed = await state();
  assert.ok(zoomed.to - zoomed.from < initial.to - initial.from, 'Keyboard zoom narrows the visible time interval');
  checkBounds(zoomed, initial, 'Keyboard zoom');
  await click('theme-toggle');
  await settle();
  checkSameView(await state(), zoomed, 'Changing theme');
  await click('theme-toggle');
  await evaluate("document.querySelector('[data-chart-key=property_power]').click(); true");
  await settle();
  checkSameView(await state(), zoomed, 'Changing legend visibility');
  await evaluate("document.querySelector('[data-chart-key=property_power]').click(); true");

  // Change axes while a gesture is active, then deliver the older axis last.
  // The plotted axis, legend and data must always belong to the same response.
  await until("document.querySelector('.chart-gesture-preview') === null");
  await evaluate(`(() => {
    window.chartAxisFixture = { fetch: window.fetch.bind(window), integralDone: false };
    window.fetch = (...args) => {
      const url = new URL(args[0], location.href), fixture = window.chartAxisFixture;
      if (url.pathname.endsWith('/api/chart') && !url.searchParams.has('viewFrom')) {
        if (url.searchParams.get('view') === 'phases') return new Promise((resolve, reject) => {
          fixture.release = () => fixture.fetch(args[0], { ...args[1], signal: undefined }).then(resolve, reject);
        });
        if (url.searchParams.get('view') === 'heating_water') return fixture.fetch(...args).then(response => {
          fixture.integralDone = true; return response;
        });
      }
      return fixture.fetch(...args);
    }; return true;
  })()`);
  const axisPoint = await point();
  await command('input.performActions', { context, actions: [{ type: 'pointer', id: 'chart-axis-mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', x: axisPoint.x, y: axisPoint.y, duration: 0 }, { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', x: axisPoint.x + 25, y: axisPoint.y, duration: 16 }] }] });
  const axisView = await state();
  await selectView('phases');
  await until('Boolean(window.chartAxisFixture.release)');
  await selectView('heating_water');
  await until('window.chartAxisFixture.integralDone');
  await settle();
  await command('input.performActions', { context, actions: [{ type: 'pointer', id: 'chart-axis-mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerUp', button: 0 }] }] });
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.view === 'heating_water'
    && Boolean(document.querySelector('[data-chart-key=heating_integral]'))`);
  checkSameView(await state(), axisView, 'Completing an axis change during a gesture');
  await evaluate('window.chartAxisFixture.release().then(() => true)');
  await settle();
  assert.equal(await evaluate(`${canvas}.dataset.view`), 'heating_water', 'An older axis response cannot relabel the latest plotted data');
  assert.equal(await evaluate("Boolean(document.querySelector('[data-chart-key=property_current_l1]'))"), false,
    'The discarded phase response cannot replace the latest legend');
  await evaluate("window.fetch=window.chartAxisFixture.fetch; delete window.chartAxisFixture; true");
  await selectView('power');
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.left === 'power'
    && Boolean(document.querySelector('[data-chart-key=property_power]'))`);
  checkSameView(await state(), axisView, 'Restoring the power axis');

  const mouseBefore = await state();
  await drag('mouse', 80);
  const mouseAfter = await state();
  assert.ok(mouseAfter.from < mouseBefore.from, 'Dragging the desktop chart right reveals earlier data');
  assert.ok(Math.abs((mouseAfter.to - mouseAfter.from) - (mouseBefore.to - mouseBefore.from)) <= 2,
    'Dragging changes position without changing magnification');
  checkBounds(mouseAfter, initial, 'Mouse drag');
  const center = await point();
  await command('input.performActions', { context, actions: [{ type: 'wheel', id: 'chart-wheel',
    actions: [{ type: 'scroll', x: center.x, y: center.y, deltaX: 0, deltaY: -240, duration: 0 }] }] });
  await until(`Number(${canvas}.dataset.zoom) > ${mouseAfter.zoom}`);
  checkBounds(await state(), initial, 'Mouse wheel');

  for (const [value, edge] of [['min', 'from'], ['max', 'to']]) {
    await evaluate(`(() => { const control = document.getElementById('chart-navigator');
      control.value = control.${value}; control.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await settle();
    const view = await state();
    checkBounds(view, initial, `Navigator ${value}`);
    assert.ok(Math.abs(view[edge] - initial[edge === 'from' ? 'selectedFrom' : 'selectedTo']) <= 2,
      `Navigator reaches the ${value === 'min' ? 'first' : 'last'} selected instant`);
    await key(value === 'min' ? 'ArrowLeft' : 'ArrowRight');
    await settle();
    checkSameView(await state(), view, `Panning against the ${value} boundary`);
  }
  await key('Home');
  await settle();
  checkWholeSelection(await state(), 'Desktop reset');
  await key('-');
  await settle();
  checkWholeSelection(await state(), 'Zooming out at the desktop limit');

  await viewport(390, 844);
  await until(`Number(${canvas}.dataset.viewTo) - Number(${canvas}.dataset.viewFrom) < Number(${canvas}.dataset.selectedTo) - Number(${canvas}.dataset.selectedFrom)`);
  const portrait = await state();
  assert.equal(await evaluate("document.getElementById('chart-legend').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), false);
  await click('chart-legend-toggle');
  await settle();
  assert.equal(await evaluate("document.getElementById('chart-legend').checkVisibility()"), true);
  assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), true);
  assert.equal(await evaluate("document.getElementById('chart-activity').checkVisibility()"), false,
    'Expanded legend temporarily replaces activity rows');
  assert.equal(await evaluate("document.getElementById('chart-overview').checkVisibility()"), true,
    'Expanded legend preserves the navigator');
  await checkFits('Portrait with expanded legend');
  await click('chart-legend-toggle');
  await settle();
  assert.equal(await evaluate("document.getElementById('chart-legend').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('chart-activity').checkVisibility()"), true,
    'Closing the legend restores activity rows');

  assert.ok(Math.abs(portrait.zoom - 1) < 0.001, 'Portrait starts at baseline magnification');
  checkBounds(portrait, initial, 'Portrait slice');
  await checkFits('Portrait fullscreen');
  await checkToolbar('Portrait fullscreen', { portrait: true });
  await capture('portrait');
  // Put the slice against the beginning, so a left swipe must be able to reveal
  // later data even though no explicit zoom has occurred.
  await evaluate("document.getElementById('chart-navigator').value=document.getElementById('chart-navigator').min; document.getElementById('chart-navigator').dispatchEvent(new Event('input', { bubbles: true })); true");
  await settle();
  const beforeSwipe = await state();
  await drag('touch', -75);
  const afterSwipe = await state();
  assert.ok(afterSwipe.from > beforeSwipe.from, 'Portrait sideways swipe pans at the fully zoomed-out level');
  assert.ok(Math.abs(afterSwipe.zoom - 1) < 0.001, 'Portrait swipe does not change magnification');
  checkBounds(afterSwipe, initial, 'Portrait swipe');
  const pinch = await point();
  await command('input.performActions', { context, actions: [-1, 1].map((direction, index) => ({
    type: 'pointer', id: `chart-pinch-${index}`, parameters: { pointerType: 'touch' },
    actions: [{ type: 'pointerMove', x: pinch.x + direction * 35, y: pinch.y, duration: 0 },
      { type: 'pointerDown', button: 0 },
      ...[50, 65, 80].map(distance => ({ type: 'pointerMove', x: pinch.x + direction * distance, y: pinch.y, duration: 16 })),
      { type: 'pointerUp', button: 0 }],
  })) });
  await until(`Number(${canvas}.dataset.zoom) > 1`);
  const pinched = await state();
  checkBounds(pinched, initial, 'Two-finger pinch');
  // Move into the middle before rotating: edge clamping legitimately moves the
  // center when the wider landscape viewport would otherwise cross a boundary.
  await evaluate("(() => { const n=document.getElementById('chart-navigator'); n.value=(Number(n.min)+Number(n.max))/2; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await settle();
  const beforeRotation = await state();
  await viewport(844, 390);
  await settle();
  const rotated = await state();
  assert.ok(Math.abs((rotated.from + rotated.to) / 2 - (beforeRotation.from + beforeRotation.to) / 2) <= 2,
    'Rotation preserves the visible center when zoomed in');
  assert.ok(Math.abs(rotated.zoom - beforeRotation.zoom) < 0.001, 'Rotation preserves magnification');
  checkBounds(rotated, initial, 'Zoomed landscape');
  await checkFits('Zoomed landscape fullscreen');
  await key('Home');
  await settle();
  checkWholeSelection(await state(), 'Landscape reset');
  await checkFits('Landscape fullscreen');
  await checkToolbar('Landscape fullscreen');
  await capture('landscape');

  await viewport(1440, 1100);
  await key('+');
  await settle();
  const beforeExit = await state();
  await click('chart-fullscreen');
  await until(`!(${fullscreen})`);
  await checkNormal('Normal chart after leaving a magnified view');
  await click('chart-fullscreen');
  await until(fullscreen);
  checkSameView(await state(), beforeExit, 'Reentering a magnified desktop chart');
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'chart-keyboard',
    actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
  await settle();
  assert.equal(await evaluate(fullscreen), true, 'Escape leaves the chart inspection view open');
  checkSameView(await state(), beforeExit, 'Escape preserves the inspected chart interval');
  await click('chart-fullscreen');
  await until(`!(${fullscreen})`);
  await settle();
  checkWholeSelection(await state(), 'Exiting fullscreen');
  assert.equal(await evaluate('document.activeElement.id'), 'chart-fullscreen', 'Exit restores focus to the fullscreen button');
  assert.equal(await evaluate('document.body.style.overflow'), overflow, 'Exit restores body scrolling');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), theme, 'Zoom checks restore the starting theme');
  checkBounds(await state(), initial, 'Completed zoom checks');

  // A multi-year selection uses the same fixed-domain interactions. The
  // synthetic store is deliberately sparse: this checks long-window behavior
  // without treating a desktop smoke run as a household loading benchmark.
  await evaluate(`document.getElementById('date-start').value='2024-09-07'; document.getElementById('date-start').dispatchEvent(new Event('change'));
    document.getElementById('date-end').value='2026-09-07';
    document.getElementById('date-end').dispatchEvent(new Event('change')); true`);
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.rangeStart === '2024-09-07'
    && ${canvas}.dataset.rangeEnd === '2026-09-07'`);
  const years = await state();
  checkWholeSelection(years, 'Two-year selected window');
  assert.ok(years.selectedTo - years.selectedFrom > 700 * 86400000, 'The selected window spans more than 700 days');
  await click('chart-fullscreen');
  await until(fullscreen);
  checkWholeSelection(await state(), 'Changed dates clear the remembered fullscreen zoom');
  await evaluate("document.getElementById('history').focus(); for(let i=0;i<8;i++)document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })); true");
  await settle();
  const deep = await state();
  assert.ok(deep.to - deep.from < (years.selectedTo - years.selectedFrom) / 100,
    'A multi-year selection can zoom to a few days without changing its selected dates');
  checkBounds(deep, years, 'Deep multi-year zoom');
  await evaluate("document.getElementById('chart-navigator').value=document.getElementById('chart-navigator').max; document.getElementById('chart-navigator').dispatchEvent(new Event('input', { bubbles: true })); true");
  await settle();
  const lastDays = await state();
  assert.ok(Math.abs(lastDays.to - years.selectedTo) <= 2, 'Deep zoom can navigate to the end of a multi-year selection');
  checkBounds(lastDays, years, 'Multi-year pan');
  await key('Home');
  await settle();
  checkWholeSelection(await state(), 'Multi-year reset');
  await click('chart-fullscreen');
  await until(`!(${fullscreen})`);
  await evaluate(`document.getElementById('date-start').value=${JSON.stringify(initial.dates[0])}; document.getElementById('date-start').dispatchEvent(new Event('change'));
    document.getElementById('date-end').value=${JSON.stringify(initial.dates[1])};
    document.getElementById('date-end').dispatchEvent(new Event('change')); true`);
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.rangeStart === ${JSON.stringify(initial.rangeStart)}
    && ${canvas}.dataset.rangeEnd === ${JSON.stringify(initial.rangeEnd)}`);
  checkWholeSelection(await state(), 'Restored original selection');
  checkBounds(await state(), initial, 'Restored original dates');
  for (const [width, height, name] of [[320, 568, 'small-portrait'], [390, 844, 'portrait'], [844, 390, 'landscape']]) {
    await viewport(width, height);
    await checkNormal(`Normal ${name} chart`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true,
      `Normal ${name} chart has no horizontal page overflow`);
    await evaluate("document.querySelector('.history-panel').scrollIntoView({ block: 'start' }); true");
    await capture(`normal-${name}`);
  }
  await viewport(1440, 1100);
  await evaluate('window.scrollTo(0, 0); true');
}
