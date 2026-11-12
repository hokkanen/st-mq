import assert from 'node:assert/strict';

/** Exercise the real watch consumer and illustrations with isolated native receipts. */
export async function checkGarageDoorUpdatesBrowser({ evaluate, refresh, until, settle, setReducedMotion }) {
  await setReducedMotion?.(false);
  await evaluate(`(() => {
    const f=window.equipmentUiFixture;
    f.savedDoorWatch={fetch:window.fetch,response:f.response};f.watchRevision=1;
    for(const d of f.devices.filter(d=>d.kind==='door')) {
      d.cover.operation=null;d.available=true;d.cover.available=true;d.cover.sourceTimePending=false;
      for(const r of Object.values(d.readings)){r.value=0;r.coverState='closed';r.stale=false;r.observedAt=f.now;r.receivedAt=f.now;}
    }
    f.response=base=>{const s=f.savedDoorWatch.response(base);s.equipment.doorRevision={generation:'fixture-watch-generation',revision:f.watchRevision};return s;};
    f.watchReply=()=>{const s=f.response(f.base);return {input:s.input,now:s.now,revision:JSON.stringify(s.equipment.doorRevision),
      equipment:{doorRevision:s.equipment.doorRevision,devices:s.equipment.devices.filter(d=>d.kind==='door')}};};
    f.sendDoorUpdate=()=>{f.watchRevision++;f.watchPublishedAt=performance.now();const pending=f.watchPending;f.watchPending=null;pending?.(f.watchReply());};
    window.fetch=async(...args)=>{
      const u=new URL(args[0],location.href);
      if(u.pathname!=='/api/garage/doors/watch')return f.savedDoorWatch.fetch(...args);
      const reply=f.watchReply();
      if(u.searchParams.get('revision')!==reply.revision)return new Response(JSON.stringify(reply),{status:200});
      return new Promise((resolve,reject)=>{
        const signal=args[1]?.signal;
        const cancel=()=>{f.watchPending=null;reject(new DOMException('Cancelled','AbortError'));};
        signal?.addEventListener('abort',cancel,{once:true});
        f.watchPending=value=>{signal?.removeEventListener('abort',cancel);resolve(new Response(JSON.stringify(value),{status:200}));};
      });
    };return true;
  })()`);
  const bay = side => `#garage-doors-shortcut .garage-door-row[data-side="${side}"]`;
  const progress = side => evaluate(`Math.max(0,-new DOMMatrix(getComputedStyle(document.querySelector('${bay(side)} .garage-door-leaf')).transform).m42/96)`);
  try {
    await refresh(); await until('Boolean(window.equipmentUiFixture.watchPending)');
    for (const [id, side] of [['door1', 'right'], ['door2', 'left']]) {
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=200;
        d.cover.operation={action:'open',status:'published',acknowledgement:'mqtt-write',requestedAt:f.now-100,dispatchedAt:f.now-90,acknowledgedAt:f.now-80,startingContact:0,
          deviceReceipt:{action:'open',executed:true,sourceTime:f.now-50,receivedAt:f.now,admittedAt:f.now}};
        f.sendDoorUpdate();return true;})()`);
      await until('Boolean(window.equipmentUiFixture.watchPending)'); await settle();
      assert.equal(await progress(side), 0, 'Device receipt alone keeps opening still');
      const reportsBefore = await evaluate('window.equipmentUiFixture.responses');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=2930;
        d.available=false;d.cover.available=false;d.cover.sourceTimePending=true;f.sendDoorUpdate();return true;})()`);
      await until('Boolean(window.equipmentUiFixture.watchPending)');
      for (const scope of ['#garage-doors-shortcut', '#garage-doors-dialog'])
        assert.equal(await evaluate(`document.querySelector('${scope} .garage-door-row[data-side="${side}"]').dataset.state`), 'closed', 'Pending contact retains the admitted closed state without a question mark');
      assert.equal(await progress(side), 0, 'Pending contact cannot start opening');
      assert.equal(await evaluate(`document.querySelector('#garage-doors-dialog .garage-door-row[data-side="${side}"] button').disabled`), true);
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=70;
        d.available=true;d.cover.available=true;d.cover.sourceTimePending=false;
        for(const r of Object.values(d.readings)){r.value=1;r.coverState='open';r.observedAt=f.now;r.receivedAt=f.now;}
        Object.assign(d.cover.operation,{status:'observed',observedAt:f.now,observedReceivedAt:f.now,observedAdmittedAt:f.now});f.sendDoorUpdate();return true;})()`);
      await until(`document.querySelector('${bay(side)}').dataset.motion==='opening'`);
      assert.equal(await evaluate('window.equipmentUiFixture.responses'), reportsBefore, 'Contact updates do not wait for or request a full dashboard refresh');
      assert.ok(await evaluate('performance.now()-window.equipmentUiFixture.watchPublishedAt') < 500, 'Opening is rendered within 500ms of the admitted event');
      assert.ok(await progress(side) >= 0 && await progress(side) < 0.05, 'Opening begins a full stroke at the open report, without receipt catch-up');
      assert.equal(await evaluate(`document.querySelector('${bay(side)}').dataset.state`), 'moving');
      assert.equal(await evaluate(`document.querySelector('#garage-doors-dialog .garage-door-row[data-side="${side}"] button').disabled`), true, 'Unsupported reversal is unavailable during estimated opening');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('${bay(side)} .garage-door-motion')).display!=='none'`), true, 'Native not-closed contact displays the up arrows');
      await until('Boolean(window.equipmentUiFixture.watchPending)');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=500;
        d.available=false;d.cover.available=false;d.cover.sourceTimePending=true;f.sendDoorUpdate();return true;})()`);
      await until('Boolean(window.equipmentUiFixture.watchPending)');
      for (const scope of ['#garage-doors-shortcut', '#garage-doors-dialog'])
        assert.equal(await evaluate(`document.querySelector('${scope} .garage-door-row[data-side="${side}"]').dataset.motion`), 'opening', 'A timestamp wait keeps both shutters moving');
      assert.ok(await progress(side) > 0 && await progress(side) < 0.15, 'A pending repeated report cannot jump to fully open');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=70;
        d.available=true;d.cover.available=true;d.cover.sourceTimePending=false;f.sendDoorUpdate();return true;})()`);
      await until('Boolean(window.equipmentUiFixture.watchPending)');
      assert.ok(await progress(side) > 0 && await progress(side) < 0.15, 'Admission preserves the remaining stroke');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=500;
        d.cover.operation={action:'close',status:'published',acknowledgement:'mqtt-write',startingContact:1,requestedAt:f.now-100,dispatchedAt:f.now-90,acknowledgedAt:f.now-80,
          deviceReceipt:{action:'close',executed:true,sourceTime:f.now-50,receivedAt:f.now,admittedAt:f.now}};
        f.sendDoorUpdate();return true;})()`);
      await until(`document.querySelector('${bay(side)}').dataset.motion==='closing'`);
      assert.ok(await evaluate('performance.now()-window.equipmentUiFixture.watchPublishedAt') < 500, 'Closing starts on the receipt without waiting for a sensor edge');
      assert.equal(await evaluate(`document.querySelector('${bay(side)}').dataset.state`), 'moving');
      await until('Boolean(window.equipmentUiFixture.watchPending)');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=500;
        for(const r of Object.values(d.readings)){r.value=0;r.coverState='closed';r.observedAt=f.now;r.receivedAt=f.now;}
        d.cover.operation.status='observed';f.sendDoorUpdate();return true;})()`);
      await until(`document.querySelector('${bay(side)}').dataset.state==='closed'`);
      assert.ok(await evaluate('performance.now()-window.equipmentUiFixture.watchPublishedAt') < 500, 'Closed contact renders immediately');
      assert.equal(await progress(side), 0);
      assert.equal(await evaluate(`document.querySelector('#garage-doors-dialog .garage-door-row[data-side="${side}"]').dataset.state`), 'closed');
      await until('Boolean(window.equipmentUiFixture.watchPending)');
    }
    // A view initialized after RF opening must ignore historical Close clocks.
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.retainedCloses={};
      for(const d of f.devices.filter(d=>d.kind==='door')) {
        const r=Object.values(d.readings)[0];
        f.retainedCloses[d.id]={...d.cover.operation,observedAt:r.observedAt,observedReceivedAt:r.receivedAt,observedAdmittedAt:r.receivedAt};
        d.cover.operation=null;d.available=false;d.cover.available=false;
      }f.sendDoorUpdate();return true;})()`);
    await until(`[...document.querySelectorAll('#garage-doors-shortcut .garage-door-row')].every(n=>n.dataset.state==='unknown')`);
    await until('Boolean(window.equipmentUiFixture.watchPending)');
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.now+=120000;
      for(const d of f.devices.filter(d=>d.kind==='door')) {
        d.cover.operation=f.retainedCloses[d.id];d.available=true;d.cover.available=true;
        for(const r of Object.values(d.readings)){r.value=d.id==='door1'?1:0;r.coverState=r.value?'open':'closed';r.observedAt=f.now;r.receivedAt=f.now;}
      }delete f.retainedCloses;f.sendDoorUpdate();return true;})()`);
    await until(`document.querySelector('${bay('right')}').dataset.state==='open'`);
    await evaluate("document.getElementById('garage-doors-shortcut').click();true");
    await until("document.getElementById('garage-doors-dialog').open");
    for (const scope of ['#garage-doors-shortcut', '#garage-doors-dialog']) {
      assert.equal(await evaluate(`new DOMMatrix(getComputedStyle(document.querySelector('${scope} .garage-door-row[data-side="right"] .garage-door-leaf')).transform).m42`), -96,
        'A retained completed Close cannot leave an externally opened door drawn closed');
      assert.equal(await evaluate(`document.querySelector('${scope} .garage-door-row[data-side="left"]').dataset.state`), 'closed');
    }
    await evaluate("document.getElementById('garage-doors-back').click();true");
    await until('Boolean(window.equipmentUiFixture.watchPending)');
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.now+=1000;
      for(const d of f.devices.filter(d=>d.kind==='door'))
        for(const r of Object.values(d.readings)){r.value=0;r.coverState='closed';r.observedAt=f.now;r.receivedAt=f.now;}
      f.sendDoorUpdate();return true;})()`);
    await until(`[...document.querySelectorAll('.garage-door-row[data-side]')].every(n=>n.dataset.state==='closed')`);
    await until('Boolean(window.equipmentUiFixture.watchPending)');
    // No source report arrives at the estimated fully-open instant. Both
    // surfaces must finish their labels/arrows without a dashboard poll.
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.savedTravel=f.status.garage;f.status.garage={...f.status.garage,doorTravelSeconds:1};return true;})()`);
    await refresh(); await until('Boolean(window.equipmentUiFixture.watchPending)');
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.now+=1000;
      for(const d of f.devices.filter(d=>d.kind==='door')) {
        d.cover.operation={action:'open',status:'observed',acknowledgement:'mqtt-write',startingContact:0,
          observedAt:f.now,observedReceivedAt:f.now,observedAdmittedAt:f.now,
          requestedAt:f.now-100,dispatchedAt:f.now-90,deviceReceipt:{action:'open',executed:true,sourceTime:f.now-50,receivedAt:f.now,admittedAt:f.now}};
        for(const r of Object.values(d.readings)){r.value=1;r.coverState='open';r.observedAt=f.now;r.receivedAt=f.now;}
      }f.sendDoorUpdate();return true;})()`);
    await until(`[...document.querySelectorAll('#garage-doors-shortcut .garage-door-row')].every(n=>n.dataset.motion==='opening')`);
    const reports = await evaluate('window.equipmentUiFixture.responses');
    await until(`[...document.querySelectorAll('#garage-doors-dialog .garage-door-row button')].every(n=>n.dataset.coverAction==='close'&&!n.disabled)`);
    assert.equal(await evaluate('window.equipmentUiFixture.responses'), reports, 'Both estimated opening phases complete without a full refresh');
    assert.equal(await evaluate(`[...document.querySelectorAll('.garage-door-row[data-side]')].every(n=>n.dataset.state==='open'&&getComputedStyle(n.querySelector('.garage-door-motion')).display==='none')`), true);
  } finally {
    await evaluate(`(() => {const f=window.equipmentUiFixture;window.fetch=f.savedDoorWatch.fetch;f.response=f.savedDoorWatch.response;if(f.savedTravel){f.status.garage=f.savedTravel;delete f.savedTravel;}return true;})()`);
    await refresh();
    await evaluate('delete window.equipmentUiFixture.savedDoorWatch;true');
  }
}
