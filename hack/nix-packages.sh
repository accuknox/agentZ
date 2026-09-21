#!/usr/bin/env bash
# shellcheck disable=SC2016 # The generated Nix expressions use literal ${...}.
# Shared sandbox package semantics for Kubernetes staging and native hosts.
readonly nixpkgs_ref='github:NixOS/nixpkgs/643809054d65fdd466a63e3155b8c498cb483c04'
declare -a packages=()

parse_packages() {
    local item
    local trimmed

    if [[ -z "${NIX_PACKAGES:-}" ]]; then
        return 1
    fi

    while IFS= read -r item; do
        trimmed="${item#"${item%%[![:space:]]*}"}"
        trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
        if [[ -z "$trimmed" ]]; then
            continue
        fi
        if [[ ! "$trimmed" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_+.-]*$ ]]; then
            echo "invalid Nix package attribute: $trimmed" >&2
            exit 2
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

write_pkg_import() {
    local nixpkgs_path
    local allow_broken

    nixpkgs_path="$1"
    allow_broken="$2"

    if [[ -n "$nixpkgs_path" ]]; then
        printf '  pkgs = import %s {\n' "$nixpkgs_path"
    else
        printf '  pkgs = import (builtins.getFlake "%s") {\n' "$nixpkgs_ref"
        echo '    system = builtins.currentSystem;'
    fi
    echo '    config = {'
    echo '      allowUnfree = true;'
    printf '      allowBroken = %s;\n' "$allow_broken"
    echo '    };'
    echo '  };'
}

write_env_expr() {
    local expr_path
    local nixpkgs_path
    local pkg

    expr_path="$1"
    nixpkgs_path="$2"

    {
        echo 'let'
        write_pkg_import "$nixpkgs_path" false
        echo '  lib = pkgs.lib;'
        echo '  pkgNames = ['
        for pkg in "${packages[@]}"; do
            printf '    "%s"\n' "$pkg"
        done
        echo '  ];'
        echo '  pkgAttrPath = name: lib.splitString "." name;'
        echo '  hasPkg = name: lib.hasAttrByPath (pkgAttrPath name) pkgs;'
        echo '  getPkg = name: lib.getAttrFromPath (pkgAttrPath name) pkgs;'
        echo '  pathPrefixes = path:'
        echo '    lib.genList'
        echo '      (n: lib.take (lib.length path - 1 - n) path)'
        echo '      (lib.length path - 1);'
        echo '  resolveInstallSpec = name:'
        echo '    let'
        echo '      path = pkgAttrPath name;'
        echo '      pkg = getPkg name;'
        echo '      matchPrefix = prefix:'
        echo '        let'
        echo '          rel = lib.drop (lib.length prefix) path;'
        echo '          attrs = builtins.attrNames pkg;'
        echo '          matches = builtins.filter'
        echo '            (attr:'
        echo '              let'
        echo '                runtime = pkg.${attr};'
        echo '                relPkg ='
        echo '                  if builtins.isAttrs runtime'
        echo '                    && (runtime ? withPackages)'
        echo '                    && (runtime ? pkgs)'
        echo '                  then'
        echo '                    builtins.tryEval'
        echo '                      (lib.getAttrFromPath rel runtime.pkgs)'
        echo '                  else'
        echo '                    { success = false; value = null; };'
        echo '              in'
        echo '                rel != [ ]'
        echo '                && builtins.isAttrs runtime'
        echo '                && (runtime ? withPackages)'
        echo '                && (runtime ? pkgs)'
        echo '                && relPkg.success'
        echo '                && relPkg.value.outPath == pkg.outPath)'
        echo '            attrs;'
        echo '        in'
        echo '          if matches == [ ] then'
        echo '            null'
        echo '          else'
        echo '            {'
        echo '              runtime = pkg.${builtins.head matches};'
        echo '              relativePath = rel;'
        echo '            };'
        echo '      runtimeMatch ='
        echo '        lib.findFirst'
        echo '          (x: x != null)'
        echo '          null'
        echo '          (builtins.map matchPrefix (pathPrefixes path));'
        echo '    in'
        echo '      if runtimeMatch == null then'
        echo '        {'
        echo '          inherit name;'
        echo '          type = "plain";'
        echo '          drv = pkg;'
        echo '        }'
        echo '      else'
        echo '        {'
        echo '          inherit name;'
        echo '          type = "runtime";'
        echo '          drv = pkg;'
        echo '          runtime = runtimeMatch.runtime;'
        echo '          relativePath = runtimeMatch.relativePath;'
        echo '        };'
        echo '  missing = builtins.filter (name: !(hasPkg name)) pkgNames;'
        echo '  invalid = builtins.filter'
        echo '    (name: hasPkg name && !(lib.isDerivation (getPkg name)))'
        echo '    pkgNames;'
        echo '  specs = builtins.map resolveInstallSpec pkgNames;'
        echo '  plainSpecs = builtins.filter (spec: spec.type == "plain") specs;'
        echo '  runtimeSpecs = builtins.filter (spec: spec.type == "runtime") specs;'
        echo '  runtimeGroups = lib.foldl'''
        echo '    (acc: spec:'
        echo '      let'
        echo '        key = builtins.unsafeDiscardStringContext spec.runtime.outPath;'
        echo '        current ='
        echo '          acc.${key} or {'
        echo '            runtime = spec.runtime;'
        echo '            modules = [ ];'
        echo '            name = spec.name;'
        echo '          };'
        echo '      in'
        echo '        acc'
        echo '        // {'
        echo '          ${key} = current // {'
        echo '            modules = current.modules ++ [ spec.relativePath ];'
        echo '          };'
        echo '        })'
        echo '    { }'
        echo '    runtimeSpecs;'
        echo '  runtimePaths = builtins.map'
        echo '    (group:'
        echo '      {'
        echo '        inherit (group) name;'
        echo '        kindPriority = 0;'
        echo '        path = group.runtime.withPackages'
        echo '          (ps: builtins.map (path: lib.getAttrFromPath path ps) group.modules);'
        echo '      })'
        echo '    (builtins.attrValues runtimeGroups);'
        echo '  runtimeOutPaths = builtins.attrNames runtimeGroups;'
        echo '  plainPaths = builtins.map'
        echo '    (spec: {'
        echo '      inherit (spec) name;'
        echo '      kindPriority = 1;'
        echo '      path = spec.drv;'
        echo '    })'
        echo '    (builtins.filter'
        echo '      (spec:'
        echo '        !(builtins.elem'
        echo '          (builtins.unsafeDiscardStringContext spec.drv.outPath)'
        echo '          runtimeOutPaths))'
        echo '      plainSpecs);'
        # buildEnv only resolves collisions between unequal priorities. Keep
        # nixpkgs precedence, prefer a composed runtime on a tie, then use the
        # canonical package name so every final path has a stable winner.
        echo '  orderedPaths = builtins.sort'
        echo '    (a: b:'
        echo '      if a.priority == b.priority then'
        echo '        if a.kindPriority == b.kindPriority then'
        echo '          a.name < b.name'
        echo '        else'
        echo '          a.kindPriority < b.kindPriority'
        echo '      else'
        echo '        a.priority < b.priority)'
        echo '    (builtins.map'
        echo '      (item:'
        echo '        item'
        echo '        // {'
        echo '          priority ='
        echo '            item.path.meta.priority or lib.meta.defaultPriority;'
        echo '        })'
        echo '      (runtimePaths ++ plainPaths));'
        # Negative ranks keep explicit selections ahead of buildEnv's
        # propagated paths, which start at priority 1000.
        echo '  prioritizedPaths = lib.imap0'
        echo '    (index: item:'
        echo '      lib.setPrio (index - builtins.length orderedPaths) item.path)'
        echo '    orderedPaths;'
        echo 'in'
        echo '  if missing != [ ] then'
        echo '    builtins.throw ('
        echo '      "unknown nix packages: "'
        echo '      + builtins.concatStringsSep ", " missing'
        echo '    )'
        echo '  else if invalid != [ ] then'
        echo '    builtins.throw ('
        echo '      "not installable nix packages: "'
        echo '      + builtins.concatStringsSep ", " invalid'
        echo '    )'
        echo '  else'
        echo '    pkgs.buildEnv {'
        echo '      name = "agentz-env";'
        echo '      paths = prioritizedPaths;'
        echo '      pathsToLink = [ "/" ];'
        # Priority cannot resolve every file-versus-directory collision. The
        # paths are already sorted by precedence, so keep the earlier shape.
        echo '      ignoreCollisions = true;'
        echo '      derivationArgs = {'
        echo '        allowSubstitutes = false;'
        echo '        preferLocalBuild = true;'
        echo '      };'
        echo '    }'
    } >"$expr_path"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    set -euo pipefail
    umask 077
    if [[ $# -ne 2 || "$1" != build || "$2" != /* ]]; then
        echo "usage: NIX_PACKAGES=... nix-packages.sh build /absolute/profile" >&2
        exit 2
    fi
    if [[ -n "${NIX_PACKAGES:-}" ]]; then
        parse_packages
    fi
    expression=$(mktemp)
    trap 'rm -f "$expression"' EXIT
    write_env_expr "$expression" ""
    nix --extra-experimental-features 'nix-command flakes' build \
        --impure --file "$expression" --out-link "$2" --print-out-paths
fi
