import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const profilePath = fileURLToPath(new URL('../integrations/homeassistant/tuya-local-desd8lw.yaml', import.meta.url));
const python = process.env.STMQ_JINJA_PYTHON || 'python3';
const hasYaml = spawnSync(python, ['-c', 'import yaml'], { stdio: 'ignore' }).status === 0;
const yamlTest = { skip: !hasYaml && 'Optional Tuya Local profile validation requires Python PyYAML' };
function readProfile() {
  const result = spawnSync(python, ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', profilePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('DESD8LW profile exposes only the independently verified native settings and humidity', yamlTest, () => {
  const profile = readProfile();
  assert.equal(profile.name, 'Dehumidifier');
  assert.equal(Object.hasOwn(profile, 'products'), false, 'No installation identifiers belong in the public profile');
  assert.deepEqual(profile.entities.map(entity => entity.entity), ['humidifier', 'select', 'sensor']);
  const [humidifier, fanSpeed, humidity] = profile.entities;
  assert.equal(humidifier.class, 'dehumidifier');
  assert.deepEqual(humidifier.dps.filter(dp => !dp.readonly), [
    { id: 1, type: 'boolean', name: 'switch' },
    { id: 2, type: 'integer', name: 'humidity', range: { min: 30, max: 80 }, mapping: [{ step: 5 }] },
  ]);
  assert.deepEqual(humidifier.dps.find(dp => dp.id === 6), { id: 6, type: 'integer', name: 'current_humidity', readonly: true });
  assert.equal(fanSpeed.name, 'Fan speed');
  assert.deepEqual(fanSpeed.dps, [{ id: 4, type: 'string', name: 'option', mapping: [
    { dps_val: 'low', value: 'low' }, { dps_val: 'mid', value: 'medium' }, { dps_val: 'high', value: 'high' },
  ] }]);
  assert.equal(humidity.class, 'humidity');
  assert.deepEqual(humidity.dps, [{ id: 6, type: 'integer', name: 'sensor', unit: '%', class: 'measurement', readonly: true }]);
  for (const dp of profile.entities.flatMap(entity => entity.dps)) {
    assert(!['mode', 'oscillate', 'temperature'].includes(dp.name), 'Unsupported controls and measurements are not invented');
    assert(!Object.hasOwn(dp, 'force'), 'No unverified device probes are configured');
  }
});

// Supply an unpacked public 2026.9.2 release to exercise Tuya Local's actual
// profile parser and DP encoder, without importing HA or opening any sockets.
// The ordinary profile contract test above needs no release checkout.
const upstream = process.env.STMQ_TUYA_LOCAL_SOURCE;
const helperPath = upstream && join(upstream, 'custom_components/tuya_local/helpers/device_config.py');
test('upstream Tuya Local parser round-trips supported readbacks and writes only the chosen DP', {
  skip: !hasYaml || !helperPath || !existsSync(helperPath) ? 'Set STMQ_TUYA_LOCAL_SOURCE to an unpacked Tuya Local 2026.9.2 release' : false,
}, () => {
  const program = `import importlib.util, json, pathlib, re, sys, types, yaml
profile_path, helper_path = map(pathlib.Path, sys.argv[1:])
for name in ['homeassistant', 'homeassistant.util', 'homeassistant.util.yaml', 'custom_components', 'custom_components.tuya_local', 'custom_components.tuya_local.devices']:
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
sys.modules['homeassistant.util'].slugify = lambda value: re.sub(r'[^a-z0-9]+', '_', value.lower()).strip('_')
sys.modules['homeassistant.util.yaml'].load_yaml = lambda path: yaml.safe_load(open(path))
sys.modules['custom_components.tuya_local.devices'].__file__ = str(profile_path.parent / '__init__.py')
spec = importlib.util.spec_from_file_location('device_config', helper_path)
mod = importlib.util.module_from_spec(spec)
# The pinned release uses Python 3.14's optional exception parentheses. The
# fixture runs the identical parser on older Python by restoring parentheses;
# no DP matching, mapping or command logic is substituted.
source = helper_path.read_text().replace('except TypeError, ValueError:', 'except (TypeError, ValueError):')
exec(compile(source, str(helper_path), 'exec'), mod.__dict__)
profile = mod.TuyaDeviceConfig(profile_path.name)
class Device:
    def __init__(self, values): self.values = values
    def get_property(self, key): return self.values.get(key)
device = Device({'1': False, '2': 55, '3': '60', '4': 'mid', '6': 52, '8': False, '10': False, '17': 'cancel', '18': 0, '19': 0})
entities = list(profile.all_entities())
humidifier = next(e for e in entities if e.entity == 'humidifier')
select = next(e for e in entities if e.entity == 'select')
humidity = next(e for e in entities if e.entity == 'sensor')
power_dp = humidifier.find_dps('switch')
target_dp = humidifier.find_dps('humidity')
fan_dp = select.find_dps('option')
rh_dp = humidity.find_dps('sensor')
result = {'matches': profile.matches(device.values, []), 'fanOptions': fan_dp.values(device),
    'fanState': fan_dp.get_value(device), 'humidity': rh_dp.get_value(device),
    'targetRange': target_dp.range(device), 'targetStep': target_dp.step(device),
    'powerOff': power_dp.get_values_to_set(device, False), 'powerOn': power_dp.get_values_to_set(device, True),
    'fanCommands': [fan_dp.get_values_to_set(device, option) for option in ['low', 'medium', 'high']],
    'targets': [target_dp.get_values_to_set(device, target) for target in range(30, 81, 5)],
    'humidityWrite': rh_dp.get_values_to_set(device, 75)}
print(json.dumps(result))
`;
  const result = spawnSync(python, ['-c', program, profilePath, helperPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.matches, true);
  assert.deepEqual(observed.fanOptions, ['low', 'medium', 'high']);
  assert.equal(observed.fanState, 'medium');
  assert.equal(observed.humidity, 52, 'Humidity remains percent, without the unrelated Breville profile scaling');
  assert.deepEqual(observed.targetRange, [30, 80]);
  assert.equal(observed.targetStep, 5);
  assert.deepEqual(observed.powerOff, { 1: false });
  assert.deepEqual(observed.powerOn, { 1: true });
  assert.deepEqual(observed.fanCommands, [{ 4: 'low' }, { 4: 'mid' }, { 4: 'high' }], 'Speed changes cannot include a power-on DP');
  assert.deepEqual(observed.targets, Array.from({ length: 11 }, (_, index) => ({ 2: 30 + index * 5 })));
  assert.deepEqual(observed.humidityWrite, {}, 'Read-only humidity can never become a writable setting');
});
