#!/usr/bin/env python3
"""Verify the complete vendored source and run focused Lua behavior tests offline."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import yaml

base = Path(__file__).resolve().parents[1]
manifest = json.loads((base / "upstream.json").read_text())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
assert digest(base / "LICENSE") == manifest["license_sha256"], "upstream license changed"
with tempfile.TemporaryDirectory(prefix="stmq-fibaro-source-check-") as temporary:
    restored = Path(temporary) / "driver"
    shutil.copytree(base / "driver", restored)
    (restored / "config.yml.template").rename(restored / "config.yml")
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

defaults = {
    "smokeSensorSensitivity": "1", "zwaveNotificationStatus": "0",
    "indicatorNotification": "0", "soundNotificationStatus": "0",
    "tempReportInterval": "90", "tempReportHysteresis": 1,
    "temperatureThreshold": "10", "overheatInterval": "180", "outOfRange": "360",
}
for name in ("smoke-battery-temperature-tamperalert", "smoke-battery-temperature-tamperalert-temperaturealarm"):
    profile = yaml.safe_load((base / "driver/profiles" / (name + ".yml")).read_text())
    declared = {preference["name"]: preference for preference in profile["preferences"]}
    assert len(profile["preferences"]) == len(declared) == 10, "exactly ten distinct preferences required"
    for preference, default in defaults.items():
        assert declared[preference]["definition"]["default"] == default
    threshold = declared["temperatureThreshold"]
    assert threshold["title"] == "Temperature report - threshold"
    assert threshold["description"] == (
        "This parameter determines the change in measured temperature that will result "
        "in new temperature report being sent to the main controller."
    ), "the requested legacy threshold definition must remain unchanged"
    assert threshold["definition"]["options"]["10"] == "2°F/1 °C"
    wake = declared["wakeUpIntervalSeconds"]["definition"]
    assert wake["default"] == "4200"
    assert wake["options"] == {
        "4200": "70 minutes", "7200": "2 hours", "10800": "3 hours",
        "21600": "6 hours", "43200": "12 hours",
    }
print("Verified both profiles' nine requested defaults, threshold definition, and wake-up choices")

lua = next((p for name in ("lua", "lua5.4", "lua5.3", "texlua", "luatex") if (p := shutil.which(name))), None)
if lua is None:
    raise SystemExit("Install Lua 5.3/5.4 or texlua to run the behavior checks")
subprocess.run([lua, *(["--luaonly"] if Path(lua).name == "luatex" else []), str(base / "tests/temperature_reports.lua")], check=True)
