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
              protobuf
              buf
              protoc-gen-lint
              protoc-gen-go
              protoc-gen-go-grpc
              bun
              nodejs
              kubebuilder
              kubernetes-controller-tools
              kustomize
              kind
            ];
          };
        });
}
