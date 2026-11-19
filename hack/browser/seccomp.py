#!/usr/bin/env python3

"""Build OCI profiles for the cap-less Chromium worker from Playwright's Docker profile."""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

source = "https://raw.githubusercontent.com/microsoft/playwright/v1.65.1/utils/docker/seccomp_profile.json"
with urlopen(source) as response:
    data = response.read()

if hashlib.sha256(data).hexdigest() != "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849":
    raise SystemExit("Playwright seccomp checksum mismatch")

profile = json.loads(data)
architectures = {"amd64": "SCMP_ARCH_X86_64", "arm64": "SCMP_ARCH_AARCH64"}
output = Path("deploy/helm/charts/manager/files")
for arch, native in architectures.items():
    mapping = next(entry for entry in profile["archMap"] if entry["architecture"] == native)
    syscalls = []
    for entry in profile["syscalls"]:
        includes = entry["includes"]
        excludes = entry["excludes"]
        for condition in (includes, excludes):
            if condition.keys() - {"arches", "caps", "minKernel"}:
                raise SystemExit(f"Unsupported Docker seccomp condition: {condition}")
        # The worker drops ALL capabilities. Omit kernel-conditional grants
        # because the generated profile is shared by nodes with different kernels.
        if includes.get("caps") or includes.get("minKernel"):
            continue
        if excludes.get("minKernel"):
            raise SystemExit(f"Unsupported Docker seccomp exclusion: {excludes}")
        if includes.get("arches") and arch not in includes["arches"]:
            continue
        if arch in excludes.get("arches", []):
            continue
        syscalls.append({k: v for k, v in entry.items() if k not in {"includes", "excludes", "comment"}})

    # chroot is needed inside Chromium's nested user namespace.
    syscalls.append({"names": ["chroot"], "action": "SCMP_ACT_ALLOW", "args": []})
    oci = {
        "defaultAction": profile["defaultAction"],
        "architectures": [native, *mapping["subArchitectures"]],
        "syscalls": syscalls,
    }
    (output / f"browser-seccomp-{arch}.json").write_text(json.dumps(oci, indent=2) + "\n")
