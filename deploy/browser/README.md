# Browser runtime

Enable Browser use in the Agent dialog. The manager adds a Chromium sidecar and uses the Agent PVC's
`browser` directory for shared profiles. Cookies and website storage survive pod replacement and
disable/re-enable. Incognito tabs and pending downloads are temporary. Agent deletion follows the
existing PVC owner lifecycle.

Build `Dockerfile.browser` and set the manager's `--browser-image` flag, or Helm's `browserImage`
value, to the published image. The image pins Playwright and its matching Chromium. It needs no
outbound downloads at startup. The existing pod CPU/memory budget covers Chromium too. Scratch
storage is limited to 1 GiB and shared memory to 256 MiB.

Chromium's sandbox stays enabled. On hosts where RuntimeDefault blocks nested user namespaces,
install `seccomp.json` under the kubelet's seccomp directory on each schedulable node, then set
`--browser-seccomp-profile`, or Helm's `browserSeccompProfile`, to its relative path. For example,
install the file as `/var/lib/kubelet/seccomp/agentz-browser.json` and configure
`agentz-browser.json`. Node provisioning must install it before scheduling browser-enabled Agents.
The profile derives from Playwright 1.64.1, with `chroot` permitted for Chromium's nested user
namespace while all container capabilities remain dropped. Rebuild it with
`python3 hack/browser/seccomp.py`; the generator verifies the upstream hash. The worker fails
startup if sandboxed Chromium cannot launch.

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
