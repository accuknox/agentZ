#!/usr/bin/env python3
"""Build Chromium's node-local profile from Playwright's pinned Docker profile."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

source = "https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/utils/docker/seccomp_profile.json"
with urlopen(source) as response:
    data = response.read()
if hashlib.sha256(data).hexdigest() != "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849":
    raise SystemExit("Playwright seccomp checksum mismatch")
profile = json.loads(data)
# The nested user namespace needs chroot even when the outer container drops all caps.
profile["syscalls"].append({"names": ["chroot"], "action": "SCMP_ACT_ALLOW", "args": [], "includes": {}, "excludes": {}})
Path("deploy/browser/seccomp.json").write_text(json.dumps(profile, indent=2) + "\n")
