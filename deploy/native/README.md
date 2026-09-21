# Native compute

AgentZ runs OpenCode as the enrolling Linux account. The root supervisor runs
SPIRE and KubeArmor and manages fixed systemd units and network rules. This is
full user authority: OpenCode can access that account's files and credentials.
It is not a sandbox against the host owner or hostile code using local services.

## Backend

Enable `gateway.compute.enabled`, set `gateway.strategy.type=Recreate`, and keep
`gateway.replicaCount=1` for the bundled SPIRE sidecar. Set
`gateway.compute.publicAddress` to the externally reachable compute `host:9443`
and `gateway.compute.spirePublicAddress` to SPIRE's `host:8081`. Both need TCP
passthrough; do not terminate their SPIFFE TLS at an ordinary HTTPS ingress.
The existing HTTPS gateway handles browser pairing.

Provide an operator-managed upstream root Secret named by
`gateway.compute.spire.upstreamSecret`, containing `root.pem` and `root-key.pem`.
The root must be a CA, have enough path length for a signing intermediate, and
remain valid for more than one year. Store and back up this Secret securely.
SPIRE signing keys, node records and registration entries use the dedicated PVC;
back up that state too. The sidecar's administrative Unix socket stays inside the
gateway pod. External administrative clients must use an explicitly authorized
SPIRE admin identity and verified mutual TLS; the local socket is never public.

The gateway advances SPIRE's intermediate with its built-in LocalAuthority APIs
at 90 days, before its remaining lifetime can truncate the 210-day node SVID.
Node renewal starts with 200 days remaining. Enrollment checks actual validity;
a consumed join token is never used as a recovery credential. Intermediate
rotation must retain the old chain's trust for sleeping nodes. Root rotation
requires an overlap covering offline devices; replacing the root or losing the
PVC can require re-enrollment. Monitor identity-maintenance errors and root
expiry. Workload and backend SVIDs last one hour and refresh automatically.

## Host

Use a Linux amd64 or arm64 systemd host with a kernel supported by KubeArmor,
HTTPS access to the backend and release/Nix sources, and TCP access to both
SPIFFE endpoints. Initial prerequisites are Bash, curl, tar, sha256sum and
getent. Keep SELinux enabled; its normal policy utilities must be installed on
SELinux hosts. Kernel sensor and SELinux compatibility must be verified on each
supported distribution before production rollout. Native sensor startup, mutual
TLS, and real OpenCode process/file/network telemetry have been exercised on
Linux 6.12.107 (Debian cloud kernel). Other kernels, SELinux hosts and arm64
still need distribution compatibility testing.

Review `install.sh` from the release, then run it from the intended user's
account:

```sh
sudo bash install.sh https://gateway.example vVERSION "$USER" "$HOME/agentz" "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_STATE_HOME:-$HOME/.local/state}" "${XDG_CACHE_HOME:-$HOME/.cache}"
```

Replace `vVERSION` with an actual stable release. The final four arguments preserve
custom XDG directories even when sudo removes environment variables. The
installer verifies signed GitHub build provenance before executing the downloaded
AgentZ binary. Nix, SPIRE and KubeArmor bootstrap artifacts have pinned SHA-256
digests. OpenCode and host tools come from pinned Nix sources. No customer-side
container engine is required.

Create a computer in the web app, generate its one-use enrollment code, and
paste that code when the installer prompts. The enrollment account, work
directory and SPIRE state survive service
and host restarts. Root-only identity/configuration lives under `/etc/agentz`
and `/var/lib/agentz`; the user owns the work directory. Do not clone SPIRE
private state onto another machine.

Inspect services with:

```sh
sudo /usr/local/lib/agentz/agentz daemon status
sudo journalctl -u agentz-daemon -u agentz-spire -u agentz-kubearmor
```

Re-running the installer with another verified release updates binaries and
restarts services while retaining enrollment. Updates are manual. KubeArmor's
local mTLS credentials are root-only. Its stock `self` provider uses a dedicated
RSA CA; the subscriber verifies its chain and ServerAuth usage against that CA
without DNS matching because the sensor certificate uses the changing host IP.
The release's `external` provider is unusable on native hosts because its feeder
omits the certificate path. The `agentz_sensor` nftables table blocks
external access to its telemetry and health ports. Never expose those ports.

Stock KubeArmor v1.7.5 panicked during one tested shutdown with `send on closed
channel` in `TraceSyscall`, leaving BPF pins and its own host firewall tables.
Listeners closed, but sensor shutdown cannot yet be considered reliable on the
tested kernel. Inspect the sensor journal and residual resources when removing
an installation; do not remove resources owned by another KubeArmor instance.

Native telemetry selects events whose immediate parent executable basename is
`opencode`. It includes process, file and network records, not an inferred
recursive process tree. Forwarding uses a bounded memory queue; outages and
queue overflow drop telemetry and emit loss counts in the daemon journal.
Existing local work can continue while disconnected; reconnecting does not
replay user effects. Central MCP, inference and optional secret injection still
require backend connectivity.

## Validation

The native path was exercised on an amd64 systemd host against the Kubernetes
backend through the production web build. Tests covered browser enrollment,
actual SPIRE attestation, OpenCode chat and file operations, secret proxy on/off,
local credentials, disconnect/reconnect with the same OpenCode process, expired
and concurrently redeemed codes, revocation, and repeated local unenrollment.
Actual OpenCode traces and filtered KubeArmor events reached backend storage.
Assigned inference routing and Cilium denial for the wrong identity or sandbox
were checked against real cluster services. The existing hosted Agent also
passed health and filesystem checks. Model replies used a controlled test server.

Go tests and race checks, lint, TypeScript checks, the production Next.js build,
generators, Helm, release configuration and native Nix builds passed. These
checks do not cover six months of elapsed offline time, published release
downloads, or the full distribution, SELinux and arm64 matrix. MCP forwarding
was exercised in an isolated fixture; cluster MCP services were unavailable.
