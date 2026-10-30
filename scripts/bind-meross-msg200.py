#!/usr/bin/env python3
"""Inspect an MSG200 or configure its local MQTT endpoint without moving doors."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def request(host, key, namespace, method, payload):
    if method != 'GET' and (namespace != 'Appliance.Config.Key' or method != 'SET'):
        raise ValueError('Only broker configuration can be written')
    message_id, timestamp = uuid.uuid4().hex, int(time.time())
    message = {'header': {'messageId': message_id, 'namespace': namespace, 'method': method,
        'payloadVersion': 1, 'from': '/app/stmq-provision/subscribe', 'timestamp': timestamp,
        'sign': hashlib.md5((message_id + key + str(timestamp)).encode()).hexdigest()}, 'payload': payload}
    response = json.load(urllib.request.urlopen(urllib.request.Request(
        'http://' + host + '/config', json.dumps(message).encode(), {'Content-Type': 'application/json'}), timeout=8))
    h = response['header']
    if (h.get('messageId') != message_id or h.get('namespace') != namespace
            or h.get('sign') != hashlib.md5((str(h['messageId']) + key + str(h['timestamp'])).encode()).hexdigest()
            or h.get('method') != method + 'ACK'):
        raise ValueError('Device response was not acknowledged')
    return response


def configure(device, host, broker=None, backup_dir=None, bind=False):
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location('meross_credentials', Path(__file__).with_name('prepare-meross-mosquitto.py'))
    module = module_from_spec(spec)
    # Loading this helper must not create artifacts beside installed scripts.
    import sys
    sys.dont_write_bytecode = True
    spec.loader.exec_module(module)
    module.device_login(device)
    host = str(ipaddress.IPv4Address(host))
    broker = str(ipaddress.IPv4Address(broker)) if broker is not None else None
    if bind and (broker is None or backup_dir is None):
        raise ValueError('Binding requires a broker endpoint and private backup directory')
    response = request(host, device['key'], 'Appliance.System.All', 'GET', {})
    system = response['payload']['all']['system']
    if system['hardware']['uuid'] != device['uuid'] or str(system['firmware']['userId']) != str(device['user_id']):
        raise ValueError('Device identity or user differs')
    if bind:
        backup = Path(backup_dir)
        if backup.is_symlink() or backup.resolve().is_relative_to(ROOT):
            raise ValueError('Use private backups outside the checkout')
        backup.mkdir(mode=0o700, parents=False, exist_ok=True)
        if backup.stat().st_mode & 0o077:
            raise ValueError('Backup directory must be private')
        saved = backup / 'before-binding.json'
        descriptor = os.open(saved, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(response, stream)
        request(host, device['key'], 'Appliance.Config.Key', 'SET', {'key': {
            'gateway': {'host': broker, 'port': 8883, 'secondHost': broker, 'secondPort': 8883, 'redirect': 1},
            'key': device['key'], 'userId': str(device['user_id'])}})
        return {'status': 'binding-acknowledged', 'reconnectVerified': False}
    firmware = system['firmware']
    state = request(host, device['key'], 'Appliance.GarageDoor.State', 'GET', {'state': []})
    return {'status': 'inspected', 'identityMatches': True,
            'brokerMatches': firmware.get('server') == broker and firmware.get('port') == 8883 if broker else None,
            'contacts': [{'channel': x['channel'], 'open': x['open']} for x in state['payload']['state']
                         if isinstance(x, dict) and x.get('channel') in (1, 2, 3)]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device-file', required=True)
    parser.add_argument('--device-host', required=True)
    parser.add_argument('--broker-host')
    parser.add_argument('--backup-dir')
    parser.add_argument('--bind', action='store_true')
    args = parser.parse_args()
    try:
        source = Path(args.device_file)
        if (source.is_symlink() or source.resolve().is_relative_to(ROOT)
                or source.stat().st_mode & 0o077 or source.parent.stat().st_mode & 0o077):
            raise ValueError('Device input requires a private file and directory')
        print(json.dumps(configure(json.loads(source.read_text()), args.device_host,
                                   args.broker_host, args.backup_dir, args.bind)))
    except (ValueError, OSError, KeyError, TypeError):
        parser.exit(1, 'Device configuration was not confirmed. Inspect current readback before any binding retry.\n')
