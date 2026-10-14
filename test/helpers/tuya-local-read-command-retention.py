"""Current continuous status/retry/command producer; memory transport only.

The actual native loop and SDK run at the controlled validated-frame boundary.
No Home Assistant runtime, real network or household command is used.
"""
import asyncio
import importlib.util
import pathlib
import socket
import sys
import unittest
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'refresh', ROOT / 'test/helpers/tuya-local-status-refresh.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class ReadCommandRetentionTests(unittest.TestCase):
    async def failure(self, requests, revoke=None, remove=False, sent_setup=False, initial_selection=False):
        f=h.Loop();f.step=30_100;f.end_at=30_100
        attempts=0;tasks=[];entries=[];retained=[]
        if initial_selection:
            native=h.q.o.extracted_class(h.q.o.PATCHED['device.py'],'TuyaLocalDevice',
                {'_rotate_api_protocol_version'},f.d._set_values.__globals__ | {
                    'API_PROTOCOL_VERSIONS':[3.3,3.1,3.2,3.4,3.5,3.22,3.42,3.52]})
            sdk=h.q.o.extracted_class(h.q.SOURCE.read_bytes(),'XenonDevice',{'set_version'},
                {'H':SimpleNamespace(PROTOCOL_3x_HEADER=bytes(12))})
            f.d._rotate_api_protocol_version=native._rotate_api_protocol_version.__get__(f.d)
            f.n.set_version=sdk.set_version.__get__(f.n)
            f.d._api_protocol_version_index=None
            f.n.version=3.1
        async def send():
            await f.d._retry_on_failed_connection(f.d._set_values,'synthetic command')
        if sent_setup:
            h.q.o.CLOCK[0]=(h.BASE+30_000)/1000
            f.d._add_properties_to_pending_updates({'2':55})
            await send()
            self.assertTrue(f.d._pending_updates['2']['sent'])
        async def executor(fn):
            nonlocal attempts
            if fn.__name__=='_status_for_local_observations':
                attempts+=1
                if initial_selection:
                    self.assertEqual(f.n.version,3.3)
                    self.assertEqual(f.d._api_protocol_version_index,0)
                if attempts==3:
                    for request in requests:
                        f.d._add_properties_to_pending_updates(request)
                        entries.append({key:f.d._pending_updates[key] for key in request})
                        tasks.append(asyncio.create_task(send()))
                        for _ in range(100):
                            if len(f.d._api_lock._waiters or ())==len(tasks):break
                            await asyncio.sleep(0)
                        self.assertEqual(len(f.d._api_lock._waiters),len(tasks))
                    if remove:f.d._pending_updates.clear()
                    if revoke:revoke(f)
                f.n._receive=lambda:(_ for _ in ()).throw(socket.timeout())
        f.executor_hook=executor
        async def sleep(current):
            if attempts==3:
                for task in tasks:await task
                retained.append(dict(f.d._pending_updates))
                current.d._running=False
        f.on_sleep=sleep
        try:await f.run()
        finally:
            for task in tasks:await task
        self.assertEqual(attempts,3)
        self.assertEqual(f.received,[])
        return f,entries,retained[0]

    def test_opposite_same_value_and_multi_field_requests_keep_only_latest_unsent_entries(self):
        for requests in (({'1':True},{'1':False}),({'1':False},{'1':False}),
                         ({'1':True,'6':51},{'1':False,'6':49})):
            with self.subTest(requests=requests):
                f,entries,pending=asyncio.run(self.failure(requests))
                self.assertEqual(f.commands,[requests[-1]])
                for key,entry in entries[-1].items():
                    self.assertIs(pending[key],entry);self.assertTrue(entry['sent'])
                    self.assertFalse(entries[0][key]['sent'])

    def test_removed_requests_are_not_recreated_by_terminal_read_cleanup(self):
        f,entries,pending=asyncio.run(self.failure(({'1':False},),remove=True))
        self.assertEqual(f.commands,[]);self.assertEqual(pending,{})
        self.assertFalse(entries[0]['1']['sent'])

    def test_terminal_read_retains_unsent_intent_without_carrying_sent_overlay(self):
        f,entries,pending=asyncio.run(self.failure(({'1':False},),sent_setup=True))
        self.assertEqual(f.commands,[{'2':55},{'1':False}])
        self.assertNotIn('2',pending)
        self.assertIs(pending['1'],entries[0]['1'])

    def test_actual_initial_protocol_selection_precedes_the_read_source_snapshot(self):
        f,entries,pending=asyncio.run(self.failure(({'1':False},),initial_selection=True))
        self.assertEqual(f.commands,[{'1':False}])
        self.assertIs(pending['1'],entries[0]['1'])
        self.assertEqual(f.n.version,3.3)

    def test_owner_identity_protocol_record_or_shutdown_loss_retains_no_old_request(self):
        def replace_api(f):
            replacement=h.q.SDK.__new__(h.q.SDK)
            replacement.__dict__.update(f.n.__dict__)
            f.d._api=replacement
            f.d._local_source_record['tuyadevice']=replacement
        changes={
            'owner':lambda f:f.d._local_source_record.update(stmq_observation_reader=None),
            'identity':lambda f:setattr(f.n,'id','different-synthetic-native'),
            'protocol':lambda f:setattr(f.n,'version',3.4),
            'record':lambda f:f.d._hass.data['tuya_local'].update({f.n.id:dict(f.d._local_source_record)}),
            'shutdown':lambda f:setattr(f.d._hass,'is_stopping',True),
            'API':replace_api,
            'lock':lambda f:f.d._local_source_record.update(tuyadevicelock=asyncio.Lock()),
        }
        for name,change in changes.items():
            with self.subTest(name=name):
                f,entries,pending=asyncio.run(self.failure(({'1':False},),revoke=change))
                self.assertEqual(f.commands,[]);self.assertEqual(pending,{})
                self.assertFalse(entries[0]['1']['sent'])

    def test_setting_write_terminal_failure_does_not_use_the_read_retention_gate(self):
        async def run():
            f=h.Loop();f.d._add_properties_to_pending_updates({'1':True})
            attempts=0;command=None;latest=None
            f.n._get_socket=lambda _:False
            async def send():
                await f.d._retry_on_failed_connection(f.d._set_values,'synthetic queued Off')
            async def executor(fn,*args):
                nonlocal attempts,command,latest
                if fn.__name__=='_set_values' and command is None:
                    attempts+=1
                    if attempts==3:
                        f.d._add_properties_to_pending_updates({'1':False})
                        latest=f.d._pending_updates['1']
                        command=asyncio.create_task(send())
                        for _ in range(100):
                            if f.d._api_lock._waiters:break
                            await asyncio.sleep(0)
                        self.assertEqual(len(f.d._api_lock._waiters),1)
                return fn(*args)
            f.d._hass.async_add_executor_job=executor
            await f.d._retry_on_failed_connection(f.d._set_values,'synthetic setting failure')
            self.assertEqual(attempts,3)
            self.assertIsNotNone(command);await command
            self.assertEqual(f.d._pending_updates,{})
            self.assertFalse(latest['sent'])
            self.assertEqual(len(f.n.socket.sent),1,'Only fixture initialization reached the wire')
        asyncio.run(run())

    def test_actual_periodic_status_exhaustion_keeps_a_queued_current_off_once(self):
        async def run():
            f = h.Loop()
            f.step = 30_100
            f.end_at = 30_100
            attempts = 0
            command = None
            requested = None

            async def send():
                await f.d._retry_on_failed_connection(f.d._set_values, 'synthetic Off')

            async def executor(fn):
                nonlocal attempts, command, requested
                if fn.__name__ == '_status_for_local_observations':
                    attempts += 1
                    if attempts == 3:
                        f.d._add_properties_to_pending_updates({'1': False})
                        requested = f.d._pending_updates['1']
                        command = asyncio.create_task(send())
                        for _ in range(100):
                            if f.d._api_lock._waiters:
                                break
                            await asyncio.sleep(0)
                        self.assertEqual(len(f.d._api_lock._waiters), 1)
                    f.n._receive = lambda: (_ for _ in ()).throw(socket.timeout())

            f.executor_hook = executor

            async def sleep(current):
                if attempts == 3:
                    self.assertIsNotNone(command)
                    await command
                    self.assertEqual(f.commands, [{'1': False}])
                    self.assertIs(f.d._pending_updates.get('1'), requested)
                    self.assertTrue(requested['sent'])
                    self.assertNotIn('1', f.d.local_observations)
                    current.d._running = False

            f.on_sleep = sleep
            try:
                await f.run()
            finally:
                if command:
                    await command
            self.assertEqual(attempts, 3)
            self.assertEqual(f.commands, [{'1': False}])

        asyncio.run(run())


if __name__ == '__main__':
    unittest.main(verbosity=2)
