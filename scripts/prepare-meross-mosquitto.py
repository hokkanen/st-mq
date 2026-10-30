#!/usr/bin/env python3
"""Prepare private MSG200 authentication files for Mosquitto 2.0 on Linux."""
import argparse
import copy
import base64
import hashlib
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def device_login(device):
    if (set(device) != {'uuid', 'key', 'user_id'}
            or not re.fullmatch('[a-f0-9]{32}', str(device.get('uuid', '')))
            or not re.fullmatch('[a-f0-9]{32}', str(device.get('key', '')))
            or type(device['user_id']) not in (str, int)
            or not re.fullmatch('0|[1-9][0-9]{0,19}', str(device['user_id']))):
        raise ValueError('Use canonical uuid, key and user_id fields')
    mac = ':'.join(re.findall('..', device['uuid'][-12:]))
    password = str(device['user_id']) + '_' + hashlib.md5((mac + device['key']).encode()).hexdigest()
    return {'username': mac, 'password': password}


def authentication_state(device, password_users, existing=None):
    login = device_login(device)
    state = copy.deepcopy(existing) if existing is not None else {
        'clients': [], 'roles': [], 'defaultACLAccess': {
            'publishClientSend': False, 'publishClientReceive': False,
            'subscribe': False, 'unsubscribe': False}}
    if not isinstance(state, dict) or any(not isinstance(state.get(k), list) for k in ['clients', 'roles']):
        raise ValueError('Invalid Dynamic Security configuration')
    if any(state.get('defaultACLAccess', {}).values()):
        raise ValueError('Existing default-allow authorization requires manual review')
    if any(c.get('username') == login['username'] for c in state['clients']):
        raise ValueError('Native account already exists; review its current configuration')
    native_role = 'meross_' + device['uuid']
    if any(r.get('rolename') == native_role for r in state['roles']):
        raise ValueError('Native role already exists')
    acl = lambda kind, topic, allow=True, priority=10: {
        'acltype': kind, 'topic': topic, 'allow': allow, 'priority': priority}
    native = '/appliance/' + device['uuid']
    kinds = ['publishClientSend', 'publishClientReceive', 'subscribePattern', 'unsubscribePattern']
    permissions = [acl(k, '#', False, 0) for k in kinds] + [
        acl('publishClientSend', native + '/publish'), acl('publishClientSend', '/app/+/subscribe'),
        acl('publishClientReceive', native + '/subscribe'), acl('subscribePattern', native + '/subscribe'),
        acl('unsubscribePattern', native + '/subscribe')]
    state['roles'].append({'rolename': native_role, 'acls': permissions})
    salt = os.urandom(12)
    state['clients'].append({'username': login['username'], 'password': base64.b64encode(
        hashlib.pbkdf2_hmac('sha512', login['password'].encode(), salt, 100000, 64)).decode(),
        'salt': base64.b64encode(salt).decode(), 'iterations': 100000,
        'roles': [{'rolename': native_role}]})
    # These records defer authentication to the existing password file.
    # Existing Dynamic Security clients keep their current authorization.
    role = {'rolename': 'stmq_password_file_accounts', 'acls': [acl(k, '#') for k in kinds]
            + [acl('publishClientReceive', '$SYS/#'), acl('subscribePattern', '$SYS/#')]}
    previous_role = next((r for r in state['roles'] if r.get('rolename') == role['rolename']), None)
    if previous_role is not None and previous_role != role:
        raise ValueError('Password-file account role differs; review existing authorization')
    if previous_role is None:
        state['roles'].append(role)
    present = {c.get('username') for c in state['clients']}
    for name in sorted(password_users - present):
        state['clients'].append({'username': name, 'roles': [{'rolename': role['rolename']}]})
    return login, state


def prepare(device_file, password_file, output_dir, dynamic_security=None):
    source = Path(device_file)
    if (source.is_symlink() or source.resolve().is_relative_to(ROOT)
            or source.stat().st_mode & 0o077 or source.parent.stat().st_mode & 0o077):
        raise ValueError('Device input requires a private regular file and directory')
    device = json.loads(source.read_text())
    rows = Path(password_file).read_text().splitlines()
    users = set()
    for line in rows:
        if not line or line.startswith('#'):
            continue
        name, separator, password = line.partition(':')
        if not separator or not name or not password:
            raise ValueError('Invalid existing password-file entry')
        users.add(name)
    existing = json.loads(Path(dynamic_security).read_text()) if dynamic_security else None
    login, state = authentication_state(device, users, existing)
    target = Path(output_dir)
    if target.is_symlink() or target.resolve().is_relative_to(ROOT) or target.exists():
        raise ValueError('Use a new private output directory outside the checkout')
    target.mkdir(mode=0o700, parents=False)
    for name, value in [('device-login.json', login), ('dynamic-security.json', state)]:
        descriptor = os.open(target / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
    return {'status': 'prepared', 'files': 2, 'passwordFileAccounts': len(users)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device-file', required=True)
    parser.add_argument('--password-file', required=True)
    parser.add_argument('--dynamic-security')
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.device_file, args.password_file, args.output_dir, args.dynamic_security)))
    except (ValueError, OSError, KeyError, TypeError):
        parser.exit(1, 'Authentication files were not prepared; check private inputs and existing authorization.\n')
