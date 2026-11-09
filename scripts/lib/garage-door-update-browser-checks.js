import assert from 'node:assert/strict';

/** Exercise the real watch consumer and illustrations with isolated native receipts. */
export async function checkGarageDoorUpdatesBrowser({ evaluate, refresh, until, settle, setReducedMotion }) {
  await setReducedMotion?.(false);
  await evaluate(`(() => {
    const f=window.equipmentUiFixture;
    f.savedDoorWatch={fetch:window.fetch,response:f.response};f.watchRevision=1;
    for(const d of f.devices.filter(d=>d.kind==='door')) {
      d.cover.operation=null;d.available=true;
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
        d.cover.operation={action:'open',status:'published',acknowledgement:'mqtt-write',requestedAt:f.now-100,dispatchedAt:f.now-90,acknowledgedAt:f.now-80,
          deviceReceipt:{action:'open',executed:true,sourceTime:f.now-50,receivedAt:f.now,admittedAt:f.now}};
        f.sendDoorUpdate();return true;})()`);
      await until('Boolean(window.equipmentUiFixture.watchPending)'); await settle();
      assert.equal(await progress(side), 0, 'Device receipt alone keeps opening still');
      const reportsBefore = await evaluate('window.equipmentUiFixture.responses');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=3000;
        for(const r of Object.values(d.readings)){r.value=1;r.coverState='open';r.observedAt=f.now;r.receivedAt=f.now;}
        d.cover.operation.status='observed';f.sendDoorUpdate();return true;})()`);
      await until(`document.querySelector('${bay(side)}').dataset.state==='open'`);
      assert.equal(await evaluate('window.equipmentUiFixture.responses'), reportsBefore, 'Contact updates do not wait for or request a full dashboard refresh');
      assert.ok(await evaluate('performance.now()-window.equipmentUiFixture.watchPublishedAt') < 500, 'Opening is rendered within 500ms of the admitted event');
      assert.ok(await progress(side) >= 1/6 && await progress(side) < 0.3, 'Opening catches up from native receipt time');
      assert.equal(await evaluate(`document.querySelector('${bay(side)}').dataset.state`), 'open');
      await until('Boolean(window.equipmentUiFixture.watchPending)');
      await evaluate(`(() => {const f=window.equipmentUiFixture,d=f.devices.find(d=>d.id==='${id}');f.now+=500;
        d.cover.operation={action:'close',status:'published',acknowledgement:'mqtt-write',requestedAt:f.now-100,dispatchedAt:f.now-90,acknowledgedAt:f.now-80,
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
  } finally {
    await evaluate(`(() => {const f=window.equipmentUiFixture;window.fetch=f.savedDoorWatch.fetch;f.response=f.savedDoorWatch.response;return true;})()`);
    await refresh();
    await evaluate('delete window.equipmentUiFixture.savedDoorWatch;true');
  }
}
