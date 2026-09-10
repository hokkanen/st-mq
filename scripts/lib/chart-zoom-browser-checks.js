import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

// Exercises the shipped chart against the smoke harness's isolated simulation.
// Screenshots and browser instrumentation contain invented fixture data only.
export async function checkChartZoomBrowser({ evaluate, command, context, until }) {
  const canvas = "document.getElementById('history')";
  const fullscreen = "document.querySelector('.history-panel').dataset.fullscreen === 'true'";
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click(); true`);
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
  await until(`${canvas}.dataset.ready === 'true' && Number.isFinite(Number(${canvas}.dataset.viewFrom))`);
  const initial = await state();
  const overflow = await evaluate('document.body.style.overflow');
  const theme = await evaluate('document.documentElement.dataset.theme');
  checkWholeSelection(initial, 'Initial desktop chart');
  await evaluate("document.getElementById('chart-fullscreen').focus(); document.getElementById('chart-fullscreen').click(); true");
  await until(fullscreen);
  await settle();
  checkSameView(await state(), initial, 'Entering fullscreen');
  await checkFits('Desktop fullscreen');
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
    for (let i = 0; i < 4; i++) document.getElementById('chart-zoom-in').click();
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
  await click('chart-zoom-reset');
  await settle();
  checkWholeSelection(await state(), 'Reset after asynchronous refinement');

  await click('chart-zoom-in');
  await until(`Number(${canvas}.dataset.zoom) > 1`);
  const zoomed = await state();
  assert.ok(zoomed.to - zoomed.from < initial.to - initial.from, 'Zoom button narrows the visible time interval');
  checkBounds(zoomed, initial, 'Zoom button');
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
        if (url.searchParams.get('left') === 'phases') return new Promise((resolve, reject) => {
          fixture.release = () => fixture.fetch(args[0], { ...args[1], signal: undefined }).then(resolve, reject);
        });
        if (url.searchParams.get('left') === 'integral') return fixture.fetch(...args).then(response => {
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
  await evaluate("document.getElementById('left-axis').value='phases'; document.getElementById('left-axis').dispatchEvent(new Event('change')); true");
  await until('Boolean(window.chartAxisFixture.release)');
  await evaluate("document.getElementById('left-axis').value='integral'; document.getElementById('left-axis').dispatchEvent(new Event('change')); true");
  await until('window.chartAxisFixture.integralDone');
  await settle();
  await command('input.performActions', { context, actions: [{ type: 'pointer', id: 'chart-axis-mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerUp', button: 0 }] }] });
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.left === 'integral'
    && Boolean(document.querySelector('[data-chart-key=heating_integral]'))`);
  checkSameView(await state(), axisView, 'Completing an axis change during a gesture');
  await evaluate('window.chartAxisFixture.release().then(() => true)');
  await settle();
  assert.equal(await evaluate(`${canvas}.dataset.left`), 'integral', 'An older axis response cannot relabel the latest plotted data');
  assert.equal(await evaluate("Boolean(document.querySelector('[data-chart-key=property_current_l1]'))"), false,
    'The discarded phase response cannot replace the latest legend');
  await evaluate("window.fetch=window.chartAxisFixture.fetch; delete window.chartAxisFixture; document.getElementById('left-axis').value='power'; document.getElementById('left-axis').dispatchEvent(new Event('change')); true");
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
    await click(value === 'min' ? 'chart-pan-back' : 'chart-pan-forward');
    await settle();
    checkSameView(await state(), view, `Panning against the ${value} boundary`);
  }
  await click('chart-zoom-reset');
  await settle();
  checkWholeSelection(await state(), 'Desktop reset');
  await click('chart-zoom-out');
  await settle();
  checkWholeSelection(await state(), 'Zooming out at the desktop limit');

  await viewport(390, 844);
  await until(`Number(${canvas}.dataset.viewTo) - Number(${canvas}.dataset.viewFrom) < Number(${canvas}.dataset.selectedTo) - Number(${canvas}.dataset.selectedFrom)`);
  const portrait = await state();
  assert.ok(Math.abs(portrait.zoom - 1) < 0.001, 'Portrait starts at baseline magnification');
  checkBounds(portrait, initial, 'Portrait slice');
  await checkFits('Portrait fullscreen');
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
  await click('chart-zoom-reset');
  await settle();
  checkWholeSelection(await state(), 'Landscape reset');
  await checkFits('Landscape fullscreen');
  await capture('landscape');

  await viewport(1440, 1100);
  await click('chart-zoom-in');
  await settle();
  const beforeExit = await state();
  await click('chart-fullscreen');
  await until(`!(${fullscreen})`);
  checkSameView(await state(), beforeExit, 'Leaving a magnified desktop chart');
  await click('chart-fullscreen');
  await until(fullscreen);
  checkSameView(await state(), beforeExit, 'Reentering a magnified desktop chart');
  await click('chart-zoom-reset');
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'chart-keyboard',
    actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
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
  await evaluate(`document.getElementById('date-range-enabled').click();
    document.getElementById('date-start').value='2024-09-07';
    document.getElementById('date-end').value='2026-09-07';
    document.getElementById('chart-range-form').requestSubmit(); true`);
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.rangeStart === '2024-09-07'
    && ${canvas}.dataset.rangeEnd === '2026-09-07'`);
  const years = await state();
  checkWholeSelection(years, 'Two-year selected window');
  assert.ok(years.selectedTo - years.selectedFrom > 700 * 86400000, 'The selected window spans more than 700 days');
  await click('chart-fullscreen');
  await until(fullscreen);
  await evaluate("for(let i=0;i<8;i++)document.getElementById('chart-zoom-in').click(); true");
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
  await click('chart-zoom-reset');
  await settle();
  checkWholeSelection(await state(), 'Multi-year reset');
  await click('chart-fullscreen');
  await until(`!(${fullscreen})`);
  await evaluate(`document.getElementById('date-start').value=${JSON.stringify(initial.dates[0])};
    document.getElementById('date-end').value=${JSON.stringify(initial.dates[1])};
    document.getElementById('date-range-enabled').click(); true`);
  await until(`${canvas}.dataset.ready === 'true' && ${canvas}.dataset.rangeStart === ${JSON.stringify(initial.rangeStart)}
    && ${canvas}.dataset.rangeEnd === ${JSON.stringify(initial.rangeEnd)}`);
  checkWholeSelection(await state(), 'Restored original selection');
  checkBounds(await state(), initial, 'Restored original dates');
  await evaluate('window.scrollTo(0, 0); true');
}
