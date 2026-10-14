"""Execute the pinned patched source against synthetic transport/entity fixtures."""
import ast
import asyncio
from copy import deepcopy
import hashlib
import importlib.util
import json
import logging
from pathlib import Path
import re
import shutil
import tempfile
from time import monotonic
import sys
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'test' / 'fixtures' / 'tuya-local-2026.9.2'
spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts' / 'apply-tuya-local-observation.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
CONTRACT = json.loads((installer.BUNDLE / 'tuya-local-observation.json').read_text())
ORIGINALS = {name: (FIXTURE / name).read_bytes() for name in CONTRACT['files']}
PATCHED = installer.patched_sources((installer.BUNDLE / 'tuya-local-observation.patch').read_text(), ORIGINALS)
CLOCK = [1_800_000_000.0]


def extracted_class(source, class_name, methods, globals_):
    # Upstream targets Python 3.14; only its exception tuple spelling needs
    # parentheses to parse the fixture on the development host's Python 3.11.
    source = re.sub(r'except ([\w.]+(?:, [\w.]+)+):', r'except (\1):', source.decode())
    tree = ast.parse(source)
    node = next(row for row in tree.body if isinstance(row, ast.ClassDef) and row.name == class_name)
    node.bases = []
    node.body = [row for row in node.body if isinstance(row, (ast.FunctionDef, ast.AsyncFunctionDef)) and row.name in methods]
    namespace = dict(globals_)
    # Execute only the current pure export contract and skipped-read marker,
    # alongside selected methods; no HA imports or integration startup.
    constants = [row for row in tree.body if isinstance(row, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id in {
                     '_LOCAL_OBSERVATION_FIELDS', '_LOCAL_OBSERVATION_PROFILE', '_SKIP_LOCAL_STATUS'
                 } for target in row.targets)]
    exec(compile(ast.Module(body=constants + [node], type_ignores=[]), '<pinned-tuya-local-source>', 'exec'), namespace)
    return namespace[class_name]


Device = extracted_class(PATCHED['device.py'], 'TuyaLocalDevice', {
    '_observe_local_dps', '_clear_local_observations', '_diagnose_local_withdrawal', '_reset_cached_state', 'local_observations',
    'get_property', '_get_cached_state', '_get_pending_properties', '_get_pending_updates',
    '_remove_properties_from_pending_updates', 'anticipate_property_value', 'receive_loop',
    '_refresh_cached_state', 'async_refresh', 'unique_id', 'name',
    '_set_values', '_retry_on_failed_connection', '_get_unsent_properties',
    '_send_pending_updates', '_add_properties_to_pending_updates',
    '_register_local_observation_source', '_local_observation_source_exclusive',
    '_status_for_local_observations', '_receive_for_local_observations', '_native_reply_for_local_observations',
    '_local_observation_source_context', '_local_reply_is_current',
}, {'time': lambda: CLOCK[0], 'deepcopy': deepcopy, 'sha256': hashlib.sha256,
    'monotonic': monotonic, '_LOGGER': logging.getLogger('synthetic-tuya'), 'log_json': lambda value: '<synthetic>',
    '_ERROR_HINTS': {}, '_NO_PENDING_UPDATES': object(),
    'tinytuya': SimpleNamespace(DP_QUERY=10, DP_QUERY_NEW=16, STATUS=8, PREFIX_55AA_VALUE=0x55AA), 'DOMAIN': 'tuya_local',
    'get_device_id': lambda value: value['device_id'] + ':' + value['device_cid'],
    'CONF_DEVICE_ID': 'device_id', 'CONF_DEVICE_CID': 'device_cid'})
Entity = extracted_class(PATCHED['entity.py'], 'TuyaLocalEntity', {'extra_state_attributes'},
                         {'json': json, '_LOGGER': logging.getLogger('synthetic-tuya')})


def device_fixture():
    device = Device.__new__(Device)
    device._children = []
    device._name = 'Synthetic appliance'
    device.dev_cid = None
    device.dev_id = 'synthetic-native-device'
    device._api = SimpleNamespace(id=device.dev_id, parent=None, set_socketPersistent=lambda value: None)
    device._FAKE_IT_TIMEOUT = 5
    device._force_dps = []
    device._local_source_record = None
    device._local_source_token = object()
    device._reset_cached_state()
    return device


class ObservationSourceTests(unittest.TestCase):
    def setUp(self):
        CLOCK[0] = 1_800_000_000.0

    def test_contract_pins_exact_source_and_patched_outputs(self):
        for name, values in CONTRACT['files'].items():
            self.assertEqual(installer.digest(ORIGINALS[name]), values['originalSha256'])
            self.assertEqual(installer.digest(PATCHED[name]), values['patchedSha256'])
        self.assertIn(b'\r\n', PATCHED['entity.py'])
        self.assertNotIn(b'\r\n', PATCHED['device.py'])

    def test_partial_reports_and_heartbeats_preserve_original_field_clocks(self):
        device = device_fixture()
        device._observe_local_dps({'1': False, '6': 50, '19': 0})
        first = device.local_observations
        self.assertEqual(set(first), {'identity', '1', '6'})
        self.assertEqual(first['identity'], hashlib.sha256(b'synthetic-native-device').hexdigest())
        CLOCK[0] += 10
        device._observe_local_dps({})
        device._observe_local_dps({'heartbeat': True})
        self.assertEqual(device.local_observations, first)
        device._observe_local_dps({'6': 49})
        self.assertEqual(device.local_observations['1'], first['1'])
        self.assertEqual(device.local_observations['6'], {'value': 49, 'timestamp': 1_800_000_010_000})
        returned = device.local_observations
        returned['1']['value'] = True
        self.assertFalse(device.local_observations['1']['value'])

    def test_pending_native_commands_and_anticipation_never_become_observed_state(self):
        device = device_fixture()
        device._observe_local_dps({'1': False, '2': 55})
        device._cached_state.update({'1': False, '2': 55})
        device._pending_updates = {'1': {'value': True, 'updated_at': CLOCK[0], 'sent': True}}
        self.assertTrue(device.get_property('1'), 'Native HA state can be optimistic')
        device.anticipate_property_value('2', 70)
        self.assertEqual(device.get_property('2'), 70)
        self.assertEqual(device.local_observations['1']['value'], False)
        self.assertEqual(device.local_observations['2']['value'], 55)
        CLOCK[0] += 10
        self.assertFalse(device.get_property('1'))
        self.assertEqual(device.local_observations['1']['timestamp'], 1_800_000_000_000)

    def test_actual_receive_loop_populates_and_clears_adapter_at_disconnect(self):
        device = device_fixture()
        saved = []
        child = SimpleNamespace(on_receive=lambda *_: None, _config=SimpleNamespace(dps=lambda: []),
                                schedule_update_ha_state=lambda: saved.append(device.local_observations))
        device._children = [child]

        async def reports():
            yield {'1': False, '6': 50, 'full_poll': True}
            CLOCK[0] += 10
            yield {}
            CLOCK[0] += 10
            yield {'6': 49}
        device.async_receive = reports
        asyncio.run(device.receive_loop())
        self.assertEqual(saved[0]['1'], saved[1]['1'])
        self.assertEqual(saved[0]['6'], saved[1]['6'])
        self.assertEqual(saved[2]['1'], saved[0]['1'])
        self.assertEqual(saved[2]['6'], {'value': 49, 'timestamp': 1_800_000_020_000})
        self.assertEqual(set(saved[-1]), {'identity'})
        self.assertEqual(set(device.local_observations), {'identity'})

    def test_full_device_read_refreshes_only_present_fields_and_error_cannot_refresh(self):
        device = device_fixture()
        device._api_working_protocol_failures = 0
        device._api.status = lambda: {'dps': {'1': False, '2': 55, '4': 'mid', '6': 50}}
        device._refresh_cached_state()
        initial = device.local_observations
        CLOCK[0] += 10
        device._api.status = lambda: {'Err': '901', 'Error': 'Synthetic failure'}
        device._refresh_cached_state()
        self.assertEqual(device.local_observations, initial)
        device._api.status = lambda: {'dps': {'1': True}}
        device._refresh_cached_state()
        self.assertEqual(set(device.local_observations), {'identity', '1'})
        self.assertEqual(device.local_observations['1'], {'value': True, 'timestamp': 1_800_000_010_000})

    def test_native_running_refresh_cannot_be_claimed_as_a_new_device_read(self):
        device = device_fixture()
        device._running = True
        device._retry_on_failed_connection = lambda *_: self.fail('Native running refresh must not be presented as a poll')
        asyncio.run(device.async_refresh())
        self.assertEqual(set(device.local_observations), {'identity'})

    def test_reset_and_connection_close_paths_clear_all_previous_observations(self):
        device = device_fixture()
        device._observe_local_dps({'1': True, '6': 50})
        device._reset_cached_state()
        self.assertEqual(set(device.local_observations), {'identity'})
        text = PATCHED['device.py'].decode()
        for match in re.finditer(r'(?m)^([ ]*)self\._api\.set_socketPersistent\(False\)$', text):
            preceding = text[:match.start()].rstrip().splitlines()[-1].strip()
            self.assertRegex(preceding, r'^self\._clear_local_observations\("[a-z-]+"\)$')
        self.assertIn('self._clear_local_observations("connection-mode-changed")\n                    persist = not self.should_poll', text)

    def test_only_dedicated_humidifier_exposes_observed_attributes(self):
        device = device_fixture()
        device._observe_local_dps({'1': True, '4': 'mid'})
        entity = Entity.__new__(Entity)
        entity._device = device
        entity._attr_dps = []
        for profile, kind, expected in [('electriq_desd8lw_dehumidifier', 'humidifier', True),
                                        ('electriq_desd8lw_dehumidifier', 'sensor', False),
                                        ('unrelated_device', 'humidifier', False)]:
            entity._config = SimpleNamespace(_device=SimpleNamespace(config_type=profile), entity=kind)
            self.assertEqual('local_observations' in entity.extra_state_attributes, expected)


class CommandTransportTests(unittest.TestCase):
    def setUp(self):
        CLOCK[0] = 1_800_000_000.0

    def command_device(self, outcomes):
        device = device_fixture()
        device._observe_local_dps({'1': True, '6': 50})
        device._pending_updates = {'1': {'value': False, 'updated_at': CLOCK[0], 'sent': False}}
        device._last_connection = CLOCK[0] - 10
        device._api_protocol_version_index = 0
        device._protocol_configured = 3.3
        device._api_protocol_working = True
        device._api_working_protocol_failures = 0
        device._AUTO_FAILURE_RESET_COUNT = 10
        device._SINGLE_PROTO_CONNECTION_ATTEMPTS = 3
        device._api_lock = asyncio.Lock()
        async def executor(func):
            return func()
        device._hass = SimpleNamespace(is_stopping=False, async_add_executor_job=executor)
        attempts = []
        results = iter(outcomes)
        def send(properties, *, nowait):
            attempts.append((deepcopy(properties), nowait))
            result = next(results)
            if isinstance(result, Exception):
                raise result
            return result
        device._api.set_multiple_values = send
        return device, attempts

    def test_returned_socket_error_does_not_mark_a_command_sent_or_renew_clocks(self):
        failure = {'Error': 'Synthetic unavailable socket', 'Err': '905'}
        device, attempts = self.command_device([failure])
        pending, observed = deepcopy(device._pending_updates), device.local_observations
        last_connection = device._last_connection
        CLOCK[0] += 1
        self.assertIs(device._set_values(), failure)
        self.assertEqual(device._pending_updates, pending)
        self.assertEqual(device._last_connection, last_connection)
        self.assertEqual(device.local_observations, observed)
        self.assertEqual(device._get_unsent_properties(), {'1': False})
        self.assertEqual(attempts, [({'1': False}, True)])

    def test_successful_nowait_send_keeps_native_reports_separate(self):
        device, attempts = self.command_device([None])
        observed = device.local_observations
        CLOCK[0] += 1
        self.assertIsNone(device._set_values())
        self.assertTrue(device._pending_updates['1']['sent'])
        self.assertEqual(device._last_connection, CLOCK[0])
        self.assertEqual(device.local_observations, observed)
        self.assertEqual(device._get_unsent_properties(), {})
        self.assertEqual(attempts, [({'1': False}, True)])
        device._observe_local_dps({'1': False})
        self.assertEqual(device.local_observations['1'], {'value': False, 'timestamp': int(CLOCK[0] * 1000)})

    def test_returned_error_reaches_the_existing_retry_before_success(self):
        device, attempts = self.command_device([{'Error': 'Synthetic unavailable socket', 'Err': '905'}, None])
        result = asyncio.run(device._retry_on_failed_connection(lambda: device._set_values(), 'Synthetic send failed'))
        self.assertIsNone(result)
        self.assertEqual(len(attempts), 2)
        self.assertTrue(device._pending_updates['1']['sent'])
        self.assertEqual(device._api_working_protocol_failures, 0)
        self.assertEqual(set(device.local_observations), {'identity'}, 'Connection failure clears old evidence; successful send is not a new native report')

    def test_exhausted_returned_errors_use_existing_reset_without_false_send(self):
        device, attempts = self.command_device([{'Error': 'Synthetic unavailable socket', 'Err': '905'}] * 3)
        result = asyncio.run(device._retry_on_failed_connection(lambda: device._set_values(), 'Synthetic send failed'))
        self.assertIsNone(result)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(device._api_working_protocol_failures, 1)
        self.assertEqual(device._last_connection, 0, 'Existing exhausted-retry reset clears the connection clock')
        self.assertEqual(device._pending_updates, {}, 'Existing exhaustion reset owns pending cache cleanup')
        self.assertEqual(set(device.local_observations), {'identity'})

    def test_existing_empty_status_error_exception_cannot_invent_a_sent_command(self):
        device, attempts = self.command_device([{'Error': 'Synthetic empty status', 'Err': '900'}])
        observed = device.local_observations
        result = asyncio.run(device._retry_on_failed_connection(lambda: device._set_values(), 'Synthetic send failed'))
        self.assertIsNone(result, 'Existing native 900 status-query exception is retained')
        self.assertEqual(len(attempts), 1)
        self.assertFalse(device._pending_updates['1']['sent'])
        self.assertEqual(device.local_observations, observed, 'Native optimistic status time is not a received datapoint')

    def test_exception_retry_and_core_stopping_keep_existing_behavior(self):
        device, attempts = self.command_device([OSError('Synthetic connection failure'), None])
        asyncio.run(device._retry_on_failed_connection(lambda: device._set_values(), 'Synthetic send failed'))
        self.assertEqual(len(attempts), 2)
        self.assertTrue(device._pending_updates['1']['sent'])
        device, attempts = self.command_device([])
        device._hass.is_stopping = True
        asyncio.run(device._retry_on_failed_connection(lambda: device._set_values(), 'Synthetic send failed'))
        self.assertEqual(attempts, [])
        self.assertFalse(device._pending_updates['1']['sent'])


class PendingCommandLineageTests(unittest.TestCase):
    setUp = CommandTransportTests.setUp
    command_device = CommandTransportTests.command_device
    # Exercise the actual pending-entry producer and send/retry/lock path. The
    # synthetic transport callback represents another HA service updating the
    # pending map while the older executor-owned native attempt is in flight.
    def replacing_send(self, device, outcomes, replacement):
        attempts = []
        results = iter(outcomes)
        def send(properties, *, nowait):
            attempts.append((deepcopy(properties), nowait))
            if len(attempts) == 1:
                CLOCK[0] += 1
                replacement()
            result = next(results)
            if isinstance(result, Exception):
                raise result
            return result
        device._api.set_multiple_values = send
        return attempts

    def test_newer_opposite_choice_is_not_marked_sent_by_older_success(self):
        device, _ = self.command_device([])
        observed = device.local_observations
        attempts = self.replacing_send(device, [None, None],
                                      lambda: device._add_properties_to_pending_updates({'1': True}))
        asyncio.run(device._send_pending_updates())
        newer = deepcopy(device._pending_updates['1'])
        self.assertEqual(newer, {'value': True, 'updated_at': CLOCK[0], 'sent': False})
        self.assertEqual(device.local_observations, observed)
        asyncio.run(device._send_pending_updates())
        self.assertEqual(attempts, [({'1': False}, True), ({'1': True}, True)])
        self.assertTrue(device._pending_updates['1']['sent'])

    def test_newer_same_value_is_a_distinct_unsent_choice(self):
        device, _ = self.command_device([])
        original = device._pending_updates['1']
        attempts = self.replacing_send(device, [None],
                                      lambda: device._add_properties_to_pending_updates({'1': False}))
        asyncio.run(device._send_pending_updates())
        self.assertIsNot(device._pending_updates['1'], original)
        self.assertFalse(device._pending_updates['1']['sent'])
        self.assertEqual(attempts, [({'1': False}, True)])

    def test_entry_removed_during_success_is_not_recreated_or_retried(self):
        device, _ = self.command_device([])
        observed = device.local_observations
        attempts = self.replacing_send(device, [None], lambda: device._pending_updates.clear())
        asyncio.run(device._send_pending_updates())
        self.assertEqual(attempts, [({'1': False}, True)])
        self.assertEqual(device._pending_updates, {})
        self.assertEqual(device.local_observations, observed)

    def test_multiple_datapoints_only_mark_the_exact_attempted_entries(self):
        device, _ = self.command_device([])
        device._add_properties_to_pending_updates({'2': 55, '4': 'low', '19': 7})
        original = dict(device._pending_updates)
        observed = device.local_observations
        def replace():
            device._add_properties_to_pending_updates({'1': True, '2': 55, '20': 9})
            device._pending_updates.pop('4')
        attempts = self.replacing_send(device, [None, None], replace)
        asyncio.run(device._send_pending_updates())
        self.assertFalse(device._pending_updates['1']['sent'])
        self.assertFalse(device._pending_updates['2']['sent'])
        self.assertFalse(device._pending_updates['20']['sent'])
        self.assertTrue(device._pending_updates['19']['sent'])
        self.assertIs(device._pending_updates['19'], original['19'])
        self.assertNotIn('4', device._pending_updates)
        self.assertEqual(device.local_observations, observed)
        asyncio.run(device._send_pending_updates())
        self.assertEqual(attempts, [({'1': False, '2': 55, '4': 'low', '19': 7}, True),
                                    ({'1': True, '2': 55, '20': 9}, True)])

    def test_returned_error_retries_the_newer_opposite_choice(self):
        device, _ = self.command_device([])
        attempts = self.replacing_send(device, [{'Error': 'Synthetic socket failure', 'Err': '905'}, None],
                                      lambda: device._add_properties_to_pending_updates({'1': True}))
        asyncio.run(device._send_pending_updates())
        self.assertEqual(attempts, [({'1': False}, True), ({'1': True}, True)])
        self.assertTrue(device._pending_updates['1']['sent'])
        self.assertEqual(device._api_working_protocol_failures, 0)
        self.assertEqual(set(device.local_observations), {'identity'})

    def test_exception_retries_the_newer_same_value_entry(self):
        device, _ = self.command_device([])
        original = device._pending_updates['1']
        attempts = self.replacing_send(device, [OSError('Synthetic failure'), None],
                                      lambda: device._add_properties_to_pending_updates({'1': False}))
        asyncio.run(device._send_pending_updates())
        self.assertIsNot(device._pending_updates['1'], original)
        self.assertFalse(original['sent'])
        self.assertTrue(device._pending_updates['1']['sent'])
        self.assertEqual(attempts, [({'1': False}, True), ({'1': False}, True)])

    def test_removed_failed_batch_sends_no_empty_retry(self):
        device, _ = self.command_device([])
        device._api_working_protocol_failures = 4
        attempts = self.replacing_send(device, [{'Error': 'Synthetic socket failure', 'Err': '905'}],
                                      lambda: device._pending_updates.clear())
        asyncio.run(device._send_pending_updates())
        self.assertEqual(attempts, [({'1': False}, True)])
        self.assertEqual(device._pending_updates, {})
        self.assertEqual(device._api_working_protocol_failures, 4,
                         'A skipped retry is not successful native protocol evidence')

    def test_choice_changed_while_waiting_for_native_lock_is_the_first_attempt(self):
        device, attempts = self.command_device([None])
        async def run():
            await device._api_lock.acquire()
            send = asyncio.create_task(device._send_pending_updates())
            await asyncio.sleep(0)
            CLOCK[0] += 1
            device._add_properties_to_pending_updates({'1': True})
            device._api_lock.release()
            await send
        asyncio.run(run())
        self.assertEqual(attempts, [({'1': True}, True)])
        self.assertTrue(device._pending_updates['1']['sent'])

    def test_no_pending_or_only_sent_entries_never_send_an_empty_batch(self):
        for pending in [{}, {'1': {'value': False, 'updated_at': CLOCK[0], 'sent': True}}]:
            with self.subTest(pending=pending):
                device, attempts = self.command_device([])
                device._pending_updates = deepcopy(pending)
                device._api_protocol_working = False
                device._api_working_protocol_failures = 4
                observed, last_connection = device.local_observations, device._last_connection
                asyncio.run(device._send_pending_updates())
                self.assertEqual(attempts, [])
                self.assertEqual(device._last_connection, last_connection)
                self.assertEqual(device.local_observations, observed)
                self.assertFalse(device._api_protocol_working)
                self.assertEqual(device._api_working_protocol_failures, 4)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tuya-observation-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.integration = self.root / 'integration'
        self.integration.mkdir()
        for name, data in ORIGINALS.items():
            (self.integration / name).write_bytes(data)
        (self.integration / 'manifest.json').write_text(json.dumps({'domain': 'tuya_local', 'version': '2026.9.2'}))
        self.backup = self.root / 'backup'

    def test_dry_run_apply_backup_and_idempotence(self):
        self.assertEqual(installer.install(self.integration, check=True)['status'], 'ready')
        self.assertEqual((self.integration / 'device.py').read_bytes(), ORIGINALS['device.py'])
        self.assertEqual(installer.install(self.integration, self.backup)['status'], 'installed')
        for name in ORIGINALS:
            self.assertEqual((self.integration / name).read_bytes(), PATCHED[name])
            self.assertEqual((self.backup / f'{name}.{installer.digest(ORIGINALS[name])}.bak').read_bytes(), ORIGINALS[name])
        self.assertEqual(installer.install(self.integration, self.backup)['status'], 'already-installed')

    def test_unknown_source_or_version_rejected_before_mutation(self):
        (self.integration / 'entity.py').write_bytes(ORIGINALS['entity.py'] + b'# unknown change\n')
        with self.assertRaisesRegex(ValueError, 'Unrecognized'):
            installer.install(self.integration, self.backup)
        self.assertEqual((self.integration / 'device.py').read_bytes(), ORIGINALS['device.py'])
        self.assertFalse(self.backup.exists())
        (self.integration / 'manifest.json').write_text(json.dumps({'domain': 'tuya_local', 'version': 'future'}))
        with self.assertRaisesRegex(ValueError, 'exact supported'):
            installer.install(self.integration, self.backup)

    def test_partial_install_and_unsafe_backup_rejected(self):
        (self.integration / 'device.py').write_bytes(PATCHED['device.py'])
        with self.assertRaisesRegex(ValueError, 'Partially installed'):
            installer.install(self.integration, self.backup)
        (self.integration / 'device.py').write_bytes(ORIGINALS['device.py'])
        with self.assertRaisesRegex(ValueError, 'outside'):
            installer.install(self.integration, self.integration / 'backup')

    def test_failed_second_file_publication_restores_the_first(self):
        real = installer.atomic_replace
        failed = False
        def fail_once(path, data, attributes):
            nonlocal failed
            if path.name == 'entity.py' and not failed:
                failed = True
                raise OSError('Synthetic publication failure')
            real(path, data, attributes)
        installer.atomic_replace = fail_once
        try:
            with self.assertRaisesRegex(OSError, 'Synthetic publication failure'):
                installer.install(self.integration, self.backup)
        finally:
            installer.atomic_replace = real
        for name, data in ORIGINALS.items():
            self.assertEqual((self.integration / name).read_bytes(), data)


if __name__ == '__main__':
    unittest.main(verbosity=2)
