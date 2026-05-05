#!/bin/sh

set -e

if [ -z "${NIX_PACKAGES:-}" ]; then
    echo "NIX_PACKAGES env var is required"
    exit 1
fi

if [ -n "${NIX_SHARED_PVC:-}" ]; then
    export NIX_CONF_DIR=/tmp/nix-etc
    mkdir -p /tmp/nix-etc
    cat > /tmp/nix-etc/nix.conf <<'NIXEOF'
experimental-features = nix-command flakes
sandbox = false
substituters = file:///nix-shared?priority=100 https://cache.nixos.org?priority=50
NIXEOF
fi

build_packages() {
    for pkg in $(echo "$NIX_PACKAGES" | tr ',' ' '); do
        printf "nixpkgs#%s " "$pkg"
    done
}

PACKAGES=$(build_packages)

nix profile add --profile /tmp/prof $PACKAGES

mkdir -p /mnt/nix
rm -rf /mnt/nix/nix /mnt/nix/profile 2>/dev/null || true
nix copy --to /mnt/nix --no-check-sigs $(nix path-info --recursive /tmp/prof)
nix profile add --profile /mnt/nix/profile $PACKAGES

if [ -n "${NIX_SHARED_PVC:-}" ]; then
    nix copy --to file:///nix-shared --no-check-sigs $(nix path-info --recursive /tmp/prof) 2>/dev/null || true
fi

ln -sf /mnt/nix/nix/store /tmp/nix-link/store
ln -sf /mnt/nix/profile /tmp/nix-link/profile
