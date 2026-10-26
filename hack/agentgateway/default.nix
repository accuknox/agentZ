{ pkgs }:

let
  version = "1.6.0-agentz.4";
  revision = "ea5608642b9d5c94c5baf5fd9f2f9849b808e963";
  src = pkgs.fetchFromGitHub {
    owner = "agentgateway";
    repo = "agentgateway";
    rev = revision;
    hash = "sha256-rxRDONkTVFbav+cVO+aYtIzjcFu9JfnD/DTwumXgEYA=";
  };
  ui = pkgs.stdenvNoCC.mkDerivation {
    pname = "agentgateway-ui";
    inherit version src;
    pnpmRoot = "ui";
    pnpmDeps = pkgs.fetchPnpmDeps {
      pname = "agentgateway-ui";
      inherit version src;
      sourceRoot = "source/ui";
      pnpm = pkgs.pnpm_11;
      fetcherVersion = 4;
      hash = "sha256-g27D5XrehjTH/ThyPJiTjljvO5cjQ60NinFNDcleWjw=";
    };
    nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm_11 pkgs.pnpmConfigHook ];
    buildPhase = ''
      runHook preBuild
      pnpm --dir ui build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      cp -R ui/dist "$out"
      runHook postInstall
    '';
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "agentgateway";
  inherit version src;
  patches = [ ./telemetry.patch ./guardrails.patch ];
  cargoHash = "sha256-PCE/wyslj4UPHocBKNp24QaqeKIGXRig9KZovBqdcHo=";
  nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config pkgs.protobuf ];
  cargoBuildFlags = [ "-p" "agentgateway-app" "--bin" "agentgateway" ];
  buildFeatures = [ "ui" ];
  doCheck = false;
  postPatch = ''
    patchShebangs tools/report_build_info.sh
  '';
  preBuild = ''
    cp -R ${ui} ui/dist
  '';
  env = {
    VERSION = version;
    GIT_REVISION = "${revision}-agentz.4";
  } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isAarch64 {
    JEMALLOC_SYS_WITH_LG_PAGE = "16";
  };
}
