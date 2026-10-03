#!/usr/bin/env python3
"""Build the driver ZIP outside the checkout without uploading to SmartThings."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new ZIP path outside the repository")
    args = parser.parse_args()
    base = Path(__file__).resolve().parent
    repository = base.parents[2]
    output = args.output.resolve()
    if output == repository or repository in output.parents:
        parser.error("write build artifacts outside the repository")
    if output.suffix != ".zip" or not output.parent.is_dir():
        parser.error("output must be a .zip path in an existing directory")
    if output.exists():
        parser.error("output already exists; choose a new ZIP path")
    if shutil.which("smartthings") is None:
        parser.error("install the SmartThings CLI before building")

    # SmartThings requires config.yml. Keeping only its template in Git avoids
    # Home Assistant's recursive app-manifest discovery treating it as an app.
    with tempfile.TemporaryDirectory(prefix="stmq-fibaro-build-", dir=output.parent) as temporary:
        driver = Path(temporary) / "driver"
        shutil.copytree(base / "driver", driver)
        (driver / "config.yml.template").rename(driver / "config.yml")
        subprocess.run([
            "smartthings", "edge:drivers:package", "--build-only", str(output), str(driver),
        ], check=True)


if __name__ == "__main__":
    main()
