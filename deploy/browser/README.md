# Browser runtime

Enable Browser use in the Agent dialog. The manager adds a Chromium sidecar and uses the Agent PVC's
`browser` directory for shared profiles. Cookies and website storage survive pod replacement and
disable/re-enable. Incognito tabs and pending downloads are temporary. Agent deletion follows the
existing PVC owner lifecycle.

The Helm chart deploys a small node setup DaemonSet that installs Chromium's seccomp policy on every
Linux node and configures browser sidecars to use it automatically. Enabling browser use requires no
manual node setup. The installer uses the same browser image as the sidecar, with no network access
or Kubernetes API credentials required. It runs as root with all capabilities dropped, no privilege
escalation, a read-only root filesystem, and write access only to the kubelet's `seccomp/agentz`
directory. It does not run privileged.

The browser remains nonroot with Chromium's sandbox enabled. The existing pod CPU/memory budget
covers Chromium too. Scratch storage is limited to 1 GiB and shared memory to 256 MiB. Browser
startup may briefly wait for the installer on a new node. The installer restores removed profile
files and replaces changed files atomically. Profile filenames include their content hash, so
multiple releases cannot overwrite each other's policies. Profiles remain on the node after Helm
uninstall so existing Agent pods can restart.

`manager.browser.image` selects the image repository, tag or digest. The default tag is `v` followed
by the chart appVersion, matching CI release tags. `manager.config.browserImage` overrides the full
image for both the sidecar and installer. Build `Dockerfile.browser` to publish that image; it
contains the pinned Playwright version and matching Chromium, with no startup downloads. Both base
images are pinned by multiarchitecture digest.

The installer needs permission to mount its node-local directory. For clusters that already
provision profiles, set `manager.browser.seccomp.enabled=false` and configure
`manager.config.browserSeccompProfile` with the existing relative profile path. Use an empty profile
path for RuntimeDefault when it supports Chromium's namespaces. A custom kubelet root can be set
through `manager.browser.seccomp.kubeletDirectory`. Disabling the installer does not disable
Chromium's sandbox.

The generated profile is packaged in the manager chart's `files/browser-seccomp.json`.
`make generate` rebuilds it through `hack/browser/seccomp.py`, which verifies its pinned upstream
source hash. Standalone manager deployments must configure `--browser-image` and provide the profile
through their node provisioning or this Helm installer.

Website requests use direct pod networking and the Sandbox's existing Cilium allowedHosts policy.
The browser receives no proxy environment or secret-injection configuration. Both containers share
localhost and infrastructure network grants. Cilium FQDN grants resolve to IP access. Updating
allowedHosts changes policy in place and does not restart Chromium or immediately close established
connections.

The manager splits Agent ingress from broad infrastructure ingress. Existing Agent ports 4096/4097
retain their peer grants; browser control on 4098 permits only the configured gateway namespace and
ServiceAccount. Roll out the manager's policies before enabling browsers. No CDP or public browser
Service is exposed. The worker uses a private debugging pipe, per-Agent control credential,
Host/Origin checks, and authenticated gateway session access for human viewers.

Profiles and logins are shared by every user and workflow using the Agent. Tabs retain caller
ownership. Human takeover fences queued agent mutations; disconnect returns control and clears
pressed input. The default profile can be changed in the browser menu. Clearing cookies preserves
other website storage; resetting a profile closes its tabs and removes all its website storage.

The browser panel uses the existing chat workspace in general and coding chats. It supports live
viewing, takeover, tabs, profiles, uploads/downloads, recordings, viewport controls, element
context, and annotated screenshots. Desktop OS browser imports, passkey bridges, and default-browser
registration are excluded.
