import assert from 'node:assert/strict';

/** Install before navigation. This observes the shipped canvas painting and
 * emulates the hardware media query, not application chart state or callbacks. */
export async function installChartPopupProbe({ command, context }) {
  await command('script.addPreloadScript', { contexts: [context], functionDeclaration: `() => {
    const probe = window.chartPopupProbe = { coarse: false, queries: [], text: [] };
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = matchMedia(query);
      if (query === '(pointer: coarse)') {
        Object.defineProperty(media, 'matches', { get: () => probe.coarse });
        probe.queries.push(media);
      }
      return media;
    };
    probe.setCoarse = value => {
      probe.coarse = value;
      for (const media of probe.queries) media.dispatchEvent(new Event('change'));
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (this.canvas.id === 'history') probe.text.push(String(text));
      return fillText.call(this, text, x, y, ...args);
    };
  }` });
}

export async function checkChartPopupBrowser({ command, evaluate, context, until }) {
  const settle = () => evaluate('window.chartRequestProbe.settled()');
  const fullscreen = () => evaluate("document.getElementById('chart-fullscreen').click(); true");
  const inspect = async enabled => {
    await evaluate(`(() => {
      const canvas = document.getElementById('history'), rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      window.chartPopupProbe.text = [];
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
        clientX: rect.left + rect.width * 0.45, clientY: rect.top + rect.height * 0.45 }));
      return true;
    })()`);
    await settle();
    const text = JSON.parse(await evaluate('JSON.stringify(window.chartPopupProbe.text)'));
    const values = text.filter(line => /^(Property|Charger [12]|Average indoor|Outdoor|Garage|All-in price|Spot price):/.test(line));
    assert.equal(values.length > 0, enabled, `${enabled ? 'Enabled' : 'Disabled'} chart popups paint ${enabled ? 'values' : 'no values'}`);
    if (enabled) {
      assert(text.some(line => /2026/.test(line)), 'Popup title includes the year');
      assert(text.some(line => /Finland/.test(line)), 'Popup title identifies Finnish time');
      assert(values.every(line => !/GMT|2026/.test(line)), 'Values do not repeat the title time');
    }
  };
  const oldViewport = JSON.parse(await evaluate('JSON.stringify({width:innerWidth,height:innerHeight})'));
  for (const { coarse, width, height } of [
    { coarse: false, width: 1440, height: 1000 },
    { coarse: true, width: 390, height: 844 },
    { coarse: true, width: 844, height: 390 },
  ]) {
    await command('browsingContext.setViewport', { context, viewport: { width, height }, devicePixelRatio: 1 });
    await evaluate(`window.chartPopupProbe.setCoarse(${coarse}); document.querySelector('.history-panel').scrollIntoView({block:'start'}); true`);
    await settle(); await inspect(!coarse);
    await fullscreen(); await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'");
    await settle(); await inspect(true);
    await fullscreen(); await until("document.querySelector('.history-panel').dataset.fullscreen !== 'true'");
    await settle(); await inspect(!coarse);
  }
  await evaluate('window.chartPopupProbe.setCoarse(false); true');
  await command('browsingContext.setViewport', { context, viewport: oldViewport, devicePixelRatio: 1 });
  await settle();
}
