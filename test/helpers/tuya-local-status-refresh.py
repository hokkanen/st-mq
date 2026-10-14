"""Actual current native loop/SDK at its controlled validated-frame boundary.

No real sockets/HA runtime. Separate source-pinned AES/CRC probes cover parser
reachability. Elapsed clocks, connection movement and transport replies here are
synthetic; native polling/backoff/retry constants remain the production values.
"""
import asyncio, importlib.util, logging, pathlib, socket, sys, threading, unittest
from types import SimpleNamespace
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('q', ROOT/'test/helpers/tuya-local-query-replies.py')
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
namespace = q.Device._observe_local_dps.__globals__.copy()
methods = {k for k,v in q.Device.__dict__.items() if callable(v) or isinstance(v,property)}
methods |= {'register_entity', 'pause', '_add_properties_to_pending_updates'}
q.Device = q.o.extracted_class(q.o.PATCHED['device.py'], 'TuyaLocalDevice', methods, namespace)
BASE = 1_800_000_000_000
logging.disable(logging.CRITICAL)

class Loop:
    def __init__(self, before=False, query=False, partial=False, repeat=False, poll_only=False):
        self.n, self.d = q.fixture(); self.initial = self.n.socket
        self.before, self.query, self.partial, self.repeat = before, query, partial, repeat
        self.received = []; self.queries = []; self.commands = []; self.missing = []
        self.sleeps = []; self.moved = False; self.step = 12_000
        self.end_at = 31_100; self.query_data = q.ALL; self.next_partial = 0
        self.on_sleep = None; self.stop_on_power = True; self.executor_hook = None
        self.d._hass.is_running = True; self.d._poll_only = poll_only
        self.entity = SimpleNamespace(_config=SimpleNamespace(
            _device=SimpleNamespace(config_type='electriq_desd8lw_dehumidifier'),
            entity='humidifier', dps=lambda: []),
            async_schedule_update_ha_state=lambda *args: None,
            schedule_update_ha_state=lambda: None, on_receive=self.observe)
        self.d.register_entity(self.entity)
        original_encode = self.n._encode_message
        def encode(payload):
            header = original_encode(payload)
            if header.cmd == q.CT.DP_QUERY:
                self.queries.append(self.at)
                self.n.socket.frames.append(q.frame(self.query_data, header.seqno, q.CT.DP_QUERY))
            return header
        self.n._encode_message = encode
        original_generate = self.n.generate_payload
        def generate(command, *args):
            if command == q.CT.CONTROL: self.commands.append(dict(args[0]))
            return original_generate(command, *args)
        self.n.generate_payload = generate
        def receive():
            if self.n.socket.frames:
                frame = self.n.socket.next()
                if self.query and self.queries and (not self.moved or self.repeat):
                    self.n.socket = q.Wire(); self.moved = True
                return frame
            if not self.before and not self.query and (not self.moved or self.repeat):
                self.n.socket = q.Wire(); self.moved = True
                return q.frame(q.ALL, 901, q.CT.STATUS)
            if self.partial and self.at >= self.next_partial:
                self.next_partial = self.at + 1000
                return q.frame({'6':49}, 999, q.CT.STATUS)
            raise socket.timeout()
        self.n._receive = receive
        async def executor(fn, *args):
            if self.executor_hook: await self.executor_hook(fn)
            return fn(*args)
        self.d._hass.async_add_executor_job = executor

    @property
    def at(self): return int(round(q.o.CLOCK[0]*1000)) - BASE

    def observe(self, data, full):
        observations = self.d.local_observations
        if '1' in observations and observations['1']['timestamp'] > BASE:
            self.received.append((self.at, full, observations.copy()))
            if self.stop_on_power: self.d._running = False

    async def run(self):
        q.o.CLOCK[0] = (BASE + self.step)/1000
        if self.before:
            self.n.socket = q.Wire()
            self.n.socket.frames.append(q.frame({'6':49} if self.partial else q.ALL, 901, q.CT.STATUS))
        namespace = q.Device.async_receive.__globals__; original = namespace['asyncio']
        async def sleep(seconds):
            self.sleeps.append(seconds)
            if '1' not in self.d.local_observations:
                self.missing.append((self.at, self.d._cached_state['updated_at'], self.d._last_full_poll))
            if self.on_sleep: await self.on_sleep(self)
            if self.at >= self.end_at: self.d._running = False
            q.o.CLOCK[0] = (BASE+self.at+(5000 if seconds == 5 else 100))/1000
            await asyncio.sleep(0)  # native sleeps release the real event loop
        namespace['asyncio'] = SimpleNamespace(sleep=sleep)
        try: await self.d.receive_loop()
        finally: namespace['asyncio'] = original
        return self

class StatusRefreshTests(unittest.TestCase):
    def test_unusable_power_does_not_complete_or_rearm_the_refresh_episode(self):
        for power in (None,'true',1,0):
            with self.subTest(power=power):
                f=Loop(); q.o.CLOCK[0]=(BASE+12_000)/1000
                self.assertIsNone(f.d._receive_for_local_observations())
                refresh=f.d._take_local_status_refresh(); self.assertIsNotNone(refresh)
                f.query_data=q.ALL | {'1':power}
                reply=f.d._status_for_local_observations()
                self.assertTrue(f.d._local_reply_is_current(reply))
                f.d._observe_local_dps(reply['dps'], f.d._local_reply_full)
                self.assertEqual(f.d.local_observations['1']['value'],power)
                self.assertIsNotNone(f.d._local_status_refresh)
                f.n.socket=q.Wire(); f.n.socket.frames.append(q.frame({'6':49},901,q.CT.STATUS))
                f.d._receive_for_local_observations()
                self.assertIsNone(f.d._take_local_status_refresh())
                self.assertEqual(f.queries,[12_000])

    def test_actual_current_complete_report_permits_one_later_distinct_episode(self):
        f=Loop(); q.o.CLOCK[0]=(BASE+12_000)/1000
        self.assertIsNone(f.d._receive_for_local_observations())
        self.assertIsNotNone(f.d._take_local_status_refresh())
        reply=f.d._status_for_local_observations()
        self.assertTrue(f.d._local_reply_is_current(reply))
        f.d._observe_local_dps(reply['dps'],f.d._local_reply_full)
        self.assertIsNone(f.d._local_status_refresh)
        original=f.d.local_observations.copy()
        q.o.CLOCK[0]+=.1; f.n.socket=q.Wire()
        f.n.socket.frames.append(q.frame({'6':49},901,q.CT.STATUS))
        reply=f.d._receive_for_local_observations()
        self.assertTrue(f.d._local_reply_is_current(reply))
        f.d._observe_local_dps(reply['dps'],f.d._local_reply_full)
        self.assertNotIn('1',f.d.local_observations)
        self.assertIsNotNone(f.d._take_local_status_refresh())
        self.assertEqual(original['1']['timestamp'],BASE+12_000)

    def test_partial_native_fields_and_cache_overlay_do_not_finish_the_episode(self):
        f=Loop(); q.o.CLOCK[0]=(BASE+12_000)/1000
        self.assertIsNone(f.d._receive_for_local_observations())
        self.assertIsNotNone(f.d._take_local_status_refresh())
        f.d._cached_state.update(q.ALL)
        f.d._add_properties_to_pending_updates({'1':True})
        f.n.socket.frames.append(q.frame({'6':49},901,q.CT.STATUS))
        reply=f.d._receive_for_local_observations()
        self.assertTrue(f.d._local_reply_is_current(reply))
        f.d._observe_local_dps(reply['dps'],f.d._local_reply_full)
        self.assertTrue(f.d.get_property('1'))
        self.assertNotIn('1',f.d.local_observations)
        self.assertIsNotNone(f.d._local_status_refresh)
        self.assertIsNone(f.d._take_local_status_refresh())

    def test_only_current_registered_supported_exclusive_persistent_source_requests_refresh(self):
        changes={
            'other profile':lambda f:setattr(f.entity._config._device,'config_type','other'),
            'other entity':lambda f:setattr(f.entity._config,'entity','sensor'),
            'removed entity':lambda f:f.d._children.clear(),
            'protocol':lambda f:setattr(f.n,'version',3.4),
            'forced dps':lambda f:setattr(f.d,'_force_dps',['6']),
            'child':lambda f:setattr(f.d,'dev_cid','synthetic-child'),
            'API children':lambda f:setattr(f.n,'children',{'synthetic-child':object()}),
            'shared owner':lambda f:f.d._local_source_record.update(stmq_observation_reader=None),
            'changed lock':lambda f:f.d._local_source_record.update(tuyadevicelock=asyncio.Lock()),
            'selected record':lambda f:f.d._hass.data['tuya_local'].update({f.n.id:dict(f.d._local_source_record)}),
            'temporary poll':lambda f:setattr(f.d,'_temporary_poll',True),
            'stopped':lambda f:setattr(f.d,'_running',False),
        }
        for label,change in changes.items():
            with self.subTest(label=label):
                f=Loop(); change(f); q.o.CLOCK[0]=(BASE+12_000)/1000
                self.assertIsNone(f.d._receive_for_local_observations())
                self.assertIsNone(f.d._take_local_status_refresh())
                self.assertEqual(f.queries,[])
                self.assertNotIn('1',f.d.local_observations)

    def test_movement_or_late_command_before_first_extra_native_attempt_cancels_without_timer_renewal(self):
        def replace_api(f):
            replacement=q.SDK.__new__(q.SDK)
            replacement.__dict__.update(f.n.__dict__)
            f.d._api=replacement
        def replace_selected_record(f):
            old=f.d._local_source_record
            new=dict(old)
            self.assertIsNot(new,old);self.assertEqual(new,old)
            f.d._hass.data['tuya_local'][f.n.id]=new
            f.d._local_source_record=new
        changes={
            'socket':lambda f:setattr(f.n,'socket',q.Wire()),
            'protocol':lambda f:setattr(f.n,'version',3.4),
            'owner':lambda f:f.d._local_source_record.update(stmq_observation_reader=None),
            'entity':lambda f:f.d._children.clear(),
            'API':replace_api,
            'same-shaped selected record':replace_selected_record,
            'late Off':lambda f:f.d._add_properties_to_pending_updates({'1':False}),
        }
        for label,change in changes.items():
            with self.subTest(label=label):
                async def run():
                    f=Loop(); f.end_at=12_100; attempted=[]; admission=[]
                    async def executor(fn):
                        if fn.__name__=='status_call':change(f);attempted.append(fn)
                    f.executor_hook=executor
                    async def sleep(current):
                        if attempted:
                            admission.append(current.d._last_full_poll)
                            self.assertEqual(current.d._last_full_poll,BASE/1000)
                            if label=='late Off':
                                self.assertEqual(current.d._get_unsent_properties(),{'1':False})
                    f.on_sleep=sleep
                    await f.run()
                    self.assertEqual(len(attempted),1)
                    self.assertEqual(f.queries,[])
                    self.assertEqual(f.received,[])
                    self.assertEqual(admission,[BASE/1000])
                    self.assertEqual(f.commands,[])
                    self.assertEqual(f.d._last_full_poll,0,'Native monitor exit still resets its cache')
                asyncio.run(run())

    def test_cancellation_before_added_read_keeps_unknown_fields_and_sends_no_pending_command(self):
        async def run():
            f=Loop(); entry=None
            async def executor(fn):
                nonlocal entry
                if fn.__name__=='status_call':
                    f.d._add_properties_to_pending_updates({'1':False})
                    entry=f.d._pending_updates['1']
                    self.assertEqual(f.d._last_full_poll,BASE/1000)
                    raise asyncio.CancelledError()
            f.executor_hook=executor
            with self.assertRaises(asyncio.CancelledError):await f.run()
            self.assertFalse(f.d._api_lock.locked())
            self.assertEqual(f.queries,[]);self.assertEqual(f.commands,[])
            self.assertNotIn('1',f.d.local_observations)
            self.assertEqual(f.d._last_full_poll,0,'Native monitor exit still resets its cache')
            self.assertEqual(f.d._pending_updates,{})
            self.assertFalse(entry['sent'])
        asyncio.run(run())

    def test_actual_lock_wait_clear_pause_or_shutdown_cancels_first_refresh_dispatch(self):
        for revoke in ('generation','pause','shutdown'):
            with self.subTest(revoke=revoke):
                async def run():
                    f=Loop();f.end_at=12_100;owned=[];revoked=[]
                    async def release_after_native_waiter():
                        try:
                            for _ in range(100):
                                if len(f.d._api_lock._waiters or ())==1:break
                                await asyncio.sleep(0)
                            self.assertEqual(len(f.d._api_lock._waiters),1)
                            if revoke=='generation':f.d._clear_local_observations('connection-paused')
                            elif revoke=='pause':f.d.pause()
                            else:f.d._hass.is_stopping=True
                            revoked.append(f.at)
                        finally:f.d._api_lock.release()
                    async def sleep(current):
                        if current.at==12_000:
                            await current.d._api_lock.acquire()
                            owned.append(asyncio.create_task(release_after_native_waiter()))
                    f.on_sleep=sleep
                    try:await f.run()
                    finally:
                        for task in owned:await task
                    self.assertEqual(revoked,[12_100])
                    self.assertEqual(f.queries,[]);self.assertEqual(f.commands,[])
                    self.assertEqual(f.received,[]);self.assertNotIn('1',f.d.local_observations)
                    self.assertFalse(f.d._api_lock.locked())
                asyncio.run(run())

    def test_added_and_ordinary_full_read_keep_the_same_native_lock_for_late_superseding_off(self):
        for added in (False,True):
            with self.subTest(added=added):
                async def run():
                    f=Loop(); f.step=12_000 if added else 30_100
                    entered=threading.Event(); release=threading.Event()
                    original_receive=f.n._receive; tasks=[]; entries=[]; jobs=[]
                    def receive():
                        if f.queries:
                            entered.set()
                            if not release.wait(2):raise AssertionError('owned read gate not released')
                        return original_receive()
                    f.n._receive=receive
                    async def command():
                        await f.d._retry_on_failed_connection(f.d._set_values,'synthetic Off')
                    async def executor(fn,*args):
                        status=fn.__name__==('status_call' if added else '_status_for_local_observations')
                        if not status:return fn(*args)
                        task=asyncio.create_task(asyncio.to_thread(fn,*args));jobs.append(task)
                        try:
                            self.assertTrue(await asyncio.to_thread(entered.wait,2))
                            self.assertTrue(f.d._api_lock.locked())
                            for value in (True,False):
                                f.d._add_properties_to_pending_updates({'1':value})
                                entries.append(f.d._pending_updates['1'])
                                tasks.append(asyncio.create_task(command()))
                                for _ in range(100):
                                    if len(f.d._api_lock._waiters or ())==len(tasks):break
                                    await asyncio.sleep(0)
                                self.assertEqual(len(f.d._api_lock._waiters),len(tasks))
                            self.assertEqual(f.commands,[])
                            q.o.CLOCK[0]+=.4
                            release.set()
                            return await task
                        finally:
                            release.set()
                            await task
                    f.d._hass.async_add_executor_job=executor
                    async def sleep(current):
                        if tasks:
                            for task in tasks:await task
                    f.on_sleep=sleep
                    try:await f.run()
                    finally:
                        release.set()
                        for task in jobs+tasks:await task
                    self.assertEqual(f.commands,[{'1':False}])
                    self.assertFalse(entries[0]['sent']);self.assertTrue(entries[1]['sent'])
                    self.assertEqual(len(f.queries),1)
                    self.assertEqual(f.received[0][2]['1']['timestamp'],BASE+f.queries[0]+400)
                    self.assertFalse(f.d._api_lock.locked())
                asyncio.run(run())

    def test_late_added_read_after_clear_or_owner_movement_cannot_admit_or_rearm(self):
        for moved in ('generation','owner','socket'):
            with self.subTest(moved=moved):
                async def run():
                    f=Loop();f.end_at=12_100;entry=threading.Event();release=threading.Event()
                    original=f.n._receive;jobs=[]
                    def receive():
                        reply=original()
                        if f.queries:
                            entry.set()
                            if not release.wait(2):raise AssertionError('owned read gate not released')
                        return reply
                    f.n._receive=receive
                    async def executor(fn,*args):
                        if fn.__name__!='status_call':return fn(*args)
                        task=asyncio.create_task(asyncio.to_thread(fn,*args));jobs.append(task)
                        try:
                            self.assertTrue(await asyncio.to_thread(entry.wait,2))
                            if moved=='generation':f.d._clear_local_observations('connection-paused')
                            elif moved=='owner':f.d._local_source_record['stmq_observation_reader']=None
                            else:f.n.socket=q.Wire()
                            release.set();return await task
                        finally:
                            release.set();await task
                    f.d._hass.async_add_executor_job=executor
                    try:await f.run()
                    finally:
                        release.set()
                        for task in jobs:await task
                    self.assertEqual(f.received,[]);self.assertNotIn('1',f.d.local_observations)
                    self.assertEqual(f.queries,[12_100]);self.assertEqual(f.commands,[])
                    self.assertIsNotNone(f.d._local_status_refresh)
                    self.assertIsNone(f.d._local_status_refresh[1])
                    self.assertFalse(f.d._api_lock.locked())
                asyncio.run(run())

    def test_cancellation_during_owned_executor_read_revokes_its_late_reply(self):
        async def run():
            f=Loop();entered=threading.Event();release=threading.Event();jobs=[]
            original=f.n._receive
            def receive():
                reply=original()
                if f.queries:
                    entered.set()
                    if not release.wait(2):raise AssertionError('owned read gate not released')
                return reply
            f.n._receive=receive
            async def executor(fn,*args):
                if fn.__name__!='status_call':return fn(*args)
                task=asyncio.create_task(asyncio.to_thread(fn,*args));jobs.append(task)
                return await asyncio.shield(task)
            f.d._hass.async_add_executor_job=executor
            runner=asyncio.create_task(f.run())
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait,2))
                self.assertTrue(f.d._api_lock.locked())
                runner.cancel()
                with self.assertRaises(asyncio.CancelledError):await runner
                self.assertFalse(f.d._api_lock.locked())
                release.set()
                self.assertEqual([await task for task in jobs],[None])
                self.assertEqual(f.received,[]);self.assertNotIn('1',f.d.local_observations)
                self.assertEqual(f.queries,[12_100]);self.assertEqual(f.commands,[])
                self.assertIsNone(f.d._local_status_refresh[1])
            finally:
                release.set()
                for task in jobs:await task
                if not runner.done():runner.cancel()
        asyncio.run(run())

    def test_terminal_added_read_source_loss_does_not_retain_old_pending_entries(self):
        for loss in ('owner','profile'):
            with self.subTest(loss=loss):
                async def run():
                    f=Loop();f.end_at=12_100;attempts=0;entry=None
                    original=f.n._receive
                    def receive():
                        if not f.queries:return original()
                        if attempts==3:
                            if loss=='owner':f.d._local_source_record['stmq_observation_reader']=None
                            else:f.entity._config._device.config_type='other'
                        raise socket.timeout()
                    f.n._receive=receive
                    async def executor(fn):
                        nonlocal attempts,entry
                        if fn.__name__=='status_call':
                            attempts+=1
                            if attempts==3:
                                f.d._add_properties_to_pending_updates({'1':False})
                                entry=f.d._pending_updates['1']
                    f.executor_hook=executor
                    async def sleep(current):
                        if attempts==3:
                            self.assertEqual(current.d._pending_updates,{})
                            self.assertEqual(current.d._api_working_protocol_failures,1)
                    f.on_sleep=sleep
                    await f.run()
                    self.assertEqual(attempts,3);self.assertFalse(entry['sent'])
                    self.assertEqual(f.commands,[]);self.assertEqual(f.received,[])
                asyncio.run(run())

    def test_current_loop_recovers_with_one_new_full_query_and_original_field_clocks(self):
        f = asyncio.run(Loop().run())
        self.assertEqual(f.queries, [12_100])
        self.assertEqual(f.missing[0], (12_000, BASE/1000, BASE/1000))
        at, full, observations = f.received[0]
        self.assertEqual(at, 12_100); self.assertTrue(full)
        self.assertEqual({observations[k]['timestamp'] for k in q.ALL}, {BASE+12_100})
        self.assertEqual(f.commands, [])

    def test_before_call_socket_change_with_partial_report_requests_a_full_query(self):
        f = asyncio.run(Loop(before=True, partial=True).run())
        self.assertEqual(f.queries, [12_100]); self.assertTrue(f.received[0][1])

    def test_before_call_complete_current_report_satisfies_recovery_without_extra_query(self):
        f = asyncio.run(Loop(before=True).run())
        self.assertEqual(f.queries, []); self.assertEqual(f.received[0][0], 12_000)

    def test_a_current_scheduled_query_serves_pre_call_withdrawal_without_an_extra(self):
        f = Loop(before=True, partial=True); f.step=30_100
        f = asyncio.run(f.run())
        self.assertEqual(f.queries, [30_100]); self.assertTrue(f.received[0][1])

    def test_pending_refresh_and_due_normal_poll_share_one_current_status_read(self):
        f=Loop();q.o.CLOCK[0]=(BASE+12_000)/1000
        self.assertIsNone(f.d._receive_for_local_observations())
        f.step=30_100;f.query_data=q.ALL | {'1':False}
        f=asyncio.run(f.run())
        self.assertEqual(f.queries,[30_100]);self.assertTrue(f.received[0][1])
        self.assertIs(f.received[0][2]['1']['value'],False)
        self.assertEqual(f.received[0][2]['1']['timestamp'],BASE+30_100)

    def test_replaced_status_reply_is_discarded_then_one_current_query_recovers(self):
        f = Loop(query=True); f.step=30_100; f.d._cached_state['updated_at']=(BASE+29_900)/1000
        f = asyncio.run(f.run())
        self.assertEqual(f.queries, [30_100,30_200])
        self.assertEqual(f.received[0][0],30_200)

    def test_repeated_socket_replacement_does_not_rearm_early_queries(self):
        f=Loop(query=True,repeat=True);f.step=30_100
        f.d._cached_state['updated_at']=(BASE+29_900)/1000
        f.partial=True;f.end_at=31_000
        f=asyncio.run(f.run())
        self.assertEqual(f.queries,[30_100,30_200]);self.assertEqual(f.received,[])

    def test_a_full_omission_stays_unknown_without_repeated_extra_queries(self):
        f=Loop();f.query_data={'6':49};f.end_at=13_000
        f=asyncio.run(f.run())
        self.assertEqual(f.queries,[12_100]);self.assertEqual(f.received,[])

    def test_poll_only_keeps_its_existing_poll_and_backoff_path(self):
        f=asyncio.run(Loop(poll_only=True).run())
        self.assertEqual(f.queries,[32_000]);self.assertIn(5,f.sleeps)

    def test_extra_query_defers_to_an_existing_current_off_entry(self):
        async def run():
            f=Loop();f.d._add_properties_to_pending_updates({'1':False})
            entry=f.d._pending_updates['1']
            async def sleep(current):
                if current.at==12_000:
                    self.assertEqual(current.queries,[])
                    await current.d._retry_on_failed_connection(current.d._set_values,'synthetic Off')
            f.on_sleep=sleep;await f.run()
            self.assertEqual(f.commands,[{'1':False}]);self.assertEqual(f.queries,[12_100])
            self.assertTrue(entry['sent'])
        asyncio.run(run())

    def test_terminal_added_read_failure_preserves_late_superseding_off_once(self):
        async def run():
            f=Loop();f.end_at=12_100;attempts=0;queued=[];latest=None;old=None
            async def send():
                await f.d._retry_on_failed_connection(f.d._set_values,'synthetic command')
            async def executor(fn):
                nonlocal attempts,latest,old
                if fn.__name__=='status_call':
                    attempts+=1
                    if attempts==3:
                        for value in (True,False):
                            f.d._add_properties_to_pending_updates({'1':value})
                            if value:old=f.d._pending_updates['1']
                            else:latest=f.d._pending_updates['1']
                            queued.append(asyncio.create_task(send()))
                            for _ in range(20):
                                if len(f.d._api_lock._waiters or ())==len(queued):break
                                await asyncio.sleep(0)
                            self.assertEqual(len(f.d._api_lock._waiters),len(queued))
                    # Real SDK status send/read/retry fails at its current
                    # validated-frame transport boundary, not a fake success.
                    f.n._receive=lambda:(_ for _ in ()).throw(socket.timeout())
            f.executor_hook=executor
            async def sleep(current):
                if attempts==3:
                    for task in queued:await task
                    current.d._running=False
            f.on_sleep=sleep
            await f.run()
            for task in queued:await task
            self.assertEqual(attempts,3)
            self.assertEqual(f.commands[-1],{'1':False})
            self.assertEqual(f.commands.count({'1':False}),1)
            self.assertIsNot(latest,old);self.assertFalse(old['sent'])
            self.assertTrue(latest['sent'])
        asyncio.run(run())

if __name__=='__main__': unittest.main(verbosity=2)
