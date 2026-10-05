#!/usr/bin/env python3
"""Run against an unmodified, pinned Supervisor checkout and its dependencies.

Run scripts/test-homeassistant-supervisor.sh. This starts no Supervisor, Core or Docker API.
The doubles are surrounding host services, request bodies, secret reload, job
scheduling and durable write callbacks. Configuration validation, store scanning,
metadata publication and option merging use the upstream implementations.
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
from supervisor.api.supervisor import APISupervisor
from supervisor.apps.app import App
from supervisor.apps.data import AppsData
from supervisor.apps.options import UiOptions
from supervisor.apps.validate import SCHEMA_APP_CONFIG, SCHEMA_APP_TRANSLATIONS
from supervisor.const import REQUEST_FROM, UpdateChannel
from supervisor.exceptions import APIError
from supervisor.homeassistant.secrets import HomeAssistantSecrets
from supervisor.store import StoreManager
from supervisor.store.app import AppStore
from supervisor.store.data import StoreData
from supervisor.store.validate import SCHEMA_REPOSITORY_CONFIG
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

    async def test_repository_discovers_only_the_root_app_manifest(self):
        # Recreate the public config.* filenames only, without mounting source
        # or household data. Exercise upstream recursive discovery unchanged.
        repository = self.directory / 'repository'
        for relative in json.loads(Path('/repository-paths.json').read_text()):
            path = repository / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        store = StoreData(SimpleNamespace(run_in_executor=asyncio.to_thread))
        discovered = await store._find_app_configs(repository, 'fixture')
        self.assertEqual([path.relative_to(repository).as_posix() for path in discovered], ['config.json'])

    async def test_same_repository_list_refreshes_metadata_without_fetch_or_option_replacement(self):
        slug = '1234abcd_st-mq'
        repository_source = 'https://example.invalid/fixture-st-mq'
        paths = {name: self.directory / name for name in ('core', 'local', 'git')}
        for path in paths.values():
            path.mkdir()
        repository = paths['git'] / '1234abcd'
        repository.mkdir()
        (repository / 'repository.json').write_text(json.dumps({'name': 'Synthetic repository'}))
        manifest_path = repository / 'config.json'
        old_manifest = deepcopy(MANIFEST)
        old_manifest['schema']['retired_fixture'] = 'str?'
        old_manifest['schema']['changed_fixture'] = 'str'
        old_manifest['options']['retired_fixture'] = 'old default'
        old_manifest['options']['changed_fixture'] = 'old default'
        manifest_path.write_text(json.dumps(old_manifest))

        self.coresys.run_in_executor = asyncio.to_thread
        self.coresys.config = SimpleNamespace(
            path_apps_core=paths['core'], path_apps_local=paths['local'],
            path_apps_git=paths['git'], save_data=AsyncMock())
        self.coresys.updater = SimpleNamespace(channel=UpdateChannel.STABLE, save_data=AsyncMock())
        self.coresys.resolution = SimpleNamespace(evaluate=SimpleNamespace(evaluate_system=AsyncMock()))
        self.coresys.arch = SimpleNamespace(match=lambda _: 'amd64')
        store = StoreManager.__new__(StoreManager)
        store.coresys = self.coresys
        repositories = [SimpleNamespace(slug=name, source=source, is_builtin=builtin,
                                       update=AsyncMock(), load=AsyncMock())
                        for name, source, builtin in [('core', 'core', True), ('local', 'local', True),
                                                      ('1234abcd', repository_source, False)]]
        store._repositories = {repository.slug: repository for repository in repositories}
        store.add_repository = AsyncMock(side_effect=AssertionError('Unexpected repository addition'))
        store.remove_repository = AsyncMock(side_effect=AssertionError('Unexpected repository removal'))
        # Omit only Supervisor's job scheduler; exercise the actual repository
        # reconciliation, disk scanner and cache publication called by the API.
        store.update_repositories = StoreManager.update_repositories.__wrapped__.__get__(store)
        store.data = StoreData(self.coresys)
        self.coresys.store = store
        self.app.slug = slug
        self.coresys.apps.installed = [self.app]
        self.coresys.apps.store = {}
        await store.data.update()
        cached_app = AppStore(self.coresys, slug)
        self.coresys.apps.store[slug] = cached_app

        saved_options = {'mqtt': {'pw': 'fixture-installation-password'},
                         'retired_fixture': 'saved incompatible value'}
        data = AppsData.__new__(AppsData)
        data.coresys = self.coresys
        data._data = {'system': {slug: deepcopy(cached_app.data)},
                      'user': {slug: {'options': deepcopy(saved_options),
                                      'version': cached_app.version, 'image': cached_app.image}}}
        data.save_data = AsyncMock()
        self.coresys.apps.data = data
        old_installed = deepcopy(data.system[slug])
        old_user = deepcopy(data.user)
        old_effective = deepcopy(self.app.options)

        new_manifest = deepcopy(old_manifest)
        del new_manifest['schema']['retired_fixture']
        del new_manifest['options']['retired_fixture']
        new_manifest['options']['changed_fixture'] = 'new default'
        new_manifest['schema']['added_fixture'] = 'bool'
        new_manifest['options']['added_fixture'] = False
        manifest_path.write_text(json.dumps(new_manifest))
        self.assertEqual(cached_app.options['changed_fixture'], 'old default')
        api = APISupervisor()
        api.coresys = self.coresys
        request = make_mocked_request('POST', '/supervisor/options')
        request.json = AsyncMock(return_value={'addons_repositories': [repo.source for repo in repositories]})
        response = await api.options_v1(request)
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(json.loads(response.text)['result'], 'ok')
        self.assertEqual(cached_app.data['schema'], new_manifest['schema'])
        self.assertEqual(cached_app.options, new_manifest['options'])
        self.assertEqual(data.system[slug], old_installed)
        self.assertEqual(data.user, old_user)
        self.assertEqual(set(store.repositories), {repo.slug for repo in repositories})
        store.add_repository.assert_not_awaited()
        store.remove_repository.assert_not_awaited()
        for repo in repositories:
            repo.update.assert_not_awaited()
            repo.load.assert_not_awaited()
        data.save_data.assert_not_awaited()

        # App.rebuild invokes this exact publication method after the image
        # build. It must update raw defaults/schema, preserving saved overrides.
        await data.update(cached_app)
        self.assertEqual(data.system[slug]['schema'], new_manifest['schema'])
        self.assertEqual(data.system[slug]['options'], new_manifest['options'])
        self.assertEqual(data.user, old_user)
        self.assertNotEqual(self.app.options, old_effective)
        self.assertEqual(self.app.options['changed_fixture'], 'new default')
        self.assertIs(self.app.options['added_fixture'], False)
        self.assertEqual(self.app.options['retired_fixture'], 'saved incompatible value')
        self.assertEqual(self.app.options['mqtt']['pw'], 'fixture-installation-password')
        data.save_data.assert_awaited_once()

    async def test_runtime_validation_drops_unknown_fields_but_saved_options_retain_them(self):
        self.app.options = {'retired_fixture': 'saved incompatible value'}
        saved = deepcopy(self.app.persist['options'])
        with self.assertLogs('supervisor.apps.options', level='WARNING') as logs:
            response = await self.api.options_config(self.request())
        self.assertEqual(response.status, 200)
        self.assertNotIn('retired_fixture', json.loads(response.text)['data'])
        self.assertTrue(any("Option 'retired_fixture' does not exist in the schema" in message for message in logs.output))
        self.assertEqual(self.app.persist['options'], saved)
        self.assertEqual(self.app.options['retired_fixture'], 'saved incompatible value')
        self.assertEqual(self.save_count, 0)

    def test_recursive_ui_schema_preserves_every_field(self):
        self.assertEqual(ui_paths(UiOptions(self.coresys)(self.config['schema'])), schema_paths(MANIFEST['schema']))

    def test_host_network_webui_resolves_without_ignored_port_mappings(self):
        self.assertTrue(self.config['host_network'])
        self.assertEqual(self.config['ingress_port'], 0)
        self.assertTrue(self.config['panel_admin'])
        self.assertEqual(self.app.webui, 'http://[HOST]:1234')

    async def test_production_serializer_sparse_equipment_import_passes_actual_api(self):
        options = json.loads(Path('/generated-options.json').read_text())
        device = options['equipment']['devices'][0]
        self.assertEqual(device['temperature_control'], {})
        self.assertEqual(device['mqtt'], {})
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(json.loads(response.text)['result'], 'ok')
        self.assertEqual(self.app.options, options)
        self.assertEqual(json.loads(self.saved.read_text())['synthetic_st-mq']['options'], options)
        response = await self.api.options_config(self.request())
        expected = deepcopy(options)
        expected['mqtt']['pw'] = 'synthetic-secret'
        self.assertEqual(json.loads(response.text)['data'], expected)

    def test_repository_metadata_and_english_translations(self):
        repository = read_yaml_file(Path('/repository.yaml'))
        self.assertEqual(SCHEMA_REPOSITORY_CONFIG(deepcopy(repository)), repository)
        translations = read_yaml_file(Path('/translations/en.yaml'))
        self.assertEqual(SCHEMA_APP_TRANSLATIONS(deepcopy(translations)), translations)
        descriptions = translations['configuration']
        self.assertEqual(set(descriptions), set(MANIFEST['schema']))

        def check_fields(nodes, schema, path=()):
            for name, node in nodes.items():
                field_path = '.'.join((*path, name))
                self.assertIn(name, schema, field_path)
                self.assertTrue(node['name'].strip(), field_path)
                self.assertTrue(node.get('description', '').strip(), field_path)
                if 'fields' in node:
                    nested = schema[name]
                    if isinstance(nested, list):
                        nested = nested[0]
                    self.assertIsInstance(nested, dict, field_path)
                    check_fields(node['fields'], nested, (*path, name))

        check_fields(descriptions, MANIFEST['schema'])
        self.assertLessEqual(set(translations.get('network', {})), set(MANIFEST.get('ports', {})))

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

    async def test_api_save_preserves_references_and_resolves_runtime_options(self):
        options = deepcopy(MANIFEST['options'])
        options['mqtt']['pw'] = '!secret fixture_password'
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(json.loads(response.text)['result'], 'ok')
        expected = deepcopy(options)
        expected['mqtt']['pw'] = 'synthetic-secret'
        self.assertEqual(self.app.options, options)
        self.assertEqual(json.loads(self.saved.read_text())['synthetic_st-mq']['options'], options)
        response = await self.api.options_config(self.request())
        self.assertEqual(json.loads(response.text)['data'], expected)

    async def test_saved_references_use_changed_secret_on_next_runtime_read(self):
        options = deepcopy(MANIFEST['options'])
        options['mqtt']['pw'] = '!secret fixture_password'
        response = await self.api.options(self.request({'options': options}))
        self.assertEqual(json.loads(response.text)['result'], 'ok')
        self.secrets_path.write_text('fixture_password: fixture-rotated-secret\n')
        response = await self.api.options_config(self.request())
        self.assertEqual(json.loads(response.text)['data']['mqtt']['pw'], 'fixture-rotated-secret')
        self.assertEqual(self.app.options['mqtt']['pw'], '!secret fixture_password')
        self.assertEqual(self.save_count, 1)

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
        self.assertEqual(self.app.options['mqtt']['pw'], '!secret fixture_password')
        response = await self.api.options_config(self.request())
        self.assertEqual(json.loads(response.text)['data']['mqtt']['pw'], 'synthetic-secret')
        self.assertEqual(self.save_count, 1)


if __name__ == '__main__':
    print('Supervisor 2026.09.3 commit 64ea3be4322537fd5dcfbf620c4dc25490c1f56d', flush=True)
    print('Manifest SHA256:', hashlib.sha256(MANIFEST_BYTES).hexdigest(), flush=True)
    print('Current schema paths:', len(schema_paths(MANIFEST['schema'])), flush=True)
    unittest.main(verbosity=2)
