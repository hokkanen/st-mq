#!/usr/bin/env python3
"""Run against an unmodified, pinned Supervisor checkout and its dependencies.

See docs/audit/A11-supervisor.md. This starts no Supervisor, Core or Docker API.
The only doubles are the surrounding app registry, request body, secret reload,
and durable write callback; all option/schema/API normalization is upstream.
"""
import asyncio
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from aiohttp.test_utils import make_mocked_request
import voluptuous as vol

from supervisor.api.apps import APIApps
from supervisor.apps.app import App
from supervisor.apps.options import AppOptions, UiOptions
from supervisor.apps.validate import SCHEMA_APP_CONFIG
from supervisor.const import REQUEST_FROM
from supervisor.exceptions import APIError
from supervisor.homeassistant.secrets import HomeAssistantSecrets
from supervisor.utils.yaml import read_yaml_file

MANIFEST_PATH = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path('/manifest.json')
MANIFEST_BYTES = MANIFEST_PATH.read_bytes()
MANIFEST = json.loads(MANIFEST_BYTES)


def schema_paths(schema, prefix=()):
    result = set()
    for key, value in schema.items():
        if isinstance(value, list):
            value = value[0]
        result.add(prefix + (key,))
        if isinstance(value, dict):
            result |= schema_paths(value, prefix + (key,))
    return result


def ui_paths(nodes, prefix=()):
    result = set()
    for node in nodes:
        path = prefix + (node['name'],)
        result.add(path)
        if node['type'] == 'schema':
            result |= ui_paths(node['schema'], path)
    return result


class SupervisorOptions(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix='stmq-supervisor-options-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config = SCHEMA_APP_CONFIG(deepcopy(MANIFEST))
        self.coresys = SimpleNamespace()
        self.secrets = HomeAssistantSecrets(self.coresys)
        self.secrets_path = self.directory / 'secrets.yaml'
        self.secrets_path.write_text('fixture_password: synthetic-secret\nfixture_weight: 0.5\n')
        async def reload():
            # Upstream YAML parser and secret accessor; scheduling/throttling is
            # outside this fixture and is deliberately not replaced as evidence.
            self.secrets.secrets = read_yaml_file(self.secrets_path)
        self.secrets.reload = reload
        self.coresys.homeassistant = SimpleNamespace(secrets=self.secrets)
        self.saved = self.directory / 'persist.json'
        self.user = {'synthetic_st-mq': {'options': {}}}
        self.save_count = 0
        self.drop_reply = False
        async def save_data():
            self.saved.write_text(json.dumps(self.user))
            self.save_count += 1
            if self.drop_reply:
                raise APIError('synthetic transport failure after persistence')
        self.coresys.apps = SimpleNamespace(data=SimpleNamespace(
            system={'synthetic_st-mq': self.config}, user=self.user, save_data=save_data))
        # Avoid app constructor's unrelated container/host objects. These real
        # App properties access only the explicit registry above.
        self.app = App.__new__(App)
        self.app.coresys = self.coresys
        self.app.slug = 'synthetic_st-mq'
        self.api = APIApps()
        self.api.coresys = self.coresys
        self.options = self.app.schema

    def request(self, body=None):
        request = make_mocked_request('GET' if body is None else 'POST', '/addons/self/options/config' if body is None else '/addons/self/options',
                                      match_info={'app': 'self'})
        request[REQUEST_FROM] = self.app
        request.json = AsyncMock(return_value=deepcopy(body))
        return request

    def test_exact_manifest_and_defaults(self):
        self.assertEqual(self.options.validate(self.config['options']), MANIFEST['options'])
        self.assertEqual(self.config['schema'], MANIFEST['schema'])
        self.assertFalse(self.config['hassio_api'])
        self.assertEqual(self.config['hassio_role'], 'default')

    def test_recursive_ui_schema_preserves_every_field(self):
        self.assertEqual(ui_paths(UiOptions(self.coresys)(self.config['schema'])), schema_paths(MANIFEST['schema']))

    def test_deep_equipment_and_current_charging_garage_options(self):
        options = deepcopy(MANIFEST['options'])
        options['equipment']['devices'][0]['mqtt'] = {'state_path': 'value', 'timestamp_path': 'measured_at'}
        options['equipment']['devices'][0]['readings'] = [{'key': 'temperature', 'signal': 'indoor_temperature', 'unit': 'degC', 'scale': 1.25, 'offset': -0.5}]
        self.assertEqual(self.options.validate(options), options)

    def test_nested_types_reject_invalid_and_optional_null(self):
        for bad in ('not-a-number', None):
            with self.subTest(value=bad):
                options = deepcopy(MANIFEST['options'])
                options['equipment']['devices'][0]['readings'] = [{'key': 'temperature', 'scale': bad}]
                with self.assertRaises(vol.Invalid):
                    self.options.validate(options)

    async def test_current_references_resolve_without_mutating_saved_options(self):
        await self.secrets.reload()
        options = deepcopy(MANIFEST['options'])
        options['mqtt']['pw'] = '!secret fixture_password'
        options['controller']['indoor_sensor_weights']['indoor_temperature'] = '!secret fixture_weight'
        self.app.options = options
        response = await self.api.options_config(self.request())
        self.assertEqual(response.status, 200)
        body = json.loads(response.text)['data']
        self.assertEqual(body['mqtt']['pw'], 'synthetic-secret')
        self.assertEqual(body['controller']['indoor_sensor_weights']['indoor_temperature'], 0.5)
        self.assertEqual(self.app.options['mqtt']['pw'], '!secret fixture_password')
        self.assertEqual(self.save_count, 0)

    async def test_api_save_persists_resolved_secrets_and_nested_shape(self):
        options = deepcopy(MANIFEST['options'])
        options['mqtt']['pw'] = '!secret fixture_password'
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(json.loads(response.text)['result'], 'ok')
        expected = deepcopy(options)
        expected['mqtt']['pw'] = 'synthetic-secret'
        self.assertEqual(self.app.options, expected)
        self.assertEqual(json.loads(self.saved.read_text())['synthetic_st-mq']['options'], expected)
        response = await self.api.options_config(self.request())
        self.assertEqual(json.loads(response.text)['data'], expected)

    async def test_missing_secret_rejects_before_any_save(self):
        before = self.app.options
        options = deepcopy(before)
        options['mqtt']['pw'] = '!secret missing_fixture_secret'
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.app.options, before)
        self.assertEqual(self.save_count, 0)

    async def test_nested_null_rejects_before_any_save(self):
        before = self.app.options
        options = deepcopy(before)
        options['equipment']['devices'][0]['mqtt']['state_path'] = None
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.app.options, before)
        self.assertEqual(self.save_count, 0)

    async def test_readback_recovers_normalized_options_after_lost_save_response(self):
        options = deepcopy(MANIFEST['options'])
        options['mqtt']['pw'] = '!secret fixture_password'
        self.drop_reply = True
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.save_count, 1)
        # Recreate saved registry as after restart; no normalization double.
        self.user.clear()
        self.user.update(json.loads(self.saved.read_text()))
        response = await self.api.options_config(self.request())
        self.assertEqual(json.loads(response.text)['data']['mqtt']['pw'], 'synthetic-secret')
        self.assertEqual(self.save_count, 1)


if __name__ == '__main__':
    print('Supervisor 2026.09.1 commit 40e3ee7640a3c44abe67f1a1397f39c3cd949806', flush=True)
    print('Manifest SHA256:', hashlib.sha256(MANIFEST_BYTES).hexdigest(), flush=True)
    print('Current schema paths:', len(schema_paths(MANIFEST['schema'])), flush=True)
    unittest.main(verbosity=2)
