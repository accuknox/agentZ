#!/usr/bin/env bash

set -e

if [[ -z "${NIX_PACKAGES:-}" ]]; then
    echo "NIX_PACKAGES env var is required"
    exit 1
fi

if [[ -n "${NIX_SHARED_PVC:-}" ]]; then
    export NIX_CONF_DIR=/tmp/nix-etc
    mkdir -p /tmp/nix-etc
    {
        echo "experimental-features = nix-command flakes"
        echo "sandbox = false"
        echo "substituters = file:///nix-shared?priority=100 https://cache.nixos.org?priority=50"
    } | tee /tmp/nix-etc/nix.conf >/dev/null
fi

build_packages() {
    for pkg in $(echo "$NIX_PACKAGES" | tr ',' ' '); do
        printf "nixpkgs#%s " "$pkg"
    done
}

link_runtime_store() {
    local runtime_store

    runtime_store="${NIX_RUNTIME_STORE:-/runtime-nix-store}"

    mkdir -p "$runtime_store"

    # Package binaries and their ELF interpreters use absolute /nix/store paths.
    # The agent image's own store is seeded separately into the shared runtime
    # store volume, and we add symlinks for the package closures copied to the PVC.
    shopt -s nullglob
    for path in /mnt/nix/nix/store/*; do
        ln -sfn "$path" "$runtime_store/$(basename "$path")"
    done
    shopt -u nullglob
}

PACKAGES=$(build_packages)

nix profile add --profile /tmp/prof \
    --override-flake nixpkgs github:NixOS/nixpkgs/549bd84d6279f9852cae6225e372cc67fb91a4c1 \
    $PACKAGES

mkdir -p /mnt/nix
rm -rf /mnt/nix/nix /mnt/nix/profile 2>/dev/null || true
nix copy --to /mnt/nix --no-check-sigs $(nix path-info --recursive /tmp/prof)
nix profile add --profile /mnt/nix/profile \
    --override-flake nixpkgs github:NixOS/nixpkgs/549bd84d6279f9852cae6225e372cc67fb91a4c1 \
    $PACKAGES

if [[ -n "${NIX_SHARED_PVC:-}" ]]; then
    nix copy --to file:///nix-shared --no-check-sigs $(nix path-info --recursive /tmp/prof) 2>/dev/null || true
fi

ln -sf /mnt/nix/nix/store /tmp/nix-link/store
ln -sf /mnt/nix/profile /tmp/nix-link/profile
link_runtime_store
