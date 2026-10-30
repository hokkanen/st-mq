import ast
import asyncio
import importlib.util
import json
from pathlib import Path
import shutil
from types import SimpleNamespace as NS
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/apply-meross-lan-msg200.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
fixture = ROOT / 'test/fixtures/meross-lan-5.8.0'
original = (fixture / 'garagedoor.py').read_bytes()
patched = installer.patched_source(original)
tree = ast.parse(patched)
helper = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'stmq_garage_command_state')
garage = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MLGarage')
method = next(n for n in garage.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'async_request_position')
mc = NS(KEY_PAYLOAD='payload', KEY_STATE='state', KEY_OPEN='open', KEY_EXECUTE='execute', KEY_CHANNEL='channel', METHOD_SET='SET')
scope = {'mc': mc}
exec(compile(ast.Module(body=[helper, method], type_ignores=[]), 'reviewed-garage-method', 'exec'), scope)
select = scope['stmq_garage_command_state']
payload = [{'channel': 1, 'open': 0}, {'channel': 2, 'open': 1}, {'channel': 3, 'open': 1}, 1]
assert select(payload, 2) == {'channel': 2, 'open': 1, 'execute': 1}
assert 'execute' not in payload[1]
assert select([{'channel': 2, 'open': 1, 'execute': 0}, 1], 2)['execute'] == 0
assert select({'channel': 0, 'open': 0, 'execute': 1}, 0)['open'] == 0
assert select([{'channel': 1, 'open': 0, 'execute': 1}], 1)['open'] == 0
for bad in [[], [1], [{'channel': 1, 'open': 0}], [{'channel': 2, 'open': 1}] * 2,
            {'channel': 1, 'open': 1}, {'channel': 2, 'open': None}, {'channel': 2, 'open': True}]:
    try:
        select(bad, 2)
    except ValueError:
        pass
    else:
        raise AssertionError('Ambiguous/wrong contact accepted')


async def exercise(action, contact):
    schedules = []
    async def request(*args):
        assert args == ('Appliance.GarageDoor.State', 'SET', {'state': {'channel': 2, 'open': action}})
        return {'payload': {'state': [{'channel': 1, 'open': 1-contact}, {'channel': 2, 'open': contact}, 1]}}
    manager = NS(async_request_ack=request, lastresponse=100, schedule_async_callback=lambda delay, callback: schedules.append(delay))
    entity = NS(manager=manager, ns=NS(name='Appliance.GarageDoor.State', key='state'), channel=2,
                number_open_timeout=NS(native_value=18), number_close_timeout=NS(native_value=22),
                is_closed=None, is_opening=False, is_closing=False, _transition_cancel=lambda: None,
                _async_transition_callback=lambda: None, _async_transition_end_callback=lambda: None,
                flush_state=lambda: None, WARNING=1)
    def error(*args):
        raise AssertionError('Patched native method failed')
    entity.log_exception = error
    await scope['async_request_position'](entity, action)
    assert entity.is_closed is (not contact)
    assert entity.is_opening is bool(action)
    assert entity.is_closing is (not bool(action))
    assert schedules == [0.9, 18 if action else 22]


asyncio.run(exercise(1, 0))
asyncio.run(exercise(0, 1))
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / 'integration'
    (root / 'devices').mkdir(parents=True)
    shutil.copy(fixture / 'manifest.json', root / 'manifest.json')
    source = root / 'devices/garagedoor.py'
    source.write_bytes(original)
    assert installer.install(root, check=True)['status'] == 'ready'
    assert source.read_bytes() == original
    assert installer.install(root, Path(tmp) / 'backups')['restartRequired']
    assert source.read_bytes() == patched
    assert not installer.install(root)['restartRequired']
    source.write_bytes(original + b'\n# unreviewed\n')
    held = source.read_bytes()
    try:
        installer.install(root, Path(tmp) / 'backups')
    except ValueError:
        pass
    else:
        raise AssertionError('Unknown source was patched')
    assert source.read_bytes() == held
    source.write_bytes(original)
    manifest = json.loads((root / 'manifest.json').read_text())
    manifest['version'] = '6.0.0'
    (root / 'manifest.json').write_text(json.dumps(manifest))
    try:
        installer.install(root, Path(tmp) / 'backups')
    except ValueError:
        pass
    else:
        raise AssertionError('Unknown version was patched')
    assert source.read_bytes() == original
print('Meross LAN matching-channel transitions, legacy acknowledgements and guarded installation passed')
