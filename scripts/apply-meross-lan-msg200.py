#!/usr/bin/env python3
"""Preserve the reviewed Meross LAN MSG200 acknowledgement fix after reinstall."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'integrations' / 'homeassistant'
BEFORE = '        p_state = response.payload[mc.KEY_STATE]\n        if type(p_state) is list:\n            # we eventually expect a 1 item list with our channel of course\n            p_state = p_state[0]\n'
AFTER = '        p_state = stmq_garage_command_state(\n            response.payload[mc.KEY_STATE], self.index.value\n        )\n'

def digest(data):
    return hashlib.sha256(data).hexdigest()


def patched_source(original):
    contract = json.loads((BUNDLE / 'meross-lan-msg200.json').read_text())
    if digest(original) != contract['originalSha256']:
        raise ValueError('Unreviewed Meross LAN garage source')
    helper = (BUNDLE / 'meross-lan-msg200-state.py').read_text()
    source = original.decode()
    config = 'class GarageConfigMixin(ValueParser if TYPE_CHECKING else object):'
    first_class = 'class GarageTimeoutBinarySensor(BinarySensorEntity):'
    if any(source.count(context) != 1 for context in [BEFORE, config, first_class]):
        raise ValueError('Reviewed Meross LAN source context differs')
    result = (source.replace(BEFORE, AFTER)
              .replace(first_class, helper + '\n\n' + first_class)
              .replace(config, 'class GarageConfigMixin(StmqGarageConfigMixin, ValueParser if TYPE_CHECKING else object):').encode())
    # Upstream uses Python 3.12 type aliases. Installation on HA validates with
    # its native interpreter; older hosts can still verify exact reviewed bytes.
    if sys.version_info >= (3, 12):
        compile(result, 'garagedoor.py', 'exec')
    return result


def install(integration_dir, backup_dir=None, check=False):
    root = Path(integration_dir).resolve()
    manifest_path = root / 'manifest.json'
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    contract = json.loads((BUNDLE / 'meross-lan-msg200.json').read_text())
    if (manifest.get('domain') != 'meross_lan' or manifest.get('version') != contract['version']
            or manifest.get('requirements') != contract['requirements']):
        raise ValueError('Meross LAN version or dependencies need review')
    path = root / 'devices' / 'garagedoor.py'
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError('Meross LAN source must be a regular file')
    original = path.read_bytes()
    if digest((BUNDLE / 'meross-lan-msg200-state.py').read_bytes()) != contract['helperSha256']:
        raise ValueError('Meross LAN compatibility helper checksum differs')
    if digest(original) == contract['patchedSha256']:
        return {'status': 'already-installed', 'restartRequired': False}
    patched = patched_source(original)
    if digest(patched) != contract['patchedSha256']:
        raise ValueError('Meross LAN patched checksum differs')
    if check:
        return {'status': 'ready', 'restartRequired': False}
    if backup_dir is None:
        raise ValueError('A private backup directory is required')
    backup = Path(backup_dir).resolve()
    if backup.is_relative_to(ROOT) or backup.is_relative_to(root):
        raise ValueError('Backups must be outside the bundle and integration')
    backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    saved = backup / ('garagedoor.' + digest(original) + '.py')
    try:
        with saved.open('xb') as stream:
            os.chmod(saved, 0o600)
            stream.write(original)
    except FileExistsError:
        if saved.read_bytes() != original:
            raise ValueError('Meross LAN source backup differs')
    attributes = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix='.stmq-garage-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(patched)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, attributes.st_mode & 0o777)
        if os.stat(temporary).st_uid != attributes.st_uid or os.stat(temporary).st_gid != attributes.st_gid:
            os.chown(temporary, attributes.st_uid, attributes.st_gid)
        if path.is_symlink() or path.read_bytes() != original or manifest_path.read_bytes() != manifest_bytes:
            raise ValueError('Meross LAN source changed during installation')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'status': 'installed', 'restartRequired': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--integration-dir', required=True)
    parser.add_argument('--backup-dir')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.integration_dir, args.backup_dir, args.check)))
    except (ValueError, OSError, KeyError):
        parser.exit(1, 'Meross LAN MSG200 compatibility needs review; no unknown source was patched.\n')
