{
  description = "Zero-trust agentic AI platform. Secure by design.";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-opencode-v1.url = "github:NixOS/nixpkgs/7fd4004d0511991fff3a0524856a9be09e28c5f0"; # pin OpenCode to v1.19.0 until we upgrade to v2
    nixpkgs-oapi-codegen.url = "github:NixOS/nixpkgs/e7a3ca8092b61ff85b6a45bf863ea2b2d6a661b3";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { nixpkgs, nixpkgs-opencode-v1, nixpkgs-oapi-codegen, flake-utils, ... }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ]
      (system:
        let
          pkgs = import nixpkgs { inherit system; };
          # Shared by Make and the development shell; versions come from flake.lock.
          generators = {
            controller-gen = pkgs.kubernetes-controller-tools;
            oapi-codegen = nixpkgs-oapi-codegen.legacyPackages.${system}.oapi-codegen;
            sqlc = pkgs.sqlc;
            yamlfmt = pkgs.yamlfmt;
          };
          otel = pkgs.callPackage ./opencode/plugin-otel/default.nix { };
          agentgateway = pkgs.callPackage ./hack/agentgateway/default.nix { };
          opencode = nixpkgs-opencode-v1.legacyPackages.${system}.opencode.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ [ ./opencode/patches/guardrails.patch ];
          });
          cli = pkgs.buildGo127Module {
            pname = "agentz";
            version = "0.1.0";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./go.mod
                ./go.sum
                ./cmd
                ./internal
                ./pkg
              ];
            };
            subPackages = [ "cmd/agentz" ];
            ldflags = [ "-s" "-w" ];
            vendorHash = "sha256-vOq2ixTwShi2eqygObdFQujolm7kL0zedAaBF98XHlM=";
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
            # Optional native packages differ by platform; sharing a hash
            # would let an Arm build reuse x64 node_modules from the cache.
            outputHash = {
              x86_64-linux = "sha256-tF4ol4BZm8X+hVKZcgMMCYa4dvkozWlmaEo0BKedAIs=";
              aarch64-linux = "sha256-0lYrEDS9S8aFto1Wodu+fTP7tUeTo4eUc3t8ShkCK+4=";
            }.${system};
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
              "plugin": [
                "./plugins/opencode-plugin-otel",
                "./plugins/file-analysis.ts",
                "./plugins/sender-context.ts",
                "./plugins/script-tools.ts",
                "./plugins/browser.ts"
              ],
              "share": "disabled",
              "tools": {
                "create_workflow": true,
                "create_workflow_schedule": true,
                "list_workflows": true,
                "skill": true,
                "list_skills": true,
                "memory": false,
                "journal": false,
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
          apps = builtins.mapAttrs
            (name: package: {
              type = "app";
              program = "${package}/bin/${name}";
            })
            generators;
          packages = generators // rec {
            inherit agentgateway;
            agentgatewayImage = pkgs.dockerTools.buildLayeredImage {
              name = "public.ecr.aws/k9v9d5v2/agentz/agentgateway";
              tag = "latest";
              contents = [ agentgateway pkgs.cacert ];
              extraCommands = "mkdir -m 1777 tmp";
              config = {
                User = "65532";
                WorkingDir = "/";
                Entrypoint = [ "${agentgateway}/bin/agentgateway" ];
                Env = [
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "AGENTGATEWAY_ENV=container"
                ];
              };
            };
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
                  export OPENCODE_DISABLE_SHARE=1
                  export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}"
                  exec ${opencode}/bin/opencode "$@"
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
                (pkgs.writeTextDir "etc/profile" ''
                  case $- in *i*) ;; *) return ;; esac
                  [ -n "''${BASH_VERSION:-}" ] || return
                  [ "''${OPENCODE_TERMINAL:-}" = 1 ] || return
                  [ -z "''${NO_COLOR:-}" ] || return
                  case ''${TERM:-} in
                    xterm*|screen*|tmux*|rxvt*|linux) ;;
                    *) return ;;
                  esac

                  # Preserve custom prompts. User login files can override this.
                  # Readline must exclude escape sequences from prompt width.
                  case ''${PS1:-} in
                    ""|'\s-\v\$ ')
                      . ${pkgs.git}/share/git/contrib/completion/git-prompt.sh
                      PS1='\[\e[32m\]\u@\h\[\e[0m\]\[\e[34m\]$(__git_ps1 ":%s")\[\e[0m\]$ '
                      ;;
                  esac
                  if [ -z "''${LS_COLORS+x}" ]; then
                    eval "$(dircolors -b)"
                  fi
                  alias ls >/dev/null 2>&1 || alias ls='ls --color=auto'
                '')
                pkgs.cacert
                pkgs.stdenv.cc.cc.lib
                pkgs.bashInteractive
                pkgs.coreutils-full
                pkgs.git
                cli
              ];
              pathsToLink = [
                "/bin"
                "/etc"
                "/usr/bin"
              ];
            };
            agentImage = pkgs.dockerTools.buildLayeredImage {
              name = "public.ecr.aws/k9v9d5v2/agentz/agent";
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
            packages = builtins.attrValues generators ++ (with pkgs; [
              nixd
              nixpkgs-fmt
              go_1_27
              go-tools
              gotools
              gofumpt
              gopls
              goreleaser
              golangci-lint
              grpcurl
              postgresql_18
              bun
              python3
              nodejs
              package-version-server
              kubebuilder
              kustomize
              kind
              yamllint
              yaml-language-server
              helm-ls
              opencode
            ]);
          };
        });
}
