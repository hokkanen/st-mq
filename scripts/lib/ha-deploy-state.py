"""Read-only deployment checks, executed inside the Supervisor container.

Only the private digest snapshot is written. Raw settings and credentials never
leave this process; Supervisor's effective options are not the saved overrides.
"""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess


class DeploymentStateError(Exception):
    """Fixed public diagnostics; no exception includes file or option contents."""

    MESSAGES = {
        "state": "Saved Supervisor configuration is unavailable or invalid",
        "snapshot": "Deployment preservation snapshot is unavailable or invalid",
        "files": "Stored files changed during deployment or could not be verified",
        "saved-settings": "Saved installation settings changed during deployment",
        "metadata": "Installed Supervisor metadata changed before rebuilding",
        "source": "Deployment source no longer matches the selected clean revision",
        "schema": "Installed Supervisor schema does not match the selected revision",
        "defaults": "Installed Supervisor defaults do not match the selected revision",
        "version": "Installed Supervisor metadata version does not match the selected revision",
    }

    def __init__(self, code):
        self.code = code
        super().__init__(self.MESSAGES[code])


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("Invalid JSON constant")


def _read_json(path):
    return json.loads(Path(path).read_text(), object_pairs_hook=_object,
                      parse_constant=_invalid_constant)


def _digest(value):
    # Canonical JSON preserves false/0 and true/1 distinctions, unlike Python
    # object equality, and ignores only object key order, including nested keys.
    data = json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _state(state_path, slug):
    try:
        state = _read_json(state_path)
        user = state["user"][slug]
        system = state["system"][slug]
        if not isinstance(user, dict) or not isinstance(user["options"], dict):
            raise ValueError()
        if not isinstance(system, dict):
            raise ValueError()
        return user, system
    except Exception:
        raise DeploymentStateError("state") from None


def _files(roots):
    records = {}

    def walk(path):
        value = path.lstat()
        if stat.S_ISLNK(value.st_mode):
            records[str(path)] = ["link", os.readlink(path)]
        elif stat.S_ISDIR(value.st_mode):
            records[str(path)] = ["directory"]
            for child in sorted(path.iterdir()):
                walk(child)
        elif stat.S_ISREG(value.st_mode):
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            records[str(path)] = ["file", digest.hexdigest()]
        else:
            raise ValueError("Unsupported stored file type")

    try:
        for root in roots:
            path = Path(root)
            if not path.exists() and not path.is_symlink():
                records[str(path)] = ["absent"]
            else:
                walk(path)
        return _digest(records)
    except Exception:
        raise DeploymentStateError("files") from None


def _scope(state_path, slug, roots):
    return _digest([str(state_path), slug, [str(root) for root in roots]])


def snapshot(state_path, slug, roots, snapshot_path):
    """Save only digests of raw settings, metadata and stored files, exclusively."""
    roots = list(roots)
    user, system = _state(state_path, slug)
    data = {
        "scope": _scope(state_path, slug, roots),
        "files": _files(roots),
        "user": _digest(user),
        "system": _digest(system),
    }
    try:
        descriptor = os.open(snapshot_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                             0o600)
        with os.fdopen(descriptor, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(data, output, sort_keys=True)
    except Exception:
        raise DeploymentStateError("snapshot") from None


def verify(state_path, slug, roots, snapshot_path, root, target, manifest_hash,
           installed=False, check_files=True):
    """Verify preservation and the exact source, then installed metadata if asked.

    Before rebuilding, installed metadata must remain as snapshotted. Afterwards,
    its schema/defaults/version must match the selected source; saved user state
    must remain identical in both phases, including retired override fields.
    Intermediate fences may skip stored-file hashes; final verification must use
    the default check_files=True to compare every stored file with the snapshot.
    """
    roots = list(roots)
    try:
        snapshot_stat = Path(snapshot_path).lstat()
        if not stat.S_ISREG(snapshot_stat.st_mode):
            raise ValueError()
        if stat.S_IMODE(snapshot_stat.st_mode) != 0o600:
            raise ValueError()
        saved = _read_json(snapshot_path)
        if set(saved) != {"scope", "files", "user", "system"}:
            raise ValueError()
        if any(not isinstance(value, str) or len(value) != 64 or
               any(char not in "0123456789abcdef" for char in value)
               for value in saved.values()):
            raise ValueError()
        if saved["scope"] != _scope(state_path, slug, roots):
            raise ValueError()
    except Exception:
        raise DeploymentStateError("snapshot") from None

    user, system = _state(state_path, slug)
    if _digest(user) != saved["user"]:
        raise DeploymentStateError("saved-settings")
    if check_files and _files(roots) != saved["files"]:
        raise DeploymentStateError("files")
    try:
        def git(*args):
            return subprocess.check_output(
                ["git", "-C", str(root), *args], stderr=subprocess.PIPE,
                text=True, timeout=30).strip()

        if git("rev-parse", "HEAD") != target or git("status", "--porcelain"):
            raise ValueError()
        manifest_path = Path(root) / "config.json"
        if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != manifest_hash:
            raise ValueError()
        manifest = _read_json(manifest_path)
        if (not isinstance(manifest["schema"], dict) or
                not isinstance(manifest["options"], dict) or
                not isinstance(manifest["version"], str) or
                not manifest["version"]):
            raise ValueError()
    except Exception:
        raise DeploymentStateError("source") from None

    if not installed:
        if _digest(system) != saved["system"]:
            raise DeploymentStateError("metadata")
        return
    for field, code in (("schema", "schema"), ("options", "defaults"),
                        ("version", "version")):
        if field not in system or _digest(system[field]) != _digest(manifest[field]):
            raise DeploymentStateError(code)
