import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** The surrounding equipment fixture intercepts every command before it reaches hardware. */
export async function checkGarageDoorBrowser({ evaluate, command, context, refresh, settle, until, setReducedMotion }) {
  const trigger = '#garage-door-summary .status-detail-trigger';
  const summary = '#garage-doors-label';
  const panel = '#garage-doors-dialog';
  const overview = '#garage-doors-shortcut';
  const row = id => `${panel} .garage-door-row[data-device-id="${id}"]`;
  const bay = (scope, side) => `${scope} .garage-door-row[data-side="${side}"]`;
  const action = id => `${row(id)} .garage-door-action`;
  const text = selector => evaluate(`document.querySelector('${selector}').textContent.trim()`);
  const buttonState = id => evaluate(`(() => {const b=document.querySelector('${action(id)}');return {action:b.dataset.coverAction,disabled:b.disabled};})()`);
  const click = selector => evaluate(`document.querySelector('${selector}').click();true`);
  const bayStates = scope => evaluate(`[...document.querySelectorAll('${scope} .garage-door-row[data-side]')].map(n=>({side:n.dataset.side,id:n.dataset.deviceId,state:n.dataset.state}))`);
  const travel = (scope, side = 'right') => evaluate(`(() => {const shutter=document.querySelector('${bay(scope, side)} .garage-door-leaf'),animation=shutter.getAnimations().find(a=>a.playState==='running');if(!animation)return null;const frames=animation.effect.getKeyframes(),timing=animation.effect.getTiming();return {duration:timing.duration,remaining:timing.duration-animation.currentTime,easing:timing.easing,from:new DOMMatrix(frames[0].transform).m42,to:new DOMMatrix(frames.at(-1).transform).m42};})()`);
  const labelsFit = () => evaluate(`(() => {return [...document.querySelectorAll('${panel} .garage-door-action-label')].every(n=>{const range=document.createRange();range.selectNodeContents(n);const b=n.getBoundingClientRect(),door=n.closest('button').getBoundingClientRect();return range.getClientRects().length===1&&b.left>=door.left&&b.right<=door.right;});})()`);
  const assertClosedArtwork = async () => {
    for (const scope of [overview, panel]) assert.equal(await evaluate(`(() => {return [...document.querySelectorAll('${scope} .garage-door-row[data-side]')].every(n=>n.dataset.state==='closed'&&new DOMMatrix(getComputedStyle(n.querySelector('.garage-door-leaf')).transform).m42===0&&n.querySelector('.garage-door-estimate').hidden);})()`), true, 'Closed reports show lowered shutters without an estimated position');
  };
  const capture = async name => {
    const screenshot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    writeFileSync(`var/${name}.png`, Buffer.from(screenshot.data, 'base64'));
  };
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
    f.status.garage={...f.base?.garage,...f.status.garage,doorTravelSeconds:18};
    for(const d of f.devices.filter(d=>d.kind==='door')){d.cover.state='closed';d.cover.operation=null;
      for(const r of Object.values(d.readings)){r.value=0;r.coverState='closed';}}
    return true;})()`);
  try {
    await refresh();
    assert.equal(await text(summary), 'Both closed');
    assert.equal(await evaluate(`document.querySelector('${panel}').open`), false);
    assert.equal(await evaluate(`document.querySelector('${overview} .garage-facade').checkVisibility()`), true, 'The garage is visible before its controls are opened');
    const closedBays = [{ side: 'left', id: 'door2', state: 'closed' }, { side: 'right', id: 'door1', state: 'closed' }];
    assert.deepEqual(await bayStates(overview), closedBays, 'The front elevation places Door 2 left and Door 1 right');
    await assertClosedArtwork();
    await evaluate('window.equipmentUiFixture.devices.reverse();true');
    await refresh();
    assert.deepEqual(await bayStates(overview), closedBays, 'Polling with reversed equipment order cannot swap physical doors');
    await evaluate('window.equipmentUiFixture.devices.reverse();true');
    await refresh();
    assert.equal(await evaluate(`document.querySelectorAll('${overview} button, ${overview} [data-write-control], ${overview} [data-cover-action]').length`), 0, 'The overview contains navigation only');
    for (const side of ['left', 'right']) {
      await click(bay(overview, side));
      await until(`document.querySelector('${panel}').matches(':modal')`);
      assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 0, `Opening controls from the ${side} door never operates it`);
      await close();
      await until(`!document.querySelector('${panel}').open`);
    }
    const folds = await evaluate("[...document.querySelectorAll('.controller-panels details')].map(node=>node.open)");
    await open();
    assert.deepEqual(await bayStates(panel), closedBays, 'Dialog and overview preserve the same physical placement');
    assert.equal(await evaluate(`document.querySelector('${overview} .garage-facade-roof').getAttribute('d')===document.querySelector('${panel} .garage-facade-roof').getAttribute('d')`), true, 'Both views share the gable-front illustration');
    assert.equal(await text(`${bay(panel, 'left')} .garage-door-name`), 'Left');
    assert.equal(await text(`${bay(panel, 'right')} .garage-door-name`), 'Right');
    assert.equal(await text('#garage-doors-title'), 'Garage doors');
    assert.equal(await text('#garage-doors-back'), 'Go back');
    assert.equal(await evaluate("document.activeElement.id"), 'garage-doors-back', 'Initial focus leaves movement an explicit choice');
    await press('\uE007');
    await until(`!document.querySelector('${panel}').open`);
    await until(`document.activeElement===document.querySelector('${trigger}')`);
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
    assert.equal(await text(`${action('door1')} .garage-door-action-label`), 'Open');
    assert.match(await evaluate(`document.querySelector('${action('door1')}').getAttribute('aria-label')`), /open.*right|right.*open/i);
    assert.match(await evaluate(`document.querySelector('${action('door2')}').getAttribute('aria-label')`), /open.*left|left.*open/i);
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
    await evaluate("window.dispatchEvent(new Event('online'));true");
    await settle();
    assert.equal(await evaluate('window.equipmentUiFixture.responses'), heldResponses, 'Status polling stays paused while a command is being delivered');
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 1, 'A refresh request never repeats the pending command');
    await evaluate('window.equipmentUiFixture.holdCover=false;window.equipmentUiFixture.releaseCover();true');
    await until(`document.querySelector('${row('door1')} .garage-door-feedback').textContent.includes('position unconfirmed')`);
    assert.equal(await text(`${row('door1')} .garage-door-state`), 'Closed', 'A successful publication is not a position report');
    assert.equal((await buttonState('door1')).disabled, true);
    assert.match(await text(`${action('door1')} .garage-door-action-label`), /waiting/i);
    assert.equal(await text(summary), 'Both closed');
    assert.deepEqual(await bayStates(overview), closedBays, 'Publishing never moves either overview door');
    for (const scope of [overview, panel]) assert.equal(await travel(scope), null, 'Requests and acknowledgements never start physical travel animation');
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
    assert.equal(await text(summary), 'Right opening', 'The summary preserves explicitly reported motion with spatial naming');
    for (const scope of [overview, panel]) {
      assert.deepEqual(await bayStates(scope), [{ side: 'left', id: 'door2', state: 'closed' }, { side: 'right', id: 'door1', state: 'moving' }], 'Reported movement affects only the matching bay');
    }
    const initialTravel = await travel(panel), overviewTravel = await travel(overview);
    assert(initialTravel && overviewTravel, 'Reported opening animates the shutters on both surfaces');
    for (const motion of [initialTravel, overviewTravel]) {
      assert.equal(motion.easing, 'linear', 'Travel uses a constant speed');
      assert(motion.duration > 0 && motion.duration <= 18_000, 'Full travel fits the configured duration');
    }
    assert.equal(initialTravel.to, overviewTravel.to, 'Both facades use the same destination');
    assert.equal(await evaluate(`document.querySelector('${bay(panel, 'right')} .garage-door-estimate').checkVisibility()`), true, 'Timing is visibly identified as an estimate');
    await refresh();
    const refreshedTravel = await travel(panel);
    assert(refreshedTravel && refreshedTravel.remaining < initialTravel.remaining, 'Polling does not restart the travel timer');
    assert(Math.abs(Math.abs(refreshedTravel.to-refreshedTravel.from)/refreshedTravel.duration-Math.abs(initialTravel.to-initialTravel.from)/initialTravel.duration) < 0.00001, 'Polling retains the configured travel speed');
    if (setReducedMotion) {
      await setReducedMotion(true);
      await refresh();
      for (const scope of [overview, panel]) assert.equal(await travel(scope), null, 'Reduced-motion preference suppresses moving shutters');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('${bay(panel, 'right')} .garage-door-motion')).animationName`), 'none');
      await setReducedMotion(false);
      await refresh();
    }
    assert.deepEqual(await buttonState('door1'), { action: 'stop', disabled: false });
    await evaluate("window.equipmentUiFixture.devices.find(d=>d.id==='door1').controls.cover.stop=false;true");
    await refresh();
    assert.equal((await buttonState('door1')).disabled, true, 'Reported motion without a Stop capability cannot offer a reversal');
    await evaluate("(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door1');f.now++;d.cover.state='open';Object.assign(d.readings.garage_door1_open,{coverState:'open',observedAt:f.now});return true;})()");
    await refresh();
    assert.equal(await text(`${row('door1')} .garage-door-state`), 'Open');
    assert.deepEqual(await buttonState('door1'), { action: 'close', disabled: false });
    assert.match(await text(summary), /Right open/);
    for (const scope of [overview, panel]) {
      assert.deepEqual(await bayStates(scope), [{ side: 'left', id: 'door2', state: 'closed' }, { side: 'right', id: 'door1', state: 'open' }]);
    }
    await evaluate(`document.querySelector('${action('door1')}').focus({preventScroll:true});true`);
    await command('input.performActions', { context, actions: [{ type: 'key', id: 'garage-door-close', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    await until('window.equipmentUiFixture.calls.length===3');
    await until(`document.querySelector('${row('door1')} .garage-door-feedback').textContent.includes('position unconfirmed')`);
    assert.deepEqual(await evaluate('window.equipmentUiFixture.calls[2]'), { path: '/api/equipment/cover', body: { deviceId: 'door1', action: 'close' } });

    await evaluate(`window.equipmentUiFixture.failNext=true;document.querySelector('${action('door2')}').click();true`);
    await until(`document.querySelector('${row('door2')} .garage-door-feedback').classList.contains('form-error')`);
    assert.deepEqual(await evaluate('window.equipmentUiFixture.calls[3]'), { path: '/api/equipment/cover', body: { deviceId: 'door2', action: 'open' } }, 'The left bay operates Door 2');
    assert.equal(await text(`${row('door2')} .garage-door-state`), 'Closed');
    assert.equal((await buttonState('door2')).disabled, false, 'A failed publication allows an explicit retry');
    assert.equal(await evaluate(`document.querySelector('${row('door1')} .garage-door-feedback').classList.contains('form-error')`), false);
    assert.doesNotMatch(await text(`${row('door2')} .garage-door-feedback`), /Synthetic control failure/);
    for (const scope of [overview, panel]) assert.equal(await travel(scope, 'left'), null, 'Failed delivery cannot start a travel clock or animate the left door');
    await evaluate("(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door2');f.now+=3000;d.cover.state='opening';Object.assign(d.readings.garage_door2_open,{value:1,coverState:'opening',observedAt:f.now});return true;})()");
    await refresh();
    for (const scope of [overview, panel]) {
      const motion = await travel(scope, 'left');
      assert(motion && motion.duration > 17_500 && motion.from > -3, 'A report after failed delivery starts from the last known position, without command-time catch-up');
    }
    await evaluate("(() => {const f=window.equipmentUiFixture;f.now+=60001;for(const d of f.devices.filter(d=>d.kind==='door')){d.cover.operation=null;d.cover.state='closed';Object.assign(Object.values(d.readings)[0],{value:0,coverState:'closed',observedAt:f.now});}return true;})()");
    await refresh();
    await assertClosedArtwork();

    // The real contact can report Open as soon as a shutter leaves the floor.
    // Confirm the actual command flow catches up from successful delivery, while
    // both representations stay still until a fresh physical response arrives.
    await evaluate('window.equipmentUiFixture.savedMotionDoors=structuredClone(window.equipmentUiFixture.devices);true');
    for (const [id, side, direction, response] of [
      ['door1', 'right', 'open', 'open'], ['door2', 'left', 'open', 'opening'],
      ['door1', 'right', 'close', 'closing'], ['door2', 'left', 'close', 'closing'],
    ]) {
      await evaluate(`(() => {const f=window.equipmentUiFixture;f.devices=structuredClone(f.savedMotionDoors);f.now+=60001;
        for(const d of f.devices.filter(d=>d.kind==='door'))for(const r of Object.values(d.readings))r.observedAt=f.now;
        const d=f.devices.find(d=>d.id==='${id}');if('${direction}'==='close')Object.values(d.readings)[0].stale=true;return true;})()`);
      await refresh();
      if (direction === 'close') {
        // Reacquire an already-open door, without inventing an opening stroke.
        await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now++;d.cover.state='open';
          Object.assign(Object.values(d.readings)[0],{value:1,coverState:'open',observedAt:f.now,stale:false});return true;})()`);
        await refresh();
      }
      await open();
      assert.deepEqual(await buttonState(id), { action: direction, disabled: false });
      const callsBefore = await evaluate('window.equipmentUiFixture.calls.length');
      await click(action(id));
      await until(`window.equipmentUiFixture.calls.length===${callsBefore + 1}`);
      await until(`document.querySelector('${row(id)} .garage-door-feedback').textContent.includes('position unconfirmed')`);
      assert.deepEqual(await evaluate(`window.equipmentUiFixture.calls[${callsBefore}]`), { path: '/api/equipment/cover', body: { deviceId: id, action: direction } });
      for (const scope of [overview, panel]) assert.equal(await travel(scope, side), null, `${direction} delivery does not animate before device confirmation`);

      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now=d.cover.operation.acknowledgedAt+1000;
        Object.values(d.readings)[0].observedAt=f.now;return true;})()`);
      await refresh();
      for (const scope of [overview, panel]) assert.equal(await travel(scope, side), null, 'A fresh unchanged endpoint report does not confirm the requested movement');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}'),r=Object.values(d.readings)[0];
        f.now=d.cover.operation.acknowledgedAt+3000;d.cover.state='${response}';Object.assign(r,{value:1,observedAt:f.now});
        if('${response}'==='open')delete r.coverState;else r.coverState='${response}';return true;})()`);
      await refresh();
      const firstMotion = {};
      for (const scope of [overview, panel]) {
        const motion = firstMotion[scope] = await travel(scope, side);
        assert(motion, `${side} ${direction} is animated in ${scope} after physical confirmation`);
        assert.equal(motion.easing, 'linear');
        assert(Math.abs(motion.from - (direction === 'open' ? -16 : -80)) < 3, 'Three-second confirmation catches up to the anticipated position');
        assert(motion.duration > 14_500 && motion.duration <= 15_050, 'Only the remaining fifteen seconds are animated');
        assert.equal(motion.to, direction === 'open' ? -96 : 0);
        assert(Math.abs(Math.abs(motion.to-motion.from)/motion.duration - 96/18_000) < 0.00001, 'Both directions keep the same configured linear speed');
      }
      assert.equal(await evaluate(`document.querySelector('${bay(panel, side)} .garage-door-estimate').checkVisibility()`), true);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('${summary}'),'::before').content.includes('≈')`), true, 'The single caption marks estimated travel inline');
      assert.equal(await evaluate(`document.querySelector('${overview}').getAttribute('aria-describedby')`), 'garage-overview-estimate', 'The inline estimate has an accessible explanation');

      // Both repeated binary reports and a native open state mean not closed;
      // neither should finish the stroke, reverse it or start another timer.
      await refresh();
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now++;
        d.cover.state='open';Object.assign(Object.values(d.readings)[0],{value:1,coverState:'open',observedAt:f.now});return true;})()`);
      await refresh();
      for (const scope of [overview, panel]) {
        const motion = await travel(scope, side);
        assert(motion && motion.remaining < firstMotion[scope].remaining, 'Repeated and native Open reports preserve progress instead of restarting or snapping');
        assert.equal(motion.to, firstMotion[scope].to, 'A not-closed report preserves the current travel direction');
      }
      await close();
      await until(`!document.querySelector('${panel}').open`);
      assert.equal(await evaluate(`document.querySelector('${overview} .garage-facade').checkVisibility()`), true);
      assert(await travel(overview, side), 'The compact overview keeps animating with its dialog closed');
      const position = () => evaluate(`new DOMMatrix(getComputedStyle(document.querySelector('${bay(overview, side)} .garage-door-leaf')).transform).m42`);
      const before = await position();
      await settle();
      const after = await position();
      assert(direction === 'open' ? after < before : after > before, 'The visible compact shutter moves in the requested direction');

      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now++;
        d.cover.state='closed';Object.assign(Object.values(d.readings)[0],{value:0,coverState:'closed',observedAt:f.now});return true;})()`);
      await refresh();
      for (const scope of [overview, panel]) {
        assert.equal(await travel(scope, side), null, 'A confirmed closed endpoint immediately stops estimated travel');
        assert.equal(await evaluate(`new DOMMatrix(getComputedStyle(document.querySelector('${bay(scope, side)} .garage-door-leaf')).transform).m42`), 0);
      }
    }
    await evaluate('window.equipmentUiFixture.devices=window.equipmentUiFixture.savedMotionDoors;delete window.equipmentUiFixture.savedMotionDoors;true');
    await refresh();
    await open();
    await assertClosedArtwork();

    // Finish a short, real animation without a Closed report or another poll.
    // The motion cue stops at the floor, while reported state still owns colour.
    const physicalDoors = [overview, panel].map(scope => `${scope} .garage-door-row[data-side]`).join(', ');
    const reportBoth = async state => {
      await evaluate(`(() => {const f=window.equipmentUiFixture;f.now++;
        for(const d of f.devices.filter(d=>d.kind==='door')){d.cover.state='${state}';d.cover.operation=null;
          Object.assign(Object.values(d.readings)[0],{value:'${state}'==='closed'?0:1,coverState:'${state}',observedAt:f.now,stale:false});}
        return true;})()`);
      await refresh();
    };
    await evaluate("(() => {const f=window.equipmentUiFixture;f.status.garage.doorTravelSeconds=1;for(const d of f.devices.filter(d=>d.kind==='door'))Object.values(d.readings)[0].stale=true;return true;})()");
    await refresh();
    await reportBoth('open');
    await reportBoth('closing');
    assert.equal(await evaluate(`[...document.querySelectorAll('${physicalDoors}')].every(n=>getComputedStyle(n.querySelector('.garage-door-motion')).display==='block')`), true, 'Both doors show closing arrows in both views during travel');
    await until(`[...document.querySelectorAll('${physicalDoors}')].every(n=>getComputedStyle(n.querySelector('.garage-door-motion')).display==='none')`);
    const assertAwaitingClosed = async () => {
      const artwork = await evaluate(`[...document.querySelectorAll('${physicalDoors}')].map(n=>({
        arrow:getComputedStyle(n.querySelector('.garage-door-motion')).display,
        position:new DOMMatrix(getComputedStyle(n.querySelector('.garage-door-leaf')).transform).m42,
        state:n.querySelector('.garage-door-state').textContent.trim(),
        estimated:!n.querySelector('.garage-door-estimate').hidden,
        colour:getComputedStyle(n).getPropertyValue('--door-color').trim(),
        attention:getComputedStyle(n).getPropertyValue('--stale').trim()}))`);
      for (const door of artwork) {
        assert.equal(door.arrow, 'none', 'Downward arrow disappears at estimated closed position');
        assert.equal(door.position, 0);
        assert.equal(door.state, 'Closing', 'Animation completion cannot manufacture a Closed report');
        assert.equal(door.estimated, true);
        assert.equal(door.colour, door.attention, 'The shutter retains its attention colour until confirmation');
      }
      assert.equal(await evaluate("document.querySelector('#garage-door-summary').dataset.state"), 'attention');
    };
    await assertAwaitingClosed();
    await refresh();
    await assertAwaitingClosed();
    await reportBoth('closed');
    await assertClosedArtwork();
    assert.equal(await evaluate("document.querySelector('#garage-door-summary').dataset.state"), 'confirmed');
    await reportBoth('opening');
    assert.equal(await evaluate(`[...document.querySelectorAll('${physicalDoors}')].every(n=>getComputedStyle(n.querySelector('.garage-door-motion')).display==='block')`), true, 'A later opening restores the motion cue');
    if (setReducedMotion) {
      await setReducedMotion(true);
      await reportBoth('closing');
      await assertAwaitingClosed();
      await setReducedMotion(false);
    }
    await reportBoth('closed');
    await evaluate('window.equipmentUiFixture.status.garage.doorTravelSeconds=18;true');
    await refresh();

    for (const mutation of ["d.controls.cover.open=false", "d.cover.available=false", "d.readings.garage_door1_open.stale=true", "d.readings.garage_door1_open.value=null"]) {
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door1');f.garageDoorBefore=structuredClone(d);${mutation};return true;})()`);
      await refresh();
      assert.equal((await buttonState('door1')).disabled, true, `Unsafe or unsupported action is unavailable: ${mutation}`);
      if (mutation.includes('readings')) for (const scope of [overview, panel]) {
        assert.equal(await evaluate(`document.querySelector('${bay(scope, 'right')}').dataset.state`), 'unknown', 'Unavailable contact evidence is visibly unknown in both views');
        assert.equal(await text(`${bay(scope, 'right')} .garage-door-state`), 'Unknown');
      }
      const calls = await evaluate('window.equipmentUiFixture.calls.length');
      await click(action('door1'));
      assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), calls);
      await evaluate("(() => {const f=window.equipmentUiFixture;f.devices[f.devices.findIndex(d=>d.id==='door1')]=f.garageDoorBefore;delete f.garageDoorBefore;return true;})()");
      await refresh();
    }

    await evaluate("(() => {const f=window.equipmentUiFixture;f.savedMappedDoors=f.devices;f.devices=f.devices.filter(d=>d.id!=='door2');return true;})()");
    await refresh();
    assert.equal(await text(summary), 'Left unknown', 'A missing left connection cannot summarize both physical doors as closed');
    for (const scope of [overview, panel]) assert.equal(await text(`${bay(scope, 'left')} .garage-door-state`), 'Unknown');
    await evaluate('window.equipmentUiFixture.devices=window.equipmentUiFixture.savedMappedDoors;delete window.equipmentUiFixture.savedMappedDoors;true');
    await refresh();

    await evaluate(`document.querySelector('${action('door1')}').focus();window.equipmentUiFixture.savedDoors=window.equipmentUiFixture.devices;window.equipmentUiFixture.devices=window.equipmentUiFixture.devices.filter(d=>d.kind!=='door');true`);
    await refresh();
    assert.equal(await evaluate("document.activeElement.id"), 'garage-doors-back', 'Removing a focused door keeps focus inside the window');
    assert.equal(await text(`${panel} .garage-door-empty`), 'No garage doors are configured.');
    assert.equal(await evaluate(`document.querySelector('${panel} .garage-door-empty').checkVisibility()`), true);
    for (const scope of [overview, panel]) {
      assert.equal(await evaluate(`document.querySelectorAll('${scope} .garage-door-row[data-side]').length`), 2, 'The two physical bays remain present without usable device reports');
      assert.equal(await evaluate(`[...document.querySelectorAll('${scope} .garage-door-row[data-side]')].every(n=>n.dataset.state==='unknown')`), true, 'Missing door evidence keeps the facade unknown');
    }
    await evaluate("window.equipmentUiFixture.devices=window.equipmentUiFixture.savedDoors;delete window.equipmentUiFixture.savedDoors;true");
    await refresh();

    await evaluate("window.equipmentUiFixture.status.role='slave';true");
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
        await evaluate(`document.querySelector('${overview}').scrollIntoView({block:'center'});true`);
        await settle();
        assert.equal(await evaluate(`document.querySelector('${overview} .garage-facade').checkVisibility()`), true, 'The facade remains visible with its dialog closed');
        assert.equal(await evaluate(`(() => {const b=document.querySelector('${overview}').getBoundingClientRect(),rear=document.querySelector('#garage-temperature').closest('.overview-reading').getBoundingClientRect(),target=document.querySelector('#garage-requested').closest('.overview-request').getBoundingClientRect();return b.width<=120&&b.height<=120&&rear.right<=b.left&&b.right<=target.left;})()`), true, 'The compact animated shortcut fits between the rear sensor and room target');
        assert.equal(await evaluate(`(() => {const p=document.querySelector('${overview}').getBoundingClientRect(),left=document.querySelector('${bay(overview, 'left')}').getBoundingClientRect(),right=document.querySelector('${bay(overview, 'right')}').getBoundingClientRect();return left.left>=p.left&&right.right<=p.right&&left.right<=right.left&&Math.abs(left.top-right.top)<1;})()`), true, 'Overview doors remain side by side at every viewport');
        assert.equal(await evaluate(`(() => {const caption=document.querySelector('${summary}'),price=document.querySelector('#garage-price-label'),c=caption.getBoundingClientRect(),p=price.getBoundingClientRect();return Math.abs(c.top-p.top)<2&&c.height===15&&getComputedStyle(caption).whiteSpace==='nowrap'&&!document.querySelector('#garage-overview-estimate').checkVisibility();})()`), true, 'One caption aligns with the all-in price label, with no second text row');
        await capture(`garage-overview-${theme}-${width}`);
        await open();
        assert.equal(await evaluate(`Math.abs(document.querySelector('${panel}').getBoundingClientRect().left + document.querySelector('${panel}').getBoundingClientRect().width / 2 - document.documentElement.clientWidth / 2) < 1`), true, 'The window is centered');
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `No page overflow at ${width}px in ${theme}`);
        assert.equal(await evaluate(`(() => {const p=document.querySelector('${panel}'),b=p.getBoundingClientRect();return b.left>=7&&b.right<=innerWidth-7&&b.top>=7&&b.bottom<=innerHeight-7&&p.scrollWidth<=p.clientWidth;})()`), true, 'The window stays inside the viewport');
        assert.equal(await evaluate(`(() => {const p=document.querySelector('${panel}').getBoundingClientRect();return [...document.querySelectorAll('${panel} .garage-door-action')].every(n=>{const b=n.getBoundingClientRect();return b.width>=44&&b.height>=40&&b.left>=p.left&&b.right<=p.right&&b.top>=p.top&&b.bottom<=p.bottom;});})()`), true, 'Door actions remain visible and touchable');
        assert.equal(await evaluate(`(() => {return [...document.querySelectorAll('${panel} .garage-door-action')].every(n=>{const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return n.contains(hit);});})()`), true, 'Visible door centers receive their own pointer interaction');
        assert.equal(await labelsFit(), true, 'Action labels fit on one line inside each door');
        assert.equal(await evaluate(`(() => {const left=document.querySelector('${bay(panel, 'left')}').getBoundingClientRect(),right=document.querySelector('${bay(panel, 'right')}').getBoundingClientRect();return left.right<=right.left&&Math.abs(left.top-right.top)<1;})()`), true, 'Dialog doors preserve their physical side-by-side placement');
        await capture(`garage-doors-${theme}-${width}`);
        if (width === 320 || width === 390) {
          await evaluate("(() => {const f=window.equipmentUiFixture;f.responsiveDoors=structuredClone(f.devices);f.now++;const right=f.devices.find(d=>d.id==='door1'),left=f.devices.find(d=>d.id==='door2');right.cover.state='open';Object.assign(right.readings.garage_door1_open,{value:1,coverState:'open',observedAt:f.now});left.readings.garage_door2_open.stale=true;return true;})()");
          await refresh();
          assert.deepEqual(await bayStates(panel), [{ side: 'left', id: 'door2', state: 'unknown' }, { side: 'right', id: 'door1', state: 'open' }]);
          assert.equal((await buttonState('door2')).disabled, true);
          assert.equal(await labelsFit(), true, 'Open and unavailable action labels fit on narrow doors');
          assert.equal(await evaluate(`document.querySelector('${panel}').scrollWidth<=document.querySelector('${panel}').clientWidth`), true, 'Mixed door states do not overflow the dialog');
          await capture(`garage-doors-mixed-${theme}-${width}`);
          await evaluate("(() => {const f=window.equipmentUiFixture;f.devices=structuredClone(f.responsiveDoors);f.now++;for(const d of f.devices.filter(d=>d.kind==='door'))for(const r of Object.values(d.readings))r.observedAt=f.now;return true;})()");
          await refresh();
          await assertClosedArtwork();
          await evaluate("(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='door1');f.now++;d.cover.state='opening';Object.assign(d.readings.garage_door1_open,{value:1,coverState:'opening',observedAt:f.now});return true;})()");
          await refresh();
          assert(await travel(panel), 'A fresh report from closed begins real shutter animation for the motion gallery');
          assert.equal(await labelsFit(), true, 'Movement labels fit on narrow doors');
          assert.equal(await evaluate(`document.querySelector('${bay(panel, 'right')} .garage-door-estimate').checkVisibility()`), true);
          // Sample the actual browser animation at mid-stroke for the synthetic gallery.
          await evaluate(`document.querySelectorAll('.garage-door-row[data-side="right"] .garage-door-leaf').forEach(n=>n.getAnimations().forEach(a=>{a.currentTime=a.effect.getTiming().duration/2;}));true`);
          await settle();
          assert.equal(await evaluate(`(() => {const y=new DOMMatrix(getComputedStyle(document.querySelector('${bay(panel, 'right')} .garage-door-leaf')).transform).m42;return y < -5 && y > -90;})()`), true, 'Mid-travel browser rendering shows a partially raised shutter');
          await capture(`garage-doors-motion-${theme}-${width}`);
          await evaluate("(() => {const f=window.equipmentUiFixture;f.devices=f.responsiveDoors;delete f.responsiveDoors;f.now++;for(const d of f.devices.filter(d=>d.kind==='door'))for(const r of Object.values(d.readings))r.observedAt=f.now;return true;})()");
          await refresh();
          await assertClosedArtwork();
        }
        await command('input.performActions', { context, actions: [{ type: 'key', id: 'garage-doors-escape', actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
        assert.equal(await evaluate(`document.activeElement===document.querySelector('${trigger}')`), true, 'Escape returns focus to the Doors summary');
        assert.equal(await evaluate(`document.querySelector('${panel}').checkVisibility()`), false);
      }
    }
  } finally {
    if (setReducedMotion) await setReducedMotion(false);
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
