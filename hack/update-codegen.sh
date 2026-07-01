#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

: "${CODEGEN_PKG:=_output/tmp/code-generator}"
CODEGEN_PKG="$(realpath $CODEGEN_PKG)"

source "$CODEGEN_PKG/kube_codegen.sh"
kube::codegen::gen_client ./pkg/apis \
   --with-watch \
   --output-dir pkg/controller \
   --output-pkg github.com/accuknox/agentz/pkg/controller \
   --boilerplate hack/boilerplate.go.txt
