#!/usr/bin/env bash
# Run a reviewed copy with sudo; release binaries are verified before execution.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run with sudo from the account that will run OpenCode.' >&2; exit 1; }
backend=${1:?Usage: sudo bash install.sh https://backend.example vVERSION [user workdir config-home data-home state-home cache-home]}
version=${2:?A release version is required}
username=${3:-${SUDO_USER:-}}
[[ $backend == https://* && $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'HTTPS backend and explicit stable release required' >&2; exit 1; }
[[ -n $username && $username != root ]] || { echo 'Specify the non-root OpenCode account.' >&2; exit 1; }
user_home=$(getent passwd "$username" | cut -d: -f6)
[[ $user_home == /* && $(id -u "$username") != 0 ]] || exit 1
workdir=${4:-$user_home/agentz}
config_home=${5:-${XDG_CONFIG_HOME:-$user_home/.config}}
data_home=${6:-${XDG_DATA_HOME:-$user_home/.local/share}}
state_home=${7:-${XDG_STATE_HOME:-$user_home/.local/state}}
cache_home=${8:-${XDG_CACHE_HOME:-$user_home/.cache}}
[[ $config_home == /* ]] || { echo "XDG config directory must be absolute" >&2; exit 1; }
[[ $workdir == /* ]] || { echo 'Work directory must be absolute' >&2; exit 1; }
[[ -d /run/systemd/system && $(uname -s) == Linux ]] || { echo 'A booted Linux systemd host is required.' >&2; exit 1; }
for tool in curl sha256sum tar getent; do command -v "$tool" >/dev/null; done
case $(uname -m) in
  x86_64) arch=amd64; nixarch=x86_64; nixhash=5448a1cd70ad945cb4d36365defbaf3731eba38e23859f3dc8bd7418e1946acc; spirehash=ca1a4d1155317bdd2afc7f36663828a10410c7c840e54725b90b4064b0a301c7; sensorhash=d7acd710676812e29edfacb8b86b6c8ab2dda1c7ffe8431cb957fb4d275b922a ;;
  aarch64) arch=arm64; nixarch=aarch64; nixhash=a1b35e56da5adadbc117c3cf17b83948ac657f3c0bd79d47bbe0aa70832b5c8e; spirehash=a9982b3ca7de489def22265fd4586d8e13091ecb6fddf6adcea9291313b18886; sensorhash=fea618ff252ff247fd8a23cc7cc95b8d3c6c8a959ab52b3c7d09efb382d6cf57 ;;
  *) echo 'Supported architectures: x86_64, aarch64' >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$1" -o "$2"; }
verify() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }
nix=/nix/var/nix/profiles/default/bin/nix
if [[ ! -x $nix ]]; then
  fetch "https://github.com/NixOS/nix-installer/releases/download/2.35.2/nix-installer-$nixarch-linux" "$tmp/nix-installer"
  verify "$nixhash" "$tmp/nix-installer"
  chmod 700 "$tmp/nix-installer"
  "$tmp/nix-installer" install --no-confirm
fi
nixpkgs=github:NixOS/nixpkgs/643809054d65fdd466a63e3155b8c498cb483c04
nixflags=(--extra-experimental-features 'nix-command flakes')
echo 'Verifying the AgentZ release…'
archive=agentz_${version#v}_linux_${arch}.tar.gz
release=https://github.com/accuknox/agentz/releases/download/$version
fetch "$release/$archive" "$tmp/$archive"
fetch "$release/native.sigstore.jsonl" "$tmp/native.sigstore.jsonl"
"$nix" "${nixflags[@]}" run "$nixpkgs#gh" -- attestation verify "$tmp/$archive" --bundle "$tmp/native.sigstore.jsonl" --repo accuknox/agentz --signer-workflow accuknox/agentz/.github/workflows/ci.yaml --source-ref "refs/tags/$version" --deny-self-hosted-runners
mkdir "$tmp/release"
tar -xzf "$tmp/$archive" -C "$tmp/release" --no-same-owner
revision=$(cat "$tmp/release/native/source-revision")
[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release source revision' >&2; exit 1; }
echo 'Installing the managed native runtime…'
install -d -m 755 /usr/local/lib/agentz /var/lib/agentz/runtime
install -d -m 700 /etc/agentz /var/lib/agentz/spire /var/lib/agentz/daemon /var/lib/agentz/sensor-tls
"$nix" "${nixflags[@]}" build "github:accuknox/agentz/$revision#opencodeNativeRuntime" --out-link /var/lib/agentz/runtime/opencode
"$nix" "${nixflags[@]}" build --impure --expr "let p = builtins.getFlake \"$nixpkgs\"; pkgs = p.legacyPackages.\${builtins.currentSystem}; in pkgs.buildEnv { name = \"agentz-host-tools\"; paths = [ pkgs.iproute2 pkgs.nftables pkgs.procps pkgs.openssl pkgs.coreutils pkgs.bash pkgs.systemd ]; }" --out-link /var/lib/agentz/runtime/tools
export PATH=/var/lib/agentz/runtime/tools/bin:$PATH
fetch 'https://github.com/spiffe/spire/releases/download/v1.15.3/spire-1.15.3-linux-'"$arch"'-musl.tar.gz' "$tmp/spire.tar.gz"
verify "$spirehash" "$tmp/spire.tar.gz"
tar -xzf "$tmp/spire.tar.gz" -C "$tmp" --no-same-owner
install -m 755 "$tmp/spire-1.15.3/bin/spire-agent" /usr/local/lib/agentz/spire-agent
fetch "https://github.com/kubearmor/KubeArmor/releases/download/v1.7.5/kubearmor_1.7.5_linux-$arch.tar.gz" "$tmp/sensor.tar.gz"
verify "$sensorhash" "$tmp/sensor.tar.gz"
mkdir "$tmp/sensor"
tar -xzf "$tmp/sensor.tar.gz" -C "$tmp/sensor" --no-same-owner
install -d -m 755 /opt/kubearmor
cp -a "$tmp/sensor/opt/kubearmor/." /opt/kubearmor/
chown -R root:root /opt/kubearmor
# Stable actual executable path is part of SPIRE's unix workload attestation.
install -m 755 "$tmp/release/agentz" /usr/local/lib/agentz/agentz.new
mv -f /usr/local/lib/agentz/agentz.new /usr/local/lib/agentz/agentz
install -m 755 "$tmp/release/native/nix-packages.sh" /usr/local/lib/agentz/nix-packages.sh
install -m 644 "$tmp/release/native/"*.service /etc/systemd/system/
install -m 600 "$tmp/release/native/kubearmor.yaml" /opt/kubearmor/kubearmor.yaml
install -m 600 "$tmp/release/native/sensor.nft" /etc/agentz/sensor.nft
if [[ ! -f /var/lib/agentz/sensor-tls/ca.crt ]]; then
  cd /var/lib/agentz/sensor-tls
  # Stock KubeArmor's self provider requires an RSA PKCS#1 CA key.
  openssl genrsa -traditional -out ca.key 3072
  openssl req -x509 -new -key ca.key -days 3650 -subj /CN=AgentZ-local-sensor -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign -out ca.crt
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=agentz-sensor-client -keyout client.key -out client.csr
  printf 'extendedKeyUsage=clientAuth\n' > client.ext
  openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile client.ext -out client.crt
  rm client.csr client.ext
  cd /
fi
if [[ -e /sys/fs/selinux/enforce ]]; then
  command -v restorecon >/dev/null
  restorecon -R /usr/local/lib/agentz /etc/agentz /var/lib/agentz /opt/kubearmor /etc/systemd/system/agentz-*.service
fi
systemctl daemon-reload
systemctl enable --now agentz-sensor-firewall.service agentz-kubearmor.service
if [[ ! -f /etc/agentz/daemon.json ]]; then
  /usr/local/lib/agentz/agentz daemon enroll --backend "$backend" --user "$username" --workdir "$workdir" --runtime /var/lib/agentz/runtime/opencode --config-home "$config_home" --data-home "$data_home" --state-home "$state_home" --cache-home "$cache_home"
fi
systemctl try-restart agentz-spire.service agentz-daemon.service
systemctl enable --now agentz-spire.service agentz-daemon.service
echo 'AgentZ is installed. Check status with: sudo /usr/local/lib/agentz/agentz daemon status'
