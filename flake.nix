{
  description = "The AI that actually does things - SECURELY.";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs { inherit system; };
          opencodePluginOtel = pkgs.callPackage ./opencode/plugin-otel/default.nix { };
          opencodeConfigNodeModules = pkgs.stdenvNoCC.mkDerivation {
            pname = "clawarmor-opencode-config-node_modules";
            version = "1.0.0";
            src = ./opencode/config;

            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;

            buildPhase = ''
              runHook preBuild

              export HOME="$TMPDIR"
              export BUN_INSTALL_CACHE_DIR="$(mktemp -d)"
              bun install --frozen-lockfile --ignore-scripts

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -R node_modules "$out/"
              runHook postInstall
            '';

            dontFixup = true;
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-/KdCoXAT5lQDY0fcf/b9aQVzWsZUj9/HEOiOQXKTkv8=";
          };
          opencodeXdgConfigRoot = pkgs.runCommand "clawarmor-xdg-config" { } ''
            mkdir -p "$out/opencode/plugins/opencode-plugin-otel"
            cp -R ${opencodePluginOtel}/. "$out/opencode/plugins/opencode-plugin-otel/"
            mkdir -p "$out/opencode/tools" "$out/opencode/lib"
            cp -R ${opencodeConfigNodeModules}/node_modules "$out/opencode/"
            cp -R ${./opencode/config/lib}/. "$out/opencode/lib/"
            cp ${./opencode/config/bun.lock} "$out/opencode/bun.lock"
            cp ${./opencode/config/package.json} "$out/opencode/package.json"
            cp ${./opencode/config/openapi-ts.config.mjs} "$out/opencode/openapi-ts.config.mjs"
            cp ${./opencode/config/tsconfig.json} "$out/opencode/tsconfig.json"
            cp ${./opencode/config/tools/get_workflow.ts} "$out/opencode/tools/get_workflow.ts"
            cp ${./opencode/config/tools/create_workflow.ts} "$out/opencode/tools/create_workflow.ts"
            cp ${./opencode/config/tools/list_workflows.ts} "$out/opencode/tools/list_workflows.ts"
            cp ${./opencode/config/tools/delete_workflows.ts} "$out/opencode/tools/delete_workflows.ts"
            cp ${./opencode/config/tools/set_workflowrun_status.ts} "$out/opencode/tools/set_workflowrun_status.ts"
            cp ${./opencode/config/plugins/workflow-context.ts} "$out/opencode/plugins/workflow-context.ts"

            cat > "$out/opencode/opencode.json" <<'EOF'
            {
              "$schema": "https://opencode.ai/config.json",
              "plugin": ["./plugins/opencode-plugin-otel"],
              "tools": {
                "create_workflow": true,
                "list_workflows": true,
                "get_workflow": true,
                "delete_workflows": true,
                "set_workflowrun_status": false
              }
            }
            EOF
          '';
        in
        {
          formatter = pkgs.nixpkgs-fmt;
          packages = rec {
            inherit opencodePluginOtel;
            opencodeConfigDir = pkgs.runCommand "clawarmor-opencode-config-dir" { } ''
              mkdir -p "$out"
              cp -R ${opencodeXdgConfigRoot}/opencode/. "$out/"
            '';
            opencodeAgentRuntime = pkgs.buildEnv {
              name = "clawarmor-opencode-runtime";
              paths = [
                (pkgs.writeShellScriptBin "opencode" ''
                  if [ -z "''${XDG_CONFIG_HOME:-}" ]; then
                    export XDG_CONFIG_HOME="${opencodeXdgConfigRoot}"
                  fi
                  export OPENCODE_DISABLE_PROJECT_CONFIG=1
                  export OPENCODE_DISABLE_MODELS_FETCH=1
                  export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}"
                  exec ${pkgs.opencode}/bin/opencode "$@"
                '')
                pkgs.bashInteractive
                pkgs.cacert
                pkgs.coreutils
                pkgs.stdenv.cc.cc.lib
              ];
              pathsToLink = [
                "/bin"
                "/etc"
              ];
            };
            agentImage = pkgs.dockerTools.buildLayeredImage {
              name = "murtazau/clawarmor-agent";
              tag = "latest";
              contents = [
                (pkgs.buildEnv {
                  name = "clawarmor-agent-root";
                  paths = [ opencodeAgentRuntime ];
                  pathsToLink = [
                    "/bin"
                    "/etc"
                  ];
                })
              ];
              fakeRootCommands = ''
                ${pkgs.dockerTools.shadowSetup}

                groupadd -g 1000 clawarmor
                useradd \
                  -u 1000 \
                  -g 1000 \
                  -d /home/clawarmor \
                  -s ${pkgs.bashInteractive}/bin/bash \
                  clawarmor

                mkdir -p /home/clawarmor /tmp
                chown -R 1000:1000 /home/clawarmor
                chmod 1777 /tmp
              '';
              enableFakechroot = true;
              config = {
                User = "1000:1000";
                WorkingDir = "/home/clawarmor";
                Env = [
                  "HOME=/home/clawarmor"
                  "USER=clawarmor"
                  "PATH=/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                ];
                Entrypoint = [ "opencode" ];
              };
            };
          };
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nixd
              nixpkgs-fmt
              go
              go-tools
              gotools
              gofumpt
              gopls
              goreleaser
              golangci-lint
              grpcurl
              sqlc
              postgresql_18
              openapi-generator-cli
              oapi-codegen
              bun
              nodejs
              package-version-server
              kubebuilder
              kubernetes-controller-tools
              kustomize
              kind
              yamlfmt
              yamllint
              yaml-language-server
              setup-envtest
            ];
          };
        });
}
