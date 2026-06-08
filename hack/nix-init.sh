#!/usr/bin/env bash

set -euo pipefail

readonly nixpkgs_ref='github:NixOS/nixpkgs/549bd84d6279f9852cae6225e372cc67fb91a4c1'
readonly nixpkgs_path_file='/etc/clawarmor/nixpkgs.path'
readonly agent_root="${CLAWARMOR_NIX_ROOT:-/mnt/nix}"
readonly agent_store_root="${agent_root}/nix"
readonly agent_profile_link="${agent_root}/profile"
readonly agent_cache_key_file="${agent_root}/.clawarmor-env-key"
readonly link_root='/tmp/nix-link'
readonly runtime_store='/runtime-nix-store'
readonly cache_schema='clawarmor-nix-init-v2-bin-only'
readonly shared_cache_root='/nix-shared/.clawarmor-nix-init'
readonly shared_cache_meta_dir='/nix-shared/.clawarmor-nix-init/envs'
readonly shared_cache_lock_dir='/nix-shared/.clawarmor-nix-init/locks'
readonly shared_cache_uri='file:///nix-shared?compression=none'
readonly shared_cache_substituter='file:///nix-shared?compression=none&priority=100'
readonly mode="${1:-prepare-agent-store}"

shared_lock_path=''

declare -a packages=()

trim() {
    local value

    value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    printf '%s\n' "$value"
}

parse_packages() {
    local item
    local trimmed

    if [[ -z "${NIX_PACKAGES:-}" ]]; then
        return 1
    fi

    while IFS= read -r item; do
        trimmed="$(trim "$item")"
        if [[ -z "$trimmed" ]]; then
            continue
        fi
        packages+=("$trimmed")
    done < <(printf '%s\n' "$NIX_PACKAGES" | tr ',' '\n')

    if [[ "${#packages[@]}" -eq 0 ]]; then
        echo "NIX_PACKAGES must contain at least one package"
        exit 1
    fi

    mapfile -t packages < <(
        printf '%s\n' "${packages[@]}" | LC_ALL=C sort -u
    )

    return 0
}

configure_nix() {
    if [[ -z "${NIX_SHARED_PVC:-}" ]]; then
        return
    fi

    export NIX_CONF_DIR='/tmp/nix-etc'
    mkdir -p "$NIX_CONF_DIR"

    {
        echo 'build-users-group ='
        echo 'experimental-features = nix-command flakes'
        echo 'sandbox = false'
        echo "substituters = ${shared_cache_substituter} https://cache.nixos.org?priority=50"
    } >"$NIX_CONF_DIR/nix.conf"
}

read_nixpkgs_path() {
    if [[ -f "$nixpkgs_path_file" ]]; then
        cat "$nixpkgs_path_file"
        return
    fi

    printf '%s\n' ''
}

build_cache_key() {
    local nixpkgs_path

    nixpkgs_path="$1"

    {
        printf '%s\n' "$cache_schema"
        printf '%s\n' "$nixpkgs_ref"
        printf '%s\n' "$nixpkgs_path"
        printf '%s\n' "${packages[@]}"
    } | sha256sum | awk '{print $1}'
}

write_env_expr() {
    local expr_path
    local nixpkgs_path
    local pkg

    expr_path="$1"
    nixpkgs_path="$2"

    {
        echo 'let'
        if [[ -n "$nixpkgs_path" ]]; then
            printf '  pkgs = import %s { };\n' "$nixpkgs_path"
        else
            printf \
                '  pkgs = (builtins.getFlake "%s").legacyPackages.${builtins.currentSystem};\n' \
                "$nixpkgs_ref"
        fi
        echo '  pkgNames = ['
        for pkg in "${packages[@]}"; do
            printf '    "%s"\n' "$pkg"
        done
        echo '  ];'
        echo '  missing = builtins.filter (name: !(builtins.hasAttr name pkgs)) pkgNames;'
        echo 'in'
        echo '  if missing != [ ] then'
        echo '    builtins.throw ('
        echo '      "unknown nix packages: "'
        echo '      + builtins.concatStringsSep ", " missing'
        echo '    )'
        echo '  else'
        echo '    pkgs.buildEnv {'
        echo '      name = "clawarmor-env";'
        echo '      paths = builtins.map (name: builtins.getAttr name pkgs) pkgNames;'
        echo '      pathsToLink = [ "/bin" ];'
        echo '      derivationArgs = {'
        echo '        allowSubstitutes = false;'
        echo '        preferLocalBuild = true;'
        echo '      };'
        echo '    }'
    } >"$expr_path"
}

reuse_agent_env() {
    local cache_key
    local expected_env_path
    local current_profile_target

    cache_key="$1"
    expected_env_path="$2"

    if [[ ! -f "$agent_cache_key_file" ]]; then
        return 1
    fi
    if [[ ! -L "$agent_profile_link" ]]; then
        return 1
    fi
    if [[ ! -d "$agent_store_root/store" ]]; then
        return 1
    fi
    if [[ "$(cat "$agent_cache_key_file")" != "$cache_key" ]]; then
        return 1
    fi
    current_profile_target="$(readlink "$agent_profile_link")"
    if [[ "$current_profile_target" != "$expected_env_path" ]]; then
        return 1
    fi

    return 0
}

reset_agent_store() {
    mkdir -p "$agent_root"
    rm -rf "$agent_store_root" "$agent_profile_link" "$agent_cache_key_file"
}

copy_env_to_agent_store() {
    local env_path

    env_path="$1"

    nix copy --to "$agent_root" --no-check-sigs "$env_path"
    ln -sfn "$env_path" "$agent_profile_link"
}

copy_env_from_shared_cache() {
    local env_path

    env_path="$1"

    nix copy \
        --from "$shared_cache_uri" \
        --to "$agent_root" \
        --no-check-sigs \
        "$env_path"

    ln -sfn "$env_path" "$agent_profile_link"
}

trim_agent_store_state() {
    # The running agent only needs the exact store closure and profile link.
    # Drop Nix bookkeeping to keep the mounted PVC smaller and less discoverable.
    rm -rf "$agent_root/nix/var"
}

link_runtime_store() {
    local path

    mkdir -p "$runtime_store"

    # The agent only mounts the exact closure copied into its PVC.
    # We expose that closure under /nix/store by linking those paths
    # into the emptyDir store prepared by the init containers.
    shopt -s nullglob
    for path in "$agent_store_root"/store/*; do
        ln -sfn "$path" "$runtime_store/$(basename "$path")"
    done
    shopt -u nullglob
}

ensure_shared_cache_dirs() {
    mkdir -p \
        "$shared_cache_root" \
        "$shared_cache_meta_dir" \
        "$shared_cache_lock_dir"
}

shared_env_meta_file() {
    local cache_key

    cache_key="$1"
    printf '%s/%s\n' "$shared_cache_meta_dir" "$cache_key"
}

acquire_shared_lock() {
    local cache_key
    local meta_file

    cache_key="$1"
    meta_file="$(shared_env_meta_file "$cache_key")"
    shared_lock_path="${shared_cache_lock_dir}/${cache_key}.lock"

    while ! mkdir "$shared_lock_path" 2>/dev/null; do
        if [[ -f "$meta_file" ]]; then
            return 1
        fi
        sleep 0.2
    done

    trap 'rm -rf "$shared_lock_path"' EXIT
    return 0
}

persist_agent_cache_key() {
    local cache_key

    cache_key="$1"
    printf '%s\n' "$cache_key" >"$agent_cache_key_file"
}

persist_shared_env() {
    local cache_key
    local env_path
    local meta_file
    local tmp_file

    cache_key="$1"
    env_path="$2"
    meta_file="$(shared_env_meta_file "$cache_key")"
    tmp_file="${meta_file}.tmp.$$"

    nix copy --to "$shared_cache_uri" --no-check-sigs "$env_path"

    printf '%s\n' "$env_path" >"$tmp_file"
    mv "$tmp_file" "$meta_file"
}

build_env_path() {
    local expr_path
    local nixpkgs_path
    local env_path

    expr_path='/tmp/clawarmor-env.nix'
    nixpkgs_path="$(read_nixpkgs_path)"

    write_env_expr "$expr_path" "$nixpkgs_path"
    env_path="$(nix build --impure --no-link --print-out-paths --file "$expr_path")"
    printf '%s\n' "$env_path"
}

eval_env_path() {
    local expr_path
    local nixpkgs_path
    local env_path

    expr_path='/tmp/clawarmor-env.nix'
    nixpkgs_path="$(read_nixpkgs_path)"

    write_env_expr "$expr_path" "$nixpkgs_path"
    env_path="$(nix eval --impure --raw --expr "(import \"$expr_path\").outPath")"
    printf '%s\n' "$env_path"
}

restore_from_shared_cache_if_present() {
    local cache_key
    local expected_env_path
    local meta_file
    local env_path

    cache_key="$1"
    expected_env_path="$2"
    meta_file="$(shared_env_meta_file "$cache_key")"

    if [[ ! -f "$meta_file" ]]; then
        return 1
    fi

    env_path="$(cat "$meta_file")"
    if [[ "$env_path" != "$expected_env_path" ]]; then
        rm -f "$meta_file"
        return 1
    fi
    reset_agent_store
    if ! copy_env_from_shared_cache "$env_path"; then
        rm -f "$meta_file"
        return 1
    fi
    trim_agent_store_state
    persist_agent_cache_key "$cache_key"
    return 0
}

prepare_agent_store() {
    local cache_key
    local env_path
    local expected_env_path
    local nixpkgs_path

    configure_nix
    if ! parse_packages; then
        reset_agent_store
        return
    fi

    nixpkgs_path="$(read_nixpkgs_path)"
    cache_key="$(build_cache_key "$nixpkgs_path")"
    expected_env_path="$(eval_env_path)"

    if reuse_agent_env "$cache_key" "$expected_env_path"; then
        return
    fi

    if [[ -n "${NIX_SHARED_PVC:-}" ]]; then
        ensure_shared_cache_dirs

        if restore_from_shared_cache_if_present \
            "$cache_key" \
            "$expected_env_path"; then
            return
        fi

        if ! acquire_shared_lock "$cache_key"; then
            restore_from_shared_cache_if_present \
                "$cache_key" \
                "$expected_env_path"
            return
        fi
    fi

    env_path="$(build_env_path)"

    reset_agent_store
    copy_env_to_agent_store "$env_path"
    trim_agent_store_state
    persist_agent_cache_key "$cache_key"

    if [[ -n "${NIX_SHARED_PVC:-}" ]]; then
        persist_shared_env "$cache_key" "$env_path"
    fi
}

prepare_home() {
    mkdir -p /pvc/home /pvc/nix
}

stage_runtime() {
    local profile_target

    mkdir -p "$link_root"
    if [[ ! -d "$agent_store_root/store" ]]; then
        echo "agent store is not prepared"
        exit 1
    fi
    if [[ ! -L "$agent_profile_link" ]]; then
        echo "agent profile link is not prepared"
        exit 1
    fi

    profile_target="$(readlink "$agent_profile_link")"
    if [[ -z "$profile_target" ]]; then
        echo "agent profile link target is empty"
        exit 1
    fi

    ln -sfn "$agent_store_root/store" "$link_root/store"
    ln -sfn "$profile_target" "$link_root/profile"
    link_runtime_store
}

main() {
    case "$mode" in
        prepare-agent-store)
            prepare_agent_store
            ;;
        prepare-home)
            prepare_home
            ;;
        stage-runtime)
            stage_runtime
            ;;
        *)
            echo "unknown mode: $mode"
            exit 1
            ;;
    esac
}

main
