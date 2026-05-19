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
          opencodePluginOtel = pkgs.callPackage ./hack/opencode-plugin-otel/default.nix { };
          opencodeXdgConfigRoot = pkgs.runCommand "clawarmor-xdg-config" { } ''
            mkdir -p "$out/opencode/plugins/opencode-plugin-otel"
            cp -R ${opencodePluginOtel}/. \
              "$out/opencode/plugins/opencode-plugin-otel/"

            cat > "$out/opencode/opencode.json" <<'EOF'
            {
              "$schema": "https://opencode.ai/config.json",
              "plugin": ["./plugins/opencode-plugin-otel"]
            }
            EOF
          '';
        in
        {
          formatter = pkgs.nixpkgs-fmt;
          packages = rec {
            inherit opencodePluginOtel;
            opencodeConfigDir = "${opencodeXdgConfigRoot}/opencode";
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
