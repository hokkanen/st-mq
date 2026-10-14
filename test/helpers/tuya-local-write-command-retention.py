"""Actual current native setter/retry + SDK with memory transport, no household calls.

Controlled validated-frame boundary, not new AES/CRC parser or device proof.
The three failed native attempts finish; an already queued later callback then
has a healthy memory transport. Every setup/lock/attempt assertion precedes the
expected-retention assertion. Baseline failures are intentional evidence.
"""
import asyncio
import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('current_loop', ROOT / 'test/helpers/tuya-local-status-refresh.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
methods = {key for key, value in h.q.Device.__dict__.items() if callable(value) or isinstance(value, property)}
methods |= {'_send_pending_updates'}
h.q.Device = h.q.o.extracted_class(h.q.o.PATCHED['device.py'], 'TuyaLocalDevice', methods,
    h.q.Device._set_values.__globals__)


async def scenario(requests, change=None, remove=False, sent_setup=False,
                   initial_selection=False, after_attempt=None, healthy_following=True,
                   automatic_terminal_reset=False):
    f = h.Loop()
    protocol_versions = [3.3, 3.1, 3.2, 3.4, 3.5, 3.22, 3.42, 3.52]
    if initial_selection or automatic_terminal_reset:
        native = h.q.o.extracted_class(h.q.o.PATCHED['device.py'], 'TuyaLocalDevice',
            {'_rotate_api_protocol_version'}, f.d._set_values.__globals__ | {
                'API_PROTOCOL_VERSIONS': protocol_versions})
        sdk = h.q.o.extracted_class(h.q.SOURCE.read_bytes(), 'XenonDevice', {'set_version'},
            {'H': SimpleNamespace(PROTOCOL_3x_HEADER=bytes(12))})
        f.d._rotate_api_protocol_version = native._rotate_api_protocol_version.__get__(f.d)
        f.n.set_version = sdk.set_version.__get__(f.n)
        f.d._AUTO_CONNECTION_ATTEMPTS = len(protocol_versions) * 2 + 1
    if initial_selection:
        f.d._api_protocol_version_index = None
        f.n.version = 3.1
    if automatic_terminal_reset:
        f.d._protocol_configured = 'auto'
        f.d._api_working_protocol_failures = f.d._AUTO_FAILURE_RESET_COUNT
    if sent_setup:
        f.d._add_properties_to_pending_updates({'2': 55})
        await f.d._send_pending_updates()
        if not f.d._pending_updates['2']['sent']:
            raise AssertionError('Actual preceding native send did not establish the sent overlay')
    wire_before = len([header for header in f.n.socket.sent if header.cmd == h.q.CT.CONTROL])
    f.d._add_properties_to_pending_updates({'1': True})
    original = f.d._pending_updates['1']
    attempts = 0
    queued = []
    accepted = []
    native_opens = 0
    healthy = False
    first_source = None
    first_cohort = None

    def socket_ready(_):
        nonlocal native_opens
        native_opens += 1
        return healthy
    f.n._get_socket = socket_ready

    async def executor(fn, *args):
        nonlocal attempts, first_source, first_cohort
        owned_attempt = None
        if fn.__name__ == '_set_values' and attempts < 3:
            attempts += 1
            owned_attempt = attempts
            if attempts == 1:
                if not f.d._api_lock.locked():
                    raise AssertionError('Actual first setter admission did not own the native lock')
                first_source = f.d._current_pending_command_source()
                first_cohort = f.d._get_pending_updates().copy()
                if initial_selection and (f.n.version != 3.3 or f.d._api_protocol_version_index != 0):
                    raise AssertionError('Actual initial native protocol selection did not precede admission')
            if attempts == 3:
                for request in requests:
                    f.d._add_properties_to_pending_updates(request)
                    accepted.append({key: f.d._pending_updates[key] for key in request})
                    queued.append(asyncio.create_task(f.d._send_pending_updates()))
                    for _ in range(100):
                        if len(f.d._api_lock._waiters or ()) == len(queued):
                            break
                        await asyncio.sleep(0)
                    if len(f.d._api_lock._waiters or ()) != len(queued):
                        raise AssertionError('Later callbacks did not await the actual current native lock')
                if remove:
                    f.d._pending_updates.clear()
                if change:
                    change(f)
        result = fn(*args)
        if after_attempt and owned_attempt is not None:
            after_attempt(f, owned_attempt)
        return result
    f.d._hass.async_add_executor_job = executor
    try:
        await f.d._send_pending_updates()
        expected_opens = 2 if remove else 3
        if attempts != 3 or native_opens != expected_opens or not first_source:
            raise AssertionError('Expected exact native failure budget/current dispatch source was not reached')
        if first_cohort.get('1') is not original or any(entry is original for request in accepted for entry in request.values()):
            raise AssertionError('Distinct accepted command entries lost their actual ownership identity')
        if any(key in f.d.local_observations for key in h.q.ALL):
            raise AssertionError('Terminal failure did not withdraw actual native evidence')
        healthy = healthy_following
        for task in queued:
            await task
    finally:
        for task in queued:
            if not task.done():
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    wire = [header for header in f.n.socket.sent if header.cmd == h.q.CT.CONTROL]
    return {'firstAttempts': attempts, 'nativeSocketAttempts': native_opens,
        'transportControlWrites': len(wire) - wire_before, 'queuedCallbacks': len(queued),
        'originalSent': original['sent'], 'accepted': accepted, 'pending': f.d._pending_updates,
        'generatedRequests': f.commands, 'finalProtocol': f.n.version,
        'observations': {key: value for key, value in f.d.local_observations.items() if key in h.q.ALL}}


class WriteCommandRetentionTests(unittest.TestCase):
    def test_a_later_current_off_callback_uses_healthy_transport_once(self):
        r = asyncio.run(scenario(({'1': False},)))
        self.assertEqual(r['transportControlWrites'], 1)
        self.assertEqual(r['nativeSocketAttempts'], 4)
        self.assertFalse(r['originalSent'])
        self.assertIs(r['pending']['1'], r['accepted'][0]['1'])
        self.assertTrue(r['accepted'][0]['1']['sent'])
        self.assertEqual(r['observations'], {})

    def test_same_value_supersession_and_new_datapoint_preserve_only_latest_entry(self):
        for requests in (({'1': True},), ({'1': False}, {'1': True}), ({'6': 49},)):
            with self.subTest(requests=requests):
                r = asyncio.run(scenario(requests))
                self.assertEqual(r['transportControlWrites'], 1)
                self.assertEqual(r['nativeSocketAttempts'], 4)
                self.assertEqual(r['generatedRequests'][-1], requests[-1])
                self.assertFalse(r['originalSent'])
                for key, entry in r['accepted'][-1].items():
                    self.assertIs(r['pending'][key], entry)
                    self.assertTrue(entry['sent'])
                if len(requests) == 2:
                    self.assertFalse(r['accepted'][0]['1']['sent'])
                if '1' not in requests[-1]:
                    self.assertNotIn('1', r['pending'])

    def test_initial_failed_or_removed_commands_are_never_recreated(self):
        for requests, remove in (((), False), (({'1': False},), True)):
            r = asyncio.run(scenario(requests, remove=remove))
            self.assertEqual(r['transportControlWrites'], 0)
            self.assertEqual(r['nativeSocketAttempts'], 2 if remove else 3)
            self.assertEqual(r['pending'], {})
            self.assertFalse(r['originalSent'])

    def test_source_owner_identity_protocol_or_shutdown_loss_grants_no_retention(self):
        def replace_api(f):
            other = h.q.SDK.__new__(h.q.SDK)
            other.__dict__.update(f.n.__dict__)
            f.d._api = other
            f.d._local_source_record['tuyadevice'] = other
        def replace_selected_record(f):
            old = f.d._local_source_record
            new = dict(old)
            self.assertIsNot(new, old)
            self.assertEqual(new, old)
            f.d._hass.data['tuya_local'][f.n.id] = new
            f.d._local_source_record = new
        changes = {
            'owner': lambda f: f.d._local_source_record.update(stmq_observation_reader=None),
            'identity': lambda f: setattr(f.n, 'id', 'different-synthetic-device'),
            'version': lambda f: setattr(f.n, 'version', 3.4),
            'record': lambda f: f.d._hass.data['tuya_local'].update({f.n.id: dict(f.d._local_source_record)}),
            'same-shaped selected record': replace_selected_record,
            'shutdown': lambda f: setattr(f.d._hass, 'is_stopping', True),
            'API': replace_api,
            'lock': lambda f: f.d._local_source_record.update(tuyadevicelock=asyncio.Lock()),
        }
        for name, change in changes.items():
            with self.subTest(name=name):
                r = asyncio.run(scenario(({'1': False},), change=change))
                self.assertEqual(r['transportControlWrites'], 0)
                self.assertEqual(r['nativeSocketAttempts'], 3)
                self.assertEqual(r['pending'], {})
                self.assertFalse(r['accepted'][0]['1']['sent'])

    def test_observed_protocol_a_b_a_cannot_rearm_the_failed_handler(self):
        def move(f, attempt):
            if attempt == 1:
                f.n.version = 3.4
            elif attempt == 2:
                f.n.version = 3.3
        r = asyncio.run(scenario(({'1': False},), after_attempt=move))
        self.assertEqual(r['finalProtocol'], 3.3)
        self.assertEqual(r['transportControlWrites'], 0)
        self.assertEqual(r['nativeSocketAttempts'], 3)
        self.assertEqual(r['pending'], {})
        self.assertFalse(r['accepted'][0]['1']['sent'])

    def test_sent_overlay_is_removed_while_later_unsent_entry_keeps_its_object(self):
        r = asyncio.run(scenario(({'1': False},), sent_setup=True))
        self.assertEqual(r['transportControlWrites'], 1)
        self.assertNotIn('2', r['pending'])
        self.assertIs(r['pending']['1'], r['accepted'][0]['1'])
        self.assertFalse(r['originalSent'])

    def test_actual_first_protocol_selection_precedes_the_cohort_snapshot(self):
        r = asyncio.run(scenario(({'1': False},), initial_selection=True))
        self.assertEqual(r['finalProtocol'], 3.3)
        self.assertEqual(r['transportControlWrites'], 1)
        self.assertIs(r['pending']['1'], r['accepted'][0]['1'])
        self.assertFalse(r['originalSent'])

    def test_failed_following_command_clears_its_own_initial_cohort_without_another_task(self):
        r = asyncio.run(scenario(({'1': False},), healthy_following=False))
        self.assertEqual(r['transportControlWrites'], 0)
        self.assertEqual(r['nativeSocketAttempts'], 6, 'Each of the two existing callbacks keeps its original three attempts')
        self.assertEqual(r['queuedCallbacks'], 1)
        self.assertEqual(r['pending'], {})
        self.assertFalse(r['originalSent'])
        self.assertFalse(r['accepted'][0]['1']['sent'])
        self.assertEqual(r['observations'], {})

    def test_native_terminal_automatic_protocol_reset_declines_prior_source_retention(self):
        r = asyncio.run(scenario(({'1': False},), automatic_terminal_reset=True))
        self.assertEqual(r['finalProtocol'], 3.1, 'Actual current native reset selects its next configured protocol')
        self.assertEqual(r['transportControlWrites'], 0)
        self.assertEqual(r['nativeSocketAttempts'], 3)
        self.assertEqual(r['pending'], {})
        self.assertFalse(r['accepted'][0]['1']['sent'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
