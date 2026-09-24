import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationUrl, usesHomeAssistantLogin, authenticationMessage, createPollingRequest,
  fetchJsonResponse, withReadDeadline, createEventStream, createCommunicationWatch } from '../chart/network.js';
import { getEventListeners } from 'node:events';
import { chartQuery } from '../chart/history-model.js';

test('dashboard requests retain the Home Assistant ingress prefix for reads and mutations', () => {
  const base = 'https://home.example/api/hassio_ingress/example-session/';
  for (const path of ['/api/status', '/api/events?after=4&limit=50', '/api/settings/reload',
    '/api/fireplace', '/api/fireplace/remove', '/api/temporary', '/api/heating-test',
    '/api/test/h66', '/api/recording-overview', '/api/energy-audits',
    chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'power' }),
    'share/st-mq/easee.csv', './share/st-mq/st-mq.csv']) {
    const url = new URL(applicationUrl(path, base));
    assert.equal(url.origin, 'https://home.example');
    assert.ok(url.pathname.startsWith('/api/hassio_ingress/example-session/'));
    assert.equal(url.search, new URL(path, 'https://example.invalid').search);
  }
});

test('standalone API paths remain local with root and index document URLs', () => {
  for (const base of ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234/index.html']) {
    assert.equal(applicationUrl('/api/status', base), 'http://127.0.0.1:1234/api/status');
  }
});

test('ingress login errors direct users back to Home Assistant without requesting an application token', () => {
  assert.equal(usesHomeAssistantLogin('/api/hassio_ingress/example-session/'), true);
  assert.equal(usesHomeAssistantLogin('/api/hassio_ingress/example-session/index.html'), true);
  for (const path of ['/', '/index.html', '/api/status', '/api/hassio_ingress/']) assert.equal(usesHomeAssistantLogin(path), false);
  assert.match(authenticationMessage(true), /Reopen ST-MQ from the host dashboard/);
  assert.doesNotMatch(authenticationMessage(true), /access token/);
  assert.match(authenticationMessage(false), /access token/);
});

test('slow status reads survive repeated timer polls without accumulating requests', async () => {
  const requests = [];
  const poll = createPollingRequest(() => new Promise(resolve => requests.push(resolve)));
  const first = poll();
  await Promise.resolve();
  for (let interval = 0; interval < 10; interval++) assert.equal(poll({ background: true }), null);
  assert.equal(requests.length, 1);
  requests[0]({ ready: true });
  assert.deepEqual(await first, { ready: true });
  const next = poll({ background: true });
  await Promise.resolve();
  assert.equal(requests.length, 2, 'Polling resumes as soon as the status fetch settles');
  requests[1]({ ready: true });
  await next;
});

test('explicit login refresh can supersede a pending status read and failures release polling', async () => {
  const requests = [];
  const poll = createPollingRequest(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const beforeLogin = poll({ background: true });
  const afterLogin = poll();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[0].resolve({ authenticated: false });
  await beforeLogin;
  assert.equal(poll({ background: true }), null, 'An obsolete response cannot release a newer pending read');
  const failed = assert.rejects(afterLogin, /temporarily unavailable/);
  requests[1].reject(new Error('temporarily unavailable'));
  await failed;
  const retried = poll({ background: true });
  await Promise.resolve();
  assert.equal(requests.length, 3);
  requests[2].resolve({ authenticated: true });
  assert.deepEqual(await retried, { authenticated: true });
});

test('GET deadlines cover an unsettled fetch or body and release polling for recovery', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const body of [false,true]) {
    let calls=0, blocked=true, requestSignal;
    const fetchImpl=async (_url,{signal}) => {
      calls++;requestSignal=signal;
      if(blocked&&!body)return new Promise(()=>{});
      return {json:()=>blocked?new Promise(()=>{}):Promise.resolve({ok:true})};
    };
    const poll=createPollingRequest(({signal})=>fetchJsonResponse('/fixture',{signal},{fetchImpl,timeoutMs:20}),{timeoutMs:30});
    const first=poll(), rejected=assert.rejects(first,{name:'TimeoutError'});
    await Promise.resolve();await Promise.resolve();
    assert.equal(poll({background:true}),null);
    t.mock.timers.tick(20);await rejected;
    assert.equal(requestSignal.aborted,true);blocked=false;
    assert.deepEqual((await poll({background:true})).result,{ok:true});assert.equal(calls,2);
  }
});

test('caller cancellation composes with deadlines and removes abort listeners on every settlement', async () => {
  const caller=new AbortController();let underlying;
  const pending=withReadDeadline(signal=>{underlying=signal;return new Promise(()=>{});},{signal:caller.signal});
  await Promise.resolve();const rejected=assert.rejects(pending,{name:'AbortError'});caller.abort();await rejected;
  assert.equal(underlying.aborted,true);assert.equal(getEventListeners(caller.signal,'abort').length,0);
  const success=new AbortController();assert.equal(await withReadDeadline(()=>12,{signal:success.signal}),12);
  assert.equal(getEventListeners(success.signal,'abort').length,0);
  const failure=new AbortController();await assert.rejects(withReadDeadline(()=>{throw Error('fixture');},{signal:failure.signal}),/fixture/);
  assert.equal(getEventListeners(failure.signal,'abort').length,0);
});

test('the shared GET deadline neither retries nor declares a pending mutation failed', async t => {
  t.mock.timers.enable({apis:['setTimeout']});let finish,calls=0,settled=false;
  const pending=fetchJsonResponse('/fixture',{method:'POST',body:'{}'},{timeoutMs:10,fetchImpl:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  pending.then(()=>{settled=true;});t.mock.timers.tick(100000);await Promise.resolve();
  assert.equal(calls,1);assert.equal(settled,false);finish({json:async()=>({accepted:true})});
  assert.equal((await pending).result.accepted,true);
});

test('events are single flight, deduplicated and protected against retired successes and failures', async () => {
  const requests=[],visible=[];
  const stream=createEventStream({request:(after,{signal})=>new Promise((resolve,reject)=>requests.push({after,signal,resolve,reject})),
    append:rows=>visible.push(...rows.map(row=>row.id)),reset:()=>{visible.length=0;}});
  stream.reset('first');const first=stream.poll();assert.equal(stream.poll(),first);await Promise.resolve();
  requests[0].resolve([{id:2},{id:1},{id:2}]);await first;assert.deepEqual(visible,[1,2]);assert.equal(stream.cursor(),2);
  const old=stream.poll();await Promise.resolve();assert.equal(requests[1].after,2);
  stream.reset('first');assert.equal(stream.poll(),old,'Ordinary status polling keeps useful work');
  stream.reset('replacement');const newer=stream.poll();await Promise.resolve();assert.equal(requests[2].after,0);
  requests[2].resolve([{id:1}]);await newer;requests[1].resolve([{id:900}]);await old;
  assert.deepEqual(visible,[1]);assert.equal(stream.cursor(),1);
  const failure=stream.poll();await Promise.resolve();stream.reset('third');requests[3].reject(Error('obsolete'));
  await failure;assert.deepEqual(visible,[]);assert.equal(stream.cursor(),0);
  const bigger=stream.poll();await Promise.resolve();requests[4].resolve([{id:1000}]);await bigger;
  assert.deepEqual(visible,[1000]);assert.equal(stream.cursor(),1000);
  const closing=stream.poll();await Promise.resolve();stream.close();await closing;
  assert.equal(requests[5].signal.aborted,true);requests[5].resolve([{id:1001}]);await Promise.resolve();
  assert.deepEqual(visible,[1000]);
});

test('communication freshness uses local monotonic receipt time, independent of source dates', () => {
  let now=0;const watch=createCommunicationWatch({clock:()=>now,staleAfterMs:45});
  assert.equal(watch.status().available,false);now=10;watch.received();now=54;assert.equal(watch.status().stale,false);
  now=55;assert.equal(watch.status().stale,true);watch.received();assert.deepEqual(watch.status(),{available:true,ageMs:0,stale:false});
});
