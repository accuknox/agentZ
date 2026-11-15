#!/usr/bin/env python3

"""Build the Helm-installed Chromium profile from Playwright's pinned profile."""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

source = "https://raw.githubusercontent.com/microsoft/playwright/v1.65.1/utils/docker/seccomp_profile.json"
with urlopen(source) as response:
    data = response.read()

if hashlib.sha256(data).hexdigest() != "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849":
    raise SystemExit("Playwright seccomp checksum mismatch")

# The nested user namespace needs chroot even when the outer container drops
# all caps.
profile = json.loads(data)
profile["syscalls"].append({"names": ["chroot"], "action": "SCMP_ACT_ALLOW", "args": [], "includes": {}, "excludes": {}})

Path("deploy/helm/charts/manager/files/browser-seccomp.json").write_text(json.dumps(profile, indent=2) + "\n")
