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
        in
        {
          formatter = pkgs.nixpkgs-fmt;
          packages.agentImage = pkgs.dockerTools.buildLayeredImage {
            name = "murtazau/clawarmor-agent";
            tag = "latest";
            contents = with pkgs; [
              bashInteractive
              coreutils
              cacert
              opencode
              dockerTools.binSh
            ];
            fakeRootCommands = ''
              ${pkgs.dockerTools.shadowSetup}

              groupadd -g 1000 opencode
              useradd \
                -u 1000 \
                -g 1000 \
                -d /home/opencode \
                -s ${pkgs.bashInteractive}/bin/bash \
                opencode

              mkdir -p /home/opencode
              chown -R 1000:1000 /home/opencode
            '';
            enableFakechroot = true;
            config = {
              User = "1000:1000";
              WorkingDir = "/home/opencode";
              Env = [
                "HOME=/home/opencode"
                "USER=opencode"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
              Entrypoint = [ "${pkgs.opencode}/bin/opencode" ];
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
