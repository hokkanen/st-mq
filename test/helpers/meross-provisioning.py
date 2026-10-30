import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

prepare = load('prepare-meross-mosquitto')
binding = load('bind-meross-msg200')
device = {'uuid': '0123456789abcdef0123001122334455', 'key': 'abcdef0123456789abcdef0123456789', 'user_id': 17}
login, state = prepare.authentication_state(device, {'fixture-app'})
assert login['username'] == '00:11:22:33:44:55'
assert login['password'].startswith('17_') and len(login['password']) == 35
app = next(c for c in state['clients'] if c['username'] == 'fixture-app')
assert 'password' not in app
held = copy.deepcopy(state)
try:
    prepare.authentication_state(device, {'fixture-app'}, state)
except ValueError:
    pass
else:
    raise AssertionError('Existing native identity was overwritten')
assert state == held
for bad in [{**device, 'key': 'private'}, {**device, 'user_id': True}, {**device, 'retired': 'value'}]:
    try:
        prepare.device_login(bad)
    except ValueError:
        pass
    else:
        raise AssertionError('Malformed device identity accepted')
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    source = root / 'device.json'
    source.write_text(json.dumps(device)); source.chmod(0o600)
    passwords = root / 'passwords'
    passwords.write_text('fixture-app:synthetic-hash\n')
    out = root / 'prepared'
    assert prepare.prepare(source, passwords, out)['files'] == 2
    assert out.stat().st_mode & 0o777 == 0o700
    assert all(f.stat().st_mode & 0o777 == 0o600 for f in out.iterdir())
    before = (out / 'device-login.json').read_bytes()
    try:
        prepare.prepare(source, passwords, out)
    except ValueError:
        pass
    else:
        raise AssertionError('Existing output was overwritten')
    assert (out / 'device-login.json').read_bytes() == before
    calls = []
    def request(host, key, namespace, method, payload):
        calls.append((namespace, method, payload))
        if namespace == 'Appliance.System.All':
            return {'payload': {'all': {'system': {'hardware': {'uuid': device['uuid']},
                    'firmware': {'userId': 17, 'server': '192.0.2.30', 'port': 8883}}}}}
        if namespace == 'Appliance.GarageDoor.State':
            return {'payload': {'state': [{'channel': 1, 'open': 0}]}}
        assert namespace == 'Appliance.Config.Key' and method == 'SET'
        assert payload['key']['key'] == device['key'] and payload['key']['userId'] == '17'
        assert payload['key']['gateway'] == {'host': '192.0.2.30', 'port': 8883,
                'secondHost': '192.0.2.30', 'secondPort': 8883, 'redirect': 1}
        return {'header': {'method': 'SETACK'}}
    original_request = binding.request
    binding.request = request
    assert binding.configure(device, '192.0.2.4', '192.0.2.30')['brokerMatches']
    assert all(method == 'GET' for _, method, _ in calls)
    calls.clear()
    assert binding.configure(device, '192.0.2.4', '192.0.2.30', root / 'backup', True)['status'] == 'binding-acknowledged'
    assert [(ns, method) for ns, method, _ in calls] == [('Appliance.System.All', 'GET'), ('Appliance.Config.Key', 'SET')]
    try:
        original_request('192.0.2.4', device['key'], 'Appliance.GarageDoor.State', 'SET', {})
    except ValueError:
        pass
    else:
        raise AssertionError('Provisioner could send a movement command')
print('Private broker preparation, identity preservation and non-actuating binding checks passed')
