import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function leaves(value, path = []) {
  return value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
    : [{ path: path.join('.'), key: path.at(-1), value }];
}

test('public defaults leave credentials, household coordinates and installation identities empty', () => {
  // Failure output contains field names only, even if a private value is added.
  const privateField = /^(?:web_token|web_family_token|token|pw|password|user|username|email|latitude|longitude|h66_device|h66_verification_file|deviceId|charger_id|equalizer_id|charge_point_id|pair_id|peer_url|ssh_host|ssh_config|ca_certificate|ca_certificate_domain|vin|mac|serial)$/i;
  const fields = leaves(manifest.options);
  const populated = fields.filter(({ key, value }) => privateField.test(key) && value !== '').map(({ path }) => path);
  assert.deepEqual(populated, [], 'Private configuration fields must have empty public defaults');
  assert.ok(Array.isArray(manifest.options.easee.local_ocpp.authorization_tags)
    && manifest.options.easee.local_ocpp.authorization_tags.length === 0, 'Public defaults must contain no authorization tags');

  for (const { path, value: rule } of leaves(manifest.schema)) {
    if (typeof rule !== 'string' || !/^password\??$/.test(rule)) continue;
    const value = path.split('.').reduce((parent, key) => parent?.[key], manifest.options);
    assert.ok(value === undefined || value === '', `Credential default must be empty: ${path}`);
  }
});

test('public connection defaults use generic service names and MQTT topics', () => {
  const broker = new URL(manifest.options.mqtt.address);
  assert.ok(broker.hostname === 'core-mosquitto' && !broker.username && !broker.password,
    'The public broker default must name the standard Home Assistant service without credentials');
  assert.ok(manifest.options.easee.local_ocpp.host === '0.0.0.0' && manifest.options.pair.listen_host === '0.0.0.0',
    'Public listeners must not contain installation addresses');
  assert.deepEqual(manifest.options.mqtt.ha, {}, 'No separate HA broker is selected in public defaults');
  for (const path of ['easee.local_ocpp.server_url', 'pair.vip_address', 'mirror.remote_directory',
    'mirror.receiver_path', 'pair.directory', 'pair.snapshot_directory', 'mirror.directory']) {
    assert.ok(path.split('.').reduce((parent, key) => parent?.[key], manifest.options) === '',
      `Installation endpoint or path must have an empty public default: ${path}`);
  }

  const connections = leaves(manifest.options).filter(({ key, value }) => typeof value === 'string' && value
    && /^(?:connection|topic|.*_topic|.*Topic|topicPrefix|topic_prefix)$/.test(key));
  const privateRoutes = connections.filter(({ value }) => !/^(?:(?:mqtt|shelly):)?(?:stmq\/|heatpump\/garage\/|homeassistant\/status$)/.test(value));
  assert.deepEqual(privateRoutes.map(({ path }) => path), [], 'Public routes must remain generic equipment topics');

  // TeslaMate uses a local ordinal and conventional geofence label, not a VIN,
  // account identifier, coordinates or an owner's vehicle/household name.
  assert.ok(manifest.options.teslamate.carId === '1' && manifest.options.teslamate.homeGeofence === 'Home',
    'TeslaMate public defaults must retain generic setup labels');
});

test('public defaults contain no personal contact details, hardware addresses or home-directory paths', () => {
  const personalPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}|^\/(?:home|Users)\/[^/\s]+/i;
  const findings = leaves(manifest.options).filter(({ value }) => typeof value === 'string' && personalPattern.test(value));
  assert.deepEqual(findings.map(({ path }) => path), [], 'Potential private defaults require review outside test output');
});
