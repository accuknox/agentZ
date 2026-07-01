{ pkgs }:

let
  src = pkgs.fetchFromGitHub {
    owner = "DEVtheOPS";
    repo = "opencode-plugin-otel";
    rev = "a123a379ff574840c225a92a038c14f27db6ad31";
    hash = "sha256-NPhqHz3C5uU/JX5GDU7x5JX9pzEJl4hiumaqAf4rOHk=";
  };

  patchedSrc = pkgs.stdenvNoCC.mkDerivation {
    pname = "opencode-plugin-otel-src";
    version = "0.9.0-agentz";
    inherit src;

    patches = [ ./opencode-plugin-otel.patch ];
    phases = [ "unpackPhase" "patchPhase" "installPhase" ];

    installPhase = ''
      mkdir -p "$out"
      cp -R . "$out/"
    '';
  };

  nodeModules = pkgs.stdenvNoCC.mkDerivation {
    pname = "opencode-plugin-otel-node_modules";
    version = "0.9.0-agentz";
    src = patchedSrc;

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
    outputHash = "sha256-uSC1/bVCYkOdGADS8U/aKI2lZETErg8eh7E835qzlS4=";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "opencode-plugin-otel";
  version = "0.9.0-agentz";
  src = patchedSrc;

  nativeBuildInputs = [
    pkgs.bun
    pkgs.nodejs
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR"
    cp -R ${nodeModules}/node_modules ./node_modules
    bun build src/index.ts --outdir=./dist --target=node
    ${pkgs.nodejs}/bin/node ./node_modules/typescript/bin/tsc -p tsconfig.build.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/dist"
    cp -R dist/. "$out/dist/"
    cp -R node_modules "$out/node_modules"

    cat > "$out/package.json" <<'EOF'
    {
      "name": "@devtheops/opencode-plugin-otel",
      "type": "module",
      "main": "./dist/index.js",
      "oc-plugin": ["server"]
    }
    EOF

    runHook postInstall
  '';
}
