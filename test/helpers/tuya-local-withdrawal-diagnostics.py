"""Execute current native producers; decoded frames are controlled, not encrypted.

The separate source-pinned AES/CRC checks qualify parser reachability. These
tests qualify diagnostic admission and native-call/evidence invariants only.
"""
import ast, asyncio, importlib.util, inspect, logging, pathlib, sys, unittest
from copy import deepcopy
from types import SimpleNamespace
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('query', ROOT/'test/helpers/tuya-local-query-replies.py')
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
MONOTONIC = [100.0]
PREFIX = 'ST-MQ native-field-withdrawal: '
namespace = q.Device._observe_local_dps.__globals__.copy()
namespace['monotonic'] = lambda: MONOTONIC[0]
methods = {k for k, v in q.Device.__dict__.items() if callable(v) or isinstance(v, property)}
methods |= {'register_entity', 'async_stop', 'pause'}
q.Device = q.o.extracted_class(q.o.PATCHED['device.py'], 'TuyaLocalDevice', methods, namespace)
SOURCE_CALLS = {node.lineno for node in ast.walk(ast.parse(q.o.PATCHED['device.py'].decode().replace(
    'except ValueError, KeyError:', 'except (ValueError, KeyError):')))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    and node.func.attr == '_clear_local_observations'}
EXECUTED_CALLS = set()
original_clear = q.Device._clear_local_observations
def clear_spy(self, *args):
    caller = inspect.currentframe().f_back
    if caller.f_code.co_filename == '<pinned-tuya-local-source>':
        EXECUTED_CALLS.add(caller.f_lineno)
    return original_clear(self, *args)
q.Device._clear_local_observations = clear_spy

class Sink(logging.Handler):
    def __init__(self):
        super().__init__(); self.records = []; self.fail = False
    def emit(self, record):
        if record.msg not in {
            'ST-MQ native-field-withdrawal: %s',
            'ST-MQ native-field-withdrawal: %s boundary=%s members=%d',
        }: return
        self.records.append(record.getMessage())
        if self.fail: raise RuntimeError('Synthetic secret-like sink failure')

def entity(profile='electriq_desd8lw_dehumidifier', kind='humidifier'):
    return SimpleNamespace(_config=SimpleNamespace(
        _device=SimpleNamespace(config_type=profile), entity=kind, dps=lambda: []),
        async_schedule_update_ha_state=lambda *args: None,
        schedule_update_ha_state=lambda: None, on_receive=lambda *args: None)

class WithdrawalDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        MONOTONIC[0] = 100.0
        self.sink = Sink()
        self.logger = namespace['_LOGGER']
        self.old = (self.logger.handlers, self.logger.level, self.logger.propagate)
        self.logger.handlers = [self.sink]; self.logger.setLevel(logging.DEBUG); self.logger.propagate = False
        self.addCleanup(self.restore_logger)
    def restore_logger(self):
        self.logger.handlers, level, self.logger.propagate = self.old
        self.logger.setLevel(level)
    def fixture(self, profile='electriq_desd8lw_dehumidifier', kind='humidifier'):
        n, d = q.fixture(); d._hass.is_running = True; d._startup_listener = None
        d._refresh_task = None
        d.register_entity(entity(profile, kind))
        return n, d
    def logged(self, reason, boundary=None, members=None):
        detail = '' if boundary is None else f' boundary={boundary} members={members}'
        self.assertEqual(self.sink.records, [PREFIX + reason + detail])
    def withdrawn(self, d, before, cached=True):
        self.assertEqual(d.local_observations, {'identity': before['identity']})
        if cached: self.assertIs(d.get_property('1'), True)
    def stop_at_sleep(self, d):
        g = q.Device.async_receive.__globals__; previous = g['asyncio']; sleeps = []
        async def sleep(seconds): sleeps.append(seconds); d._running = False
        g['asyncio'] = SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if k != 'sleep'}, sleep=sleep)
        self.addCleanup(lambda: g.__setitem__('asyncio', previous))
        return sleeps

    def test_silent_full_empty_reply_now_names_the_existing_omission(self):
        n, d = self.fixture(); before = d.local_observations; sent = len(n.socket.sent)
        q.o.CLOCK[0] += 31; n.socket.frames.append(q.frame({}, n.seqno))
        result = d._status_for_local_observations()
        self.assertTrue(d._local_reply_is_current(result))
        d._observe_local_dps(result['dps'], d._local_reply_full)
        self.withdrawn(d, before)
        self.assertEqual(len(n.socket.sent) - sent, 1)
        self.logged('full-classification-omission')
    def test_silent_socket_replacement_now_names_existing_context_refusal(self):
        n, d = self.fixture(); before = d.local_observations; sent = len(n.socket.sent)
        def receive(): n.socket = q.Wire(); return q.frame(q.ALL, 99, 8)
        n._receive = receive
        self.assertIsNone(d._receive_for_local_observations())
        self.withdrawn(d, before)
        self.assertEqual(len(n.socket.sent), 0); self.assertGreater(sent, 0)
        self.logged('connection-context-changed', 'after-call', 2)
    def test_silent_failed_frame_integrity_now_names_existing_evidence_rejection(self):
        n, d = self.fixture(); before = d.local_observations; sent = len(n.socket.sent)
        n.socket.frames.append(q.frame(q.ALL, 99, 8, crc_good=False))
        self.assertIsNone(d._receive_for_local_observations())
        self.withdrawn(d, before)
        self.assertEqual(len(n.socket.sent), sent)
        self.logged('failed-frame-integrity-flag')
    def test_actual_stop_retains_profile_eligibility_after_children_clear(self):
        n, d = self.fixture(); before = d.local_observations
        async def run():
            d._refresh_task = asyncio.get_running_loop().create_future(); d._refresh_task.set_result(None)
            await d.async_stop()
        asyncio.run(run())
        self.withdrawn(d, before); self.logged('monitor-stopped')
        self.assertEqual(d._children, []); self.assertFalse(n.socketPersistent)
        self.assertIsNone(d._refresh_task)
    def test_actual_receive_loop_finalization_nested_reset_logs_once(self):
        n, d = self.fixture(); before = d.local_observations
        async def empty():
            if False: yield {}
        d.async_receive = empty
        asyncio.run(d.receive_loop())
        self.withdrawn(d, before, cached=False); self.logged('receive-loop-ended')
        self.assertFalse(n.socketPersistent)
    def test_actual_pause_withdraws_and_keeps_existing_temporary_mode(self):
        n, d = self.fixture(); before = d.local_observations
        d.pause(); self.withdrawn(d, before); self.logged('connection-paused')
        self.assertTrue(d._temporary_poll); self.assertFalse(n.socketPersistent)
    def test_actual_unopened_connection_mode_clear_and_first_sdk_status(self):
        n, d = self.fixture(); before = d.local_observations
        wire = q.Wire(); wire.frames.append(q.frame(q.ALL, n.seqno))
        async def run():
            generator = d.async_receive(); poll = await anext(generator); await generator.aclose(); return poll
        with q.first_open(n, wire): poll = asyncio.run(run())
        self.assertIn('full_poll', poll); self.logged('connection-mode-changed')
        self.withdrawn(d, before); self.assertEqual(len(wire.sent), 1)
    def test_actual_forced_read_revokes_the_held_query_before_updatedps(self):
        n, d = self.fixture(); before = d.local_observations
        q.o.CLOCK[0] += 31; n.socket.frames.append(q.frame({'6': 49}, 999, 8))
        async def run():
            generator = d.async_receive(); await anext(generator)
            self.assertIsNotNone(d._local_query_ticket)
            d._force_dps = ['1']; q.o.CLOCK[0] += 31
            n.socket.frames.append(q.frame(q.ALL, n.seqno, 18))
            poll = await anext(generator); await generator.aclose(); return poll
        poll = asyncio.run(run())
        self.assertIsInstance(poll, dict); self.logged('forced-read-with-pending-query')
        self.withdrawn(d, before); self.assertEqual(len(n.socket.sent), 3)
        self.assertIsNone(d._local_query_ticket)
    def test_actual_low_level_error_withdraws_before_existing_backoff(self):
        n, d = self.fixture(); before = d.local_observations
        n._get_socket = lambda *args: False
        sleeps = self.stop_at_sleep(d)
        async def run(): return [row async for row in d.async_receive()]
        self.assertEqual(asyncio.run(run()), [])
        self.withdrawn(d, before); self.logged('native-transport-error')
        self.assertEqual(sleeps, [5]); self.assertFalse(n.socketPersistent)
    def test_actual_receive_cancellation_preserves_close_and_lock_release(self):
        n, d = self.fixture(); before = d.local_observations
        async def executor(*args): raise asyncio.CancelledError()
        d._hass.async_add_executor_job = executor
        async def run():
            with self.assertRaises(asyncio.CancelledError): await anext(d.async_receive())
        asyncio.run(run())
        self.withdrawn(d, before); self.logged('receive-cancelled')
        self.assertFalse(n.socketPersistent); self.assertFalse(d._api_lock.locked())
    def test_actual_receive_exception_keeps_existing_backoff_and_unknown_state(self):
        n, d = self.fixture(); before = d.local_observations
        async def executor(*args): raise ValueError('Synthetic secret-like receive exception')
        d._hass.async_add_executor_job = executor; sleeps = self.stop_at_sleep(d)
        async def run(): return [row async for row in d.async_receive()]
        self.assertEqual(asyncio.run(run()), [])
        self.withdrawn(d, before); self.logged('receive-exception'); self.assertEqual(sleeps, [5])
    def test_actual_generator_exit_withdraws_without_any_native_query(self):
        n, d = self.fixture(); before = d.local_observations; sent = len(n.socket.sent)
        d._running = False
        async def run(): return [row async for row in d.async_receive()]
        self.assertEqual(asyncio.run(run()), [])
        self.withdrawn(d, before); self.logged('monitor-stopped')
        self.assertEqual(len(n.socket.sent), sent)
    def test_actual_post_executor_consumer_refuses_replaced_reply_context(self):
        n, d = self.fixture(); before = d.local_observations
        n.socket.frames.append(q.frame(q.ALL, n.seqno)); result = d._status_for_local_observations()
        n.socket = q.Wire()
        self.assertFalse(d._local_reply_is_current(result))
        self.withdrawn(d, before); self.logged('reply-context-changed')
    def test_actual_pre_native_context_movement_withdraws_old_evidence(self):
        n, d = self.fixture(); before = d.local_observations
        n.socket = q.Wire(); n.socket.frames.append(q.frame(q.ALL, 99, 8))
        result = d._receive_for_local_observations()
        self.assertIsInstance(result, dict)
        self.withdrawn(d, before); self.logged('connection-context-changed', 'before-call', 2)
        self.assertEqual(n.socket.sent, [])

    def test_actual_before_call_names_each_captured_member_combination_without_new_reads(self):
        for mask in range(1, 8):
            with self.subTest(mask=mask):
                MONOTONIC[0] += 30; self.sink.records.clear()
                n, d = self.fixture(); before = d.local_observations
                old = (n, n.socket, n.version)
                replacement, _ = q.fixture() if mask & 1 else (n, None)
                replacement.socket = q.Wire() if mask & 2 else old[1]
                replacement.version = 3.4 if mask & 4 else old[2]
                d._api = replacement
                replacement.socket.frames.append(q.frame(q.ALL, 99, 8))
                native_receive = replacement.receive; calls = []
                def receive():
                    calls.append(True); return native_receive()
                replacement.receive = receive
                sent = len(replacement.socket.sent)
                result = d._receive_for_local_observations()
                self.assertIsInstance(result, dict)
                self.withdrawn(d, before)
                self.assertEqual(calls, [True])
                self.assertEqual(len(replacement.socket.sent), sent)
                self.logged('connection-context-changed', 'before-call', mask)
                self.assertIsNone(d._local_query_ticket)
                self.assertEqual(d._local_status_refresh is not None, mask == 2)

    def test_actual_after_call_names_each_captured_member_combination_and_rejects_old_reply(self):
        for mask in range(1, 8):
            with self.subTest(mask=mask):
                MONOTONIC[0] += 30; self.sink.records.clear()
                n, d = self.fixture(); before = d.local_observations
                old = (n, n.socket, n.version)
                replacement, _ = q.fixture() if mask & 1 else (n, None)
                calls = []; sent = len(n.socket.sent)
                def receive():
                    calls.append(True)
                    replacement.socket = q.Wire() if mask & 2 else old[1]
                    replacement.version = 3.4 if mask & 4 else old[2]
                    d._api = replacement
                    return q.frame(q.ALL, 99, 8)
                n._receive = receive
                self.assertIsNone(d._receive_for_local_observations())
                self.withdrawn(d, before)
                self.assertEqual(calls, [True])
                self.assertEqual(len(old[1].sent), sent)
                self.logged('connection-context-changed', 'after-call', mask)
                self.assertIsNone(d._local_query_ticket)
                self.assertEqual(d._local_status_refresh is not None, mask == 2)

    def test_unknown_or_exceptional_detail_keeps_generic_category_without_rendering_objects(self):
        class PrivateValue:
            def __eq__(self, other): raise RuntimeError('Synthetic private protocol failure')
            def __repr__(self): raise AssertionError('Private object must never be rendered')
        class PrivateBoundary:
            def __hash__(self): return hash('before-call')
            def __eq__(self, other): return other == 'before-call'
            def __str__(self): raise AssertionError('Private boundary must never be rendered')
        class PrivateString(str):
            def __str__(self): raise AssertionError('String subclass must never be rendered')
        class IntegerLike:
            def __int__(self): return 1
        class AmbiguousProtocol:
            def __init__(self, result): self.result = result
            def __ne__(self, other): return self.result
        private = PrivateValue(); api = object(); socket = object()
        malformed = [None, [], (), ((), (), 'before-call'),
                     ((api, socket, 3.3), (api, socket, 3.4), 'Synthetic private boundary'),
                     ((api, socket, private), (api, socket, 3.3), 'after-call'),
                     ((api, socket, 3.3), (api, socket, 3.3), 'before-call'),
                     ((api, socket, 3.3), (api, socket, 3.4), PrivateBoundary()),
                     ((api, socket, 3.3), (api, socket, 3.4), PrivateString('before-call'))]
        for comparison in (1, 0, IntegerLike()):
            malformed.append(((api, socket, AmbiguousProtocol(comparison)),
                              (api, object(), 3.3), 'after-call'))
        for detail in malformed:
            MONOTONIC[0] += 30; self.sink.records.clear()
            n, d = self.fixture(); before = d.local_observations
            updates = []; d._children[0].schedule_update_ha_state = lambda: updates.append(True)
            generation = d._local_query_generation
            d._clear_local_observations('connection-context-changed', detail)
            self.withdrawn(d, before); self.assertEqual(updates, [True])
            self.assertIsNot(d._local_query_generation, generation)
            self.logged('connection-context-changed')

    def test_context_detail_shares_existing_rate_cap_and_failed_sink_isolation(self):
        n, d = self.fixture(); before = d.local_observations
        detail = ((n, n.socket, 3.3), (n, object(), 3.3), 'after-call')
        updates = []; d._children[0].schedule_update_ha_state = lambda: updates.append(True)
        self.sink.fail = True
        d._clear_local_observations('connection-context-changed', detail)
        self.withdrawn(d, before); self.assertEqual(updates, [True])
        self.logged('connection-context-changed', 'after-call', 2)
        MONOTONIC[0] = 129.999; d._observe_local_dps(q.ALL); d.pause()
        self.logged('connection-context-changed', 'after-call', 2)
        MONOTONIC[0] = 130; d._observe_local_dps(q.ALL); d._reset_cached_state()
        self.assertEqual(self.sink.records, [PREFIX+'connection-context-changed boundary=after-call members=2',
                                            PREFIX+'cache-reset'])
    def test_actual_cache_reset_withdraws_without_source_clock_renewal(self):
        n, d = self.fixture(); before = d.local_observations
        d._reset_cached_state()
        self.withdrawn(d, before, cached=False); self.logged('cache-reset')
        self.assertEqual(d._cached_state, {'updated_at': 0})
    def test_actual_retry_keeps_attempt_count_and_native_reset_behavior(self):
        n, d = self.fixture(); before = d.local_observations; calls = []
        def native():
            calls.append(True)
            if len(calls) == 1: raise AttributeError('Synthetic secret-like native failure')
            return {'dps': q.ALL}
        result = asyncio.run(d._retry_on_failed_connection(native, 'Synthetic failure'))
        self.assertEqual(result, {'dps': q.ALL}); self.assertEqual(len(calls), 2)
        self.withdrawn(d, before); self.logged('native-call-retry')
        self.assertFalse(d._api_lock.locked())
    def test_actual_constructor_starts_without_diagnostic_eligibility_or_observations(self):
        n, _ = q.fixture(); n.set_socketRetryLimit = lambda count: setattr(n, 'socketRetryLimit', count)
        constants = {name: name for name in (
            'CONF_NAME', 'CONF_DEVICE_ID', 'CONF_HOST', 'CONF_LOCAL_KEY', 'CONF_PROTOCOL_VERSION',
            'CONF_DEVICE_CID', 'CONF_POLL_ONLY', 'CONF_MANUFACTURER', 'CONF_MODEL')}
        globals_ = {**namespace, 'HomeAssistant': object, 'API_PROTOCOL_VERSIONS': [3.3], **constants,
            'tinytuya': SimpleNamespace(Device=lambda *args, **kwargs: n, **vars(q.CONSTANTS))}
        factory = q.o.extracted_class(q.o.PATCHED['device.py'], 'TuyaLocalDevice', methods | {'__init__'}, globals_)
        hass = SimpleNamespace(data={'tuya_local': {}})
        device = factory(name='Synthetic appliance', dev_id=n.id, address='127.0.0.1',
            local_key='synthetic', protocol_version=3.3, dev_cid=None, hass=hass, poll_only=False)
        self.assertFalse(device._local_diagnostic_profile)
        self.assertIsNone(device._local_withdrawal_logged_at)
        self.assertEqual(set(device.local_observations), {'identity'})
        self.assertEqual(self.sink.records, [])
    def test_unrelated_profiles_and_other_entity_types_stay_silent(self):
        for profile, kind in [('unrelated_device', 'humidifier'), ('electriq_desd8lw_dehumidifier', 'sensor')]:
            n, d = self.fixture(profile, kind); before = d.local_observations
            d.pause(); self.withdrawn(d, before)
        self.assertEqual(self.sink.records, [])
    def test_startup_empty_clears_partial_reports_and_unchanged_full_reads_stay_silent(self):
        n, d = self.fixture(); original = d.local_observations
        d._observe_local_dps({}); d._observe_local_dps({'heartbeat': True})
        self.assertEqual(d.local_observations, original)
        d._observe_local_dps(q.ALL, True); self.assertEqual(self.sink.records, [])
        d._reset_cached_state(); self.logged('cache-reset')
        d._reset_cached_state(); d.pause(); self.logged('cache-reset')
        n, startup = q.fixture(); startup._reset_cached_state()
        self.logged('cache-reset')
    def test_monotonic_rate_cap_boundary_and_wall_clock_moves_do_not_change_withdrawal(self):
        n, d = self.fixture(); before = d.local_observations
        d.pause(); self.logged('connection-paused')
        for wall, mono in [(31, 100), (-40, 129.999)]:
            q.o.CLOCK[0] += wall; MONOTONIC[0] = mono
            d._observe_local_dps(q.ALL); d._reset_cached_state(); self.withdrawn(d, before, cached=False)
            self.logged('connection-paused')
        MONOTONIC[0] = 130; d._observe_local_dps(q.ALL); d._reset_cached_state()
        self.assertEqual(self.sink.records, [PREFIX+'connection-paused', PREFIX+'cache-reset'])
    def test_failed_sink_cannot_change_clear_callbacks_query_revocation_or_full_omission(self):
        n, d = self.fixture(); updates = []; d._children[0].schedule_update_ha_state = lambda: updates.append(d.local_observations)
        before = d.local_observations; generation = d._local_query_generation; self.sink.fail = True
        d.pause(); self.withdrawn(d, before); self.assertEqual(len(updates), 1)
        self.assertIsNot(d._local_query_generation, generation); self.assertIsNone(d._local_query_ticket)
        MONOTONIC[0] += 30; d._observe_local_dps(q.ALL); d._observe_local_dps({'6': 48}, True)
        self.assertEqual(set(d.local_observations), {'identity', '6'})
        self.assertEqual(d.local_observations['6']['value'], 48)
    def test_new_messages_never_include_native_names_ids_values_or_exceptions(self):
        n, d = self.fixture(); d._name = 'SECRET_NAME'; d.dev_id = 'SECRET_ID'
        d._observe_local_dps({'6': 'SECRET_VALUE'})
        d.pause(); self.logged('connection-paused')
        self.assertFalse(any('SECRET' in value for value in self.sink.records))
        MONOTONIC[0] += 30; d._observe_local_dps(q.ALL)
        d._clear_local_observations('SECRET_ADDRESS_PAYLOAD_EXCEPTION')
        self.logged('connection-paused')
    def test_z_every_current_clear_caller_is_executed_by_the_actual_producers(self):
        self.assertEqual(len(SOURCE_CALLS), 15)
        self.assertEqual(SOURCE_CALLS - EXECUTED_CALLS, set())

if __name__ == '__main__': unittest.main(verbosity=2)
