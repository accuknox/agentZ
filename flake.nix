{
  description = "Control-plane for your AI agents";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs { inherit system; };
          otel = pkgs.callPackage ./opencode/plugin-otel/default.nix { };
          cli = pkgs.buildGoModule {
            pname = "agentz";
            version = "0.1.0";
            src = ./.;
            subPackages = [ "cmd/agentz" ];
            ldflags = [ "-s" "-w" ];
            vendorHash = "sha256-1TUXavHkFyctH6b1bzLWW6LfbyE22RYE6iSa/vv6pvI=";
          };
          nodeModules = pkgs.stdenvNoCC.mkDerivation {
            pname = "opencode-config-node_modules";
            version = "0.1.0";
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
            outputHash = "sha256-t7HL/r2Z/HmaCCsiZAI1G+jck0QZSfSnLE1ZLSeEtO8=";
          };
          cfg = pkgs.runCommand "opencode-config" { } ''
            mkdir -p \
              "$out/lib" \
              "$out/node_modules" \
              "$out/plugins/opencode-plugin-otel" \
              "$out/skills" \
              "$out/tools"

            cp -R ${otel}/. "$out/plugins/opencode-plugin-otel/"
            cp -R ${nodeModules}/node_modules/. "$out/node_modules/"
            cp -R ${./opencode/config/lib}/. "$out/lib/"
            cp -R ${./opencode/config/plugins}/. "$out/plugins/"
            cp -R ${./opencode/config/tools}/. "$out/tools/"
            cp -R ${./opencode/skills}/. "$out/skills/"
            cp ${./opencode/config/bun.lock} "$out/bun.lock"
            cp ${./opencode/config/package.json} "$out/package.json"
            cp ${./opencode/config/openapi-ts.config.mjs} "$out/openapi-ts.config.mjs"
            cp ${./opencode/config/tsconfig.json} "$out/tsconfig.json"

            cat > "$out/opencode.json" <<'EOF'
            {
              "$schema": "https://opencode.ai/config.json",
              "plugin": ["./plugins/opencode-plugin-otel"],
              "tools": {
                "create_workflow": true,
                "create_workflow_schedule": true,
                "list_workflows": true,
                "skill": true,
                "list_skills": true,
                "list_workflow_schedules": true,
                "get_workflow": true,
                "delete_workflows": true,
                "delete_workflow_schedule": true,
                "update_workflow_schedule": true,
                "set_workflowrun_status": false
              }
            }
            EOF
          '';
        in
        {
          formatter = pkgs.nixpkgs-fmt;
          packages = rec {
            opencodePluginOtel = otel;
            opencodeConfigDir = cfg;
            opencodeAgentRuntime = pkgs.buildEnv {
              name = "opencode-runtime";
              paths = [
                (pkgs.writeShellScriptBin "opencode" ''
                  if [ -z "''${XDG_CONFIG_HOME:-}" ]; then
                    export XDG_CONFIG_HOME="/etc"
                  fi
                  export OPENCODE_DISABLE_PROJECT_CONFIG=1
                  export OPENCODE_DISABLE_MODELS_FETCH=1
                  export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}"
                  exec ${pkgs.opencode}/bin/opencode "$@"
                '')
                (pkgs.runCommand "opencode-etc" { } ''
                  mkdir -p "$out/etc/opencode"
                  cp -R ${cfg}/. "$out/etc/opencode/"
                '')
                (pkgs.runCommand "opencode-shell-paths" { } ''
                  mkdir -p "$out/usr/bin"
                  ln -s /bin/env "$out/usr/bin/env"
                  ln -s /bin/bash "$out/usr/bin/bash"
                '')
                pkgs.cacert
                pkgs.stdenv.cc.cc.lib
                pkgs.bashInteractive
                pkgs.coreutils-full
                cli
              ];
              pathsToLink = [
                "/bin"
                "/etc"
                "/usr/bin"
              ];
            };
            agentImage = pkgs.dockerTools.buildLayeredImage {
              name = "murtazau/agentz-agent";
              tag = "latest";
              contents = [
                (pkgs.buildEnv {
                  name = "agent-root";
                  paths = [ opencodeAgentRuntime ];
                  pathsToLink = [
                    "/bin"
                    "/etc"
                    "/usr/bin"
                  ];
                })
              ];
              fakeRootCommands = ''
                ${pkgs.dockerTools.shadowSetup}

                groupadd -g 1000 agentz
                useradd \
                  -u 1000 \
                  -g 1000 \
                  -d /home/agentz \
                  -s ${pkgs.bashInteractive}/bin/bash \
                  agentz

                mkdir -p /home/agentz /tmp
                chown -R 1000:1000 /home/agentz
                chmod 1777 /tmp
              '';
              enableFakechroot = true;
              config = {
                User = "1000:1000";
                WorkingDir = "/home/agentz";
                Env = [
                  "HOME=/home/agentz"
                  "USER=agentz"
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
              helm-ls
              opencode
            ];
          };
        });
}
