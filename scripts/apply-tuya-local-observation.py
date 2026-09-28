#!/usr/bin/env python3
"""Apply the pinned Tuya Local observation adapter without network access or reloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'integrations' / 'homeassistant'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def patched_sources(patch, originals):
    """Apply exact unified-diff context; no fuzzy matching or omitted files."""
    lines = patch.splitlines()
    cursor = 0
    results = {}
    while cursor < len(lines):
        match = re.fullmatch(r'--- a/(device\.py|entity\.py)', lines[cursor])
        if not match:
            raise ValueError('Unsupported observation patch header')
        name = match.group(1)
        cursor += 1
        if name in results or cursor >= len(lines) or lines[cursor] != f'+++ b/{name}':
            raise ValueError('Invalid observation patch destination')
        cursor += 1
        original = originals[name]
        newline = '\r\n' if b'\r\n' in original else '\n'
        source = original.decode('utf-8').splitlines()
        output, consumed = [], 0
        while cursor < len(lines) and lines[cursor].startswith('@@ '):
            hunk = re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*', lines[cursor])
            if not hunk:
                raise ValueError('Invalid observation patch hunk')
            start = int(hunk.group(1)) - 1
            before, after = int(hunk.group(2) or 1), int(hunk.group(4) or 1)
            if start < consumed or start > len(source):
                raise ValueError('Observation patch source position differs')
            output.extend(source[consumed:start])
            consumed = start
            cursor += 1
            old_count = new_count = 0
            while cursor < len(lines) and not lines[cursor].startswith(('@@ ', '--- a/')):
                line = lines[cursor]
                cursor += 1
                if not line or line[0] not in ' +-':
                    raise ValueError('Unsupported observation patch line')
                prefix, text = line[0], line[1:]
                if prefix in ' -':
                    if consumed >= len(source) or source[consumed] != text:
                        raise ValueError('Observation patch source context differs')
                    consumed += 1
                    old_count += 1
                if prefix in ' +':
                    output.append(text)
                    new_count += 1
            if old_count != before or new_count != after:
                raise ValueError('Observation patch hunk size differs')
        output.extend(source[consumed:])
        results[name] = (newline.join(output) + newline).encode('utf-8')
    if set(results) != set(originals):
        raise ValueError('Observation patch must cover both pinned source files')
    return results


def atomic_replace(path, data, original_stat):
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(original_stat.st_mode))
        if os.stat(temporary).st_uid != original_stat.st_uid or os.stat(temporary).st_gid != original_stat.st_gid:
            os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(integration_dir, backup_dir=None, check=False):
    integration_dir = Path(integration_dir).resolve()
    contract = json.loads((BUNDLE / 'tuya-local-observation.json').read_text())
    manifest = json.loads((integration_dir / 'manifest.json').read_text())
    if manifest.get('domain') != 'tuya_local' or manifest.get('version') != contract['version']:
        raise ValueError('Observation adapter requires the exact supported Tuya Local version')
    if set(contract['files']) != {'device.py', 'entity.py'}:
        raise ValueError('Invalid observation adapter source contract')
    patch = (BUNDLE / 'tuya-local-observation.patch').read_bytes()
    if digest(patch) != contract['patchSha256']:
        raise ValueError('Observation adapter patch checksum differs')
    originals, states, attributes = {}, {}, {}
    for name, hashes in contract['files'].items():
        path = integration_dir / name
        if path.is_symlink():
            raise ValueError('Observation adapter refuses a symbolic-link source file')
        data = path.read_bytes()
        sha = digest(data)
        state = 'original' if sha == hashes['originalSha256'] else 'patched' if sha == hashes['patchedSha256'] else None
        if state is None:
            raise ValueError(f'Unrecognized Tuya Local {name}; inspect this source before adapting a new version')
        originals[name], states[name], attributes[name] = data, state, path.stat()
    if len(set(states.values())) != 1:
        raise ValueError('Partially installed observation adapter; restore the reviewed backup before retrying')
    if states['device.py'] == 'patched':
        return {'status': 'already-installed', 'version': contract['version']}
    patched = patched_sources(patch.decode('utf-8'), originals)
    if any(digest(data) != contract['files'][name]['patchedSha256'] for name, data in patched.items()):
        raise ValueError('Patched observation adapter checksum differs')
    if check:
        return {'status': 'ready', 'version': contract['version']}
    if backup_dir is None:
        raise ValueError('A backup directory outside the repository and integration is required')
    backup_dir = Path(backup_dir).resolve()
    if backup_dir.is_relative_to(ROOT) or backup_dir.is_relative_to(integration_dir):
        raise ValueError('The backup directory must be outside the repository and integration')
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name, data in originals.items():
        backup = backup_dir / f'{name}.{digest(data)}.bak'
        try:
            descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if backup.read_bytes() != data:
                raise ValueError('Existing observation adapter backup differs')
        else:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
    changed = []
    try:
        for name, data in patched.items():
            # Refuse a concurrent HACS update between preflight and publication.
            path = integration_dir / name
            if path.read_bytes() != originals[name]:
                raise ValueError('Tuya Local source changed during installation')
            atomic_replace(path, data, attributes[name])
            changed.append(name)
    except BaseException:
        for name in reversed(changed):
            atomic_replace(integration_dir / name, originals[name], attributes[name])
        raise
    return {'status': 'installed', 'version': contract['version'], 'restartRequired': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--integration-dir', required=True)
    parser.add_argument('--backup-dir')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.integration_dir, args.backup_dir, args.check)))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f'Observation adapter was not installed: {error}\n')
