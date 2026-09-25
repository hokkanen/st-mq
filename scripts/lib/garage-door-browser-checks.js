import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** The surrounding equipment fixture intercepts every command before it reaches hardware. */
export async function checkGarageDoorBrowser({ evaluate, command, context, refresh, settle, until }) {
  const trigger = '#garage-door-summary .status-detail-trigger';
  const panel = '#garage-doors-dialog';
  const row = id => `${panel} .garage-door-row[data-device-id="${id}"]`;
  const action = id => `${row(id)} .garage-door-action`;
  const text = selector => evaluate(`document.querySelector('${selector}').textContent.trim()`);
  const buttonState = id => evaluate(`(() => {const b=document.querySelector('${action(id)}');return {action:b.dataset.coverAction,disabled:b.disabled};})()`);
  const click = selector => evaluate(`document.querySelector('${selector}').click();true`);
  const close = () => evaluate(`document.querySelector('#garage-doors-back')?.click();true`);
  const press = value => command('input.performActions', { context, actions: [{ type: 'key', id: 'garage-window-key', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
  const open = async () => {
    await evaluate(`document.querySelector('${trigger}').scrollIntoView({block:'center'});true`);
    await settle();
    await evaluate(`if(document.querySelector('${trigger}').getAttribute('aria-expanded')!=='true')document.querySelector('${trigger}').click();true`);
    await settle();
    assert.equal(await evaluate(`document.querySelector('${panel}').matches(':modal')`), true);
  };
  await evaluate(`(() => {const f=window.equipmentUiFixture;f.savedGarageDoorUi={
    devices:structuredClone(f.devices),status:structuredClone(f.status),now:f.now,calls:f.calls.slice(),
    theme:document.documentElement.dataset.theme,focus:document.activeElement,
    folds:[...document.querySelectorAll('.controller-panels details')].map(node=>[node,node.open])};
    for(const d of f.devices.filter(d=>d.kind==='door')){d.cover.state='closed';d.cover.operation=null;
      for(const r of Object.values(d.readings)){r.value=0;r.coverState='closed';}}
    return true;})()`);
  try {
    await refresh();
    assert.equal(await text(trigger), 'Both closed');
    const folds = await evaluate("[...document.querySelectorAll('.controller-panels details')].map(node=>node.open)");
    await open();
    assert.equal(await text('#garage-doors-title'), 'Garage doors');
    assert.equal(await text('#garage-doors-back'), 'Go back');
    assert.equal(await evaluate("document.activeElement.id"), 'garage-doors-back', 'Initial focus leaves movement an explicit choice');
    await press('\uE007');
    await until(`!document.querySelector('${panel}').open`);
    assert.equal(await evaluate(`document.activeElement===document.querySelector('${trigger}')`), true, 'Go back returns focus to the Doors summary');
    await press('\uE007');
    await until(`document.querySelector('${panel}').matches(':modal')`);
    for (let i=0;i<4;i++) {
      await press('\uE004');
      assert.equal(await evaluate(`document.querySelector('${panel}').contains(document.activeElement) || document.activeElement===document.body`), true, 'Tab cannot reach dashboard controls behind the modal');
    }
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.controller-panels details')].map(node=>node.open)"), folds, 'Window navigation preserves dashboard folds');
    assert.equal(await evaluate(`document.querySelectorAll('${panel} .garage-door-controls .garage-door-row').length`), 2);
    assert.equal(await evaluate(`[...document.querySelectorAll('${panel} .garage-door-row')].every(r=>r.querySelectorAll('button').length===1)`), true, 'Each door offers one context-sensitive action');
    assert.deepEqual(await buttonState('door1'), { action: 'open', disabled: false });
    assert.deepEqual(await buttonState('door2'), { action: 'open', disabled: false });
    assert.match(await text(action('door1')), /^Open$/);
    assert.match(await evaluate(`document.querySelector('${action('door1')}').getAttribute('aria-label')`), /open.*door 1|door 1.*open/i);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 0, 'Opening the window sends no device command');

    await evaluate(`window.equipmentUiFixture.garageDoorNode=document.querySelector('${row('door1')}');window.equipmentUiFixture.garageDoorButton=document.querySelector('${action('door1')}');document.querySelector('${action('door1')}').focus();true`);
    await refresh();
    assert.equal(await evaluate(`window.equipmentUiFixture.garageDoorNode===document.querySelector('${row('door1')}')&&window.equipmentUiFixture.garageDoorButton===document.activeElement`), true, 'Polling retains the row, action and keyboard focus');

    await evaluate(`window.equipmentUiFixture.holdCover=true;document.querySelector('${action('door1')}').click();document.querySelector('${action('door1')}').click();document.querySelector('#garage-equipment-readings [data-device-id="door1"] [data-cover-action="open"]').click();true`);
    await until('window.equipmentUiFixture.calls.length===1');
    await settle();
    assert.deepEqual(await evaluate('window.equipmentUiFixture.calls[0]'), { path: '/api/equipment/cover', body: { deviceId: 'door1', action: 'open' } });
    assert.equal((await buttonState('door1')).disabled, true, 'Repeated clicks cannot republish during delivery');
    assert.equal((await buttonState('door2')).disabled, true, 'The window shares the existing equipment delivery lock');
    assert.equal(await text(`${row('door1')} .garage-door-state`), 'Closed', 'Sending never invents physical motion');
    await close();
    await until(`!document.querySelector('${panel}').open`);
    await open();
    assert.equal((await buttonState('door1')).disabled, true, 'Reopening retains the pending command');
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 1, 'Going back and reopening never repeat a command');
    const heldResponses = await evaluate('window.equipmentUiFixture.responses');
    await evaluate("document.getElementById('auth').dispatchEvent(new Event('submit',{cancelable:true}));true");
    await settle();
    assert.equal(await evaluate('window.equipmentUiFixture.responses'), heldResponses, 'Status polling stays paused while a command is being delivered');
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 1, 'A refresh request never repeats the pending command');
    await evaluate('window.equipmentUiFixture.holdCover=false;window.equipmentUiFixture.releaseCover();true');
    await until(`document.querySelector('${row('door1')} .garage-door-feedback').textContent.includes('position unconfirmed')`);
    assert.equal(await text(`${row('door1')} .garage-door-state`), 'Closed', 'A successful publication is not a position report');
    assert.equal((await buttonState('door1')).disabled, true);
    assert.match(await text(action('door1')), /waiting/i);
    assert.equal(await text(trigger), 'Both closed');
    assert.equal(await text(`${row('door2')} .garage-door-feedback`), '', 'One door never inherits the other door’s receipt');

    await evaluate("(() => {const d=window.equipmentUiFixture.devices.find(d=>d.id==='door1');d.controls.cover.stop=true;return true;})()");
    await refresh();
    assert.deepEqual(await buttonState('door1'), { action: 'stop', disabled: false }, 'An advertised Stop remains available after delivery');
    await click(action('door1'));
    await until('window.equipmentUiFixture.calls.length===2');
    await until(`document.querySelector('${row('door1')} .garage-door-feedback').textContent.includes('stopping unconfirmed')`);
    assert.deepEqual(await evaluate('window.equipmentUiFixture.calls[1]'), { path: '/api/equipment/cover', body: { deviceId: 'door1', action: 'stop' } });

    await evaluate("(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door1');f.now++;d.cover.state='opening';d.cover.operation=null;Object.assign(d.readings.garage_door1_open,{value:1,coverState:'opening',observedAt:f.now});return true;})()");
    await refresh();
    assert.equal(await text(`${row('door1')} .garage-door-state`), 'Opening');
    assert.equal(await text(trigger), 'Door 1 opening', 'The summary preserves explicitly reported motion');
    assert.deepEqual(await buttonState('door1'), { action: 'stop', disabled: false });
    await evaluate("window.equipmentUiFixture.devices.find(d=>d.id==='door1').controls.cover.stop=false;true");
    await refresh();
    assert.equal((await buttonState('door1')).disabled, true, 'Reported motion without a Stop capability cannot offer a reversal');
    await evaluate("(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door1');f.now++;d.cover.state='open';Object.assign(d.readings.garage_door1_open,{coverState:'open',observedAt:f.now});return true;})()");
    await refresh();
    assert.equal(await text(`${row('door1')} .garage-door-state`), 'Open');
    assert.deepEqual(await buttonState('door1'), { action: 'close', disabled: false });
    assert.match(await text(trigger), /Door 1 open/);
    await evaluate(`document.querySelector('${action('door1')}').focus({preventScroll:true});true`);
    await command('input.performActions', { context, actions: [{ type: 'key', id: 'garage-door-close', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    await until('window.equipmentUiFixture.calls.length===3');
    await until(`document.querySelector('${row('door1')} .garage-door-feedback').textContent.includes('position unconfirmed')`);
    assert.deepEqual(await evaluate('window.equipmentUiFixture.calls[2]'), { path: '/api/equipment/cover', body: { deviceId: 'door1', action: 'close' } });

    await evaluate(`window.equipmentUiFixture.failNext=true;document.querySelector('${action('door2')}').click();true`);
    await until(`document.querySelector('${row('door2')} .garage-door-feedback').classList.contains('form-error')`);
    assert.equal(await text(`${row('door2')} .garage-door-state`), 'Closed');
    assert.equal((await buttonState('door2')).disabled, false, 'A failed publication allows an explicit retry');
    assert.equal(await evaluate(`document.querySelector('${row('door1')} .garage-door-feedback').classList.contains('form-error')`), false);
    assert.doesNotMatch(await text(`${row('door2')} .garage-door-feedback`), /Synthetic control failure/);
    await evaluate("(() => {const f=window.equipmentUiFixture;f.now+=60001;for(const d of f.devices.filter(d=>d.kind==='door')){d.cover.operation=null;d.cover.state='closed';Object.assign(Object.values(d.readings)[0],{value:0,coverState:'closed',observedAt:f.now});}return true;})()");
    await refresh();

    for (const mutation of ["d.controls.cover.open=false", "d.cover.available=false", "d.readings.garage_door1_open.stale=true", "d.readings.garage_door1_open.value=null"]) {
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door1');f.garageDoorBefore=structuredClone(d);${mutation};return true;})()`);
      await refresh();
      assert.equal((await buttonState('door1')).disabled, true, `Unsafe or unsupported action is unavailable: ${mutation}`);
      const calls = await evaluate('window.equipmentUiFixture.calls.length');
      await click(action('door1'));
      assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), calls);
      await evaluate("(() => {const f=window.equipmentUiFixture;f.devices[f.devices.findIndex(d=>d.id==='door1')]=f.garageDoorBefore;delete f.garageDoorBefore;return true;})()");
      await refresh();
    }

    await evaluate(`document.querySelector('${action('door1')}').focus();window.equipmentUiFixture.savedDoors=window.equipmentUiFixture.devices;window.equipmentUiFixture.devices=window.equipmentUiFixture.devices.filter(d=>d.kind!=='door');true`);
    await refresh();
    assert.equal(await evaluate("document.activeElement.id"), 'garage-doors-back', 'Removing a focused door keeps focus inside the window');
    assert.equal(await text(`${panel} .garage-door-empty`), 'No garage doors are configured.');
    assert.equal(await evaluate(`document.querySelector('${panel} .garage-door-empty').checkVisibility()`), true);
    await evaluate("window.equipmentUiFixture.devices=window.equipmentUiFixture.savedDoors;delete window.equipmentUiFixture.savedDoors;true");
    await refresh();

    await evaluate("window.equipmentUiFixture.status.role='replica';true");
    await refresh();
    assert.equal(await evaluate(`!document.querySelector('${panel}').checkVisibility()||[...document.querySelectorAll('${panel} .garage-door-action')].every(b=>b.disabled)`), true, 'An open window cannot retain primary control after becoming a replica');
    assert.equal(await evaluate(`document.querySelector('${panel}').matches(':modal')`), false, 'A replica transition releases the modal');
    const replicaCalls = await evaluate('window.equipmentUiFixture.calls.length');
    await evaluate(`document.querySelector('${action('door1')}')?.click();true`);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), replicaCalls);
    await evaluate("delete window.equipmentUiFixture.status.role;true");
    await refresh();
    await close();

    for (const theme of ['dark', 'light']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
      for (const [width, height] of [[1440,1100],[390,844],[320,720],[640,360]]) {
        await command('browsingContext.setViewport', { context, viewport: { width, height }, devicePixelRatio: 1 });
        await settle();
        await open();
        assert.equal(await evaluate(`Math.abs(document.querySelector('${panel}').getBoundingClientRect().left + document.querySelector('${panel}').getBoundingClientRect().width / 2 - document.documentElement.clientWidth / 2) < 1`), true, 'The window is centered');
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `No page overflow at ${width}px in ${theme}`);
        assert.equal(await evaluate(`(() => {const p=document.querySelector('${panel}'),b=p.getBoundingClientRect();return b.left>=7&&b.right<=innerWidth-7&&b.top>=7&&b.bottom<=innerHeight-7&&p.scrollWidth<=p.clientWidth;})()`), true, 'The window stays inside the viewport');
        assert.equal(await evaluate(`(() => {const p=document.querySelector('${panel}').getBoundingClientRect();return [...document.querySelectorAll('${panel} .garage-door-action')].every(n=>{const b=n.getBoundingClientRect();return b.width>=44&&b.height>=40&&b.left>=p.left&&b.right<=p.right&&b.top>=p.top&&b.bottom<=p.bottom;});})()`), true, 'Door actions remain visible and touchable');
        const screenshot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
        writeFileSync(`var/garage-doors-${theme}-${width}.png`, Buffer.from(screenshot.data, 'base64'));
        await command('input.performActions', { context, actions: [{ type: 'key', id: 'garage-doors-escape', actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
        assert.equal(await evaluate(`document.activeElement===document.querySelector('${trigger}')`), true, 'Escape returns focus to the Doors summary');
        assert.equal(await evaluate(`document.querySelector('${panel}').checkVisibility()`), false);
      }
    }
  } finally {
    await evaluate('window.equipmentUiFixture.holdCover=false;window.equipmentUiFixture.releaseCover?.();true');
    await settle();
    await close();
    await evaluate(`(() => {const f=window.equipmentUiFixture,s=f.savedGarageDoorUi;
      f.devices=s.devices;f.status=s.status;f.now=s.now;f.calls=s.calls;f.failNext=false;
      if(s.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=s.theme;
      for(const [node,open]of s.folds)node.open=open;s.focus?.focus({preventScroll:true});
      delete f.savedGarageDoorUi;delete f.garageDoorNode;delete f.garageDoorButton;delete f.releaseCover;return true;})()`);
    await refresh();
    await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  }
}
