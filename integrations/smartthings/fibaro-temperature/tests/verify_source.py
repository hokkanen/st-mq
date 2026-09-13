#!/usr/bin/env python3
"""Verify the complete vendored source and run focused Lua behavior tests offline."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

base = Path(__file__).resolve().parents[1]
manifest = json.loads((base / "upstream.json").read_text())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
assert digest(base / "LICENSE") == manifest["license_sha256"], "upstream license changed"
with tempfile.TemporaryDirectory(prefix="stmq-fibaro-source-check-") as temporary:
    restored = Path(temporary) / "driver"
    shutil.copytree(base / "driver", restored)
    subprocess.run(
        ["patch", "--batch", "--reverse", "-p4", "-i", str(base / "changes.patch")],
        cwd=restored, check=True,
    )
    actual = {
        p.relative_to(restored).as_posix(): digest(p)
        for p in sorted(restored.rglob("*")) if p.is_file()
    }
    assert actual == manifest["sha256"], "source differs from pinned upstream plus exact patch"
print(f"Verified all {len(actual)} upstream driver files and Apache-2.0 license")

lua = next((p for name in ("lua", "lua5.4", "lua5.3", "texlua") if (p := shutil.which(name))), None)
if lua is None:
    raise SystemExit("Install Lua 5.3/5.4 or texlua to run the behavior checks")
subprocess.run([lua, str(base / "tests/temperature_reports.lua")], check=True)
