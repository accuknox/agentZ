# Setting SHELL to bash allows bash commands to be executed by recipes.
# Options are set to exit when a recipe line exits non-zero or a piped command fails.
SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

# Image URL to render into Kubernetes manifests.
IMAGE ?= murtazau/clawarmor:latest
AGENT_IMAGE ?= murtazau/clawarmor-agent:latest

.PHONY: all
all: generate lint build

# Generate sql stubs, code containing DeepCopy, DeepCopyInto, and DeepCopyObject
# method implementations and WebhookConfiguration, ClusterRole and
# CustomResourceDefinition objects.
.PHONY: generate
generate:
	sqlc generate
	oapi-codegen -config oapi-codegen.gateway.yaml api/openapi.yaml
	"$(CONTROLLER_GEN)" object:headerFile="hack/boilerplate.go.txt" paths="./api/..."
	"$(CONTROLLER_GEN)" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook \
		paths="./api/...;./internal/controller/...;./internal/webhook/..." \
		output:crd:artifacts:config=config/crd/bases

# Run go fmt against code.
.PHONY: fmt
fmt:
	go fmt ./...
	yamlfmt .

# Run tests.
.PHONY: test
test: $(LOCALBIN)
	KUBEBUILDER_ASSETS="$$( "$(ENVTEST)" use "$(ENVTEST_K8S_VERSION)" --bin-dir "$(abspath $(LOCALBIN))" -p path )" go test -tags="controller webhook" $$(go list ./... | grep -v /e2e) -coverprofile cover.out

# Run golangci-lint linter
.PHONY: lint
lint:
	go vet ./...
	"$(GOLANGCI_LINT)" run
	yamllint .

# Build clawarmor binary.
.PHONY: build
build:
	go build ./...

# Run agent gateway
.PHONY: run-gateway
run-gateway:
	kubectl -n default create token default --duration=24h > /tmp/sa-token
	go run ./cmd/clawarmor gateway serve \
		--target-override=localhost:4096 \
		--postgres-dsn=postgresql://postgres:postgres@localhost:5432/postgres \
		--agent-image=$(AGENT_IMAGE) \
		--agent-trace-endpoint=172.18.0.1:4317 \
		--openbao-addr=http://localhost:8200 \
		--openbao-secret-mount-path=kv \
		--openbao-k8s-auth-role=clawarmor-gateway \
		--openbao-k8s-auth-token-path=/tmp/sa-token

# Run agent controller manager
.PHONY: run-manager
run-manager:
	kubectl -n default create token default --duration=24h > /tmp/sa-token
	go run ./cmd/clawarmor manager \
		--health-probe-bind-address=:8888 \
		--watch-namespace=default \
		--enable-webhooks=false \
		--agent-image=$(AGENT_IMAGE) \
		--sinjector-image=$(IMAGE) \
		--openbao-addr=http://openbao.openbao.svc.cluster.local:8200 \
		--openbao-secret-mount-path=kv \
		--manager-openbao-addr=http://localhost:8200 \
		--manager-openbao-k8s-auth-role=clawarmor-manager \
		--manager-openbao-k8s-auth-token-path=/tmp/sa-token \
		--sinjector-ca-secret-name=sinjector \
		--nix-store-pvc=clawarmor-nix-store

# Run observer
.PHONY: run-observer
run-observer:
	go run ./cmd/clawarmor observer serve --postgres-dsn postgresql://postgres:postgres@localhost:5432/postgres

# Generate a consolidated YAML with CRDs and deployment.
.PHONY: build-installer
build-installer: generate
	mkdir -p dist
	tmp="$$(mktemp -d)"; \
	out="$(abspath dist/install.yaml)"; \
	trap 'rm -rf "$$tmp"' EXIT; \
	cp -R config "$$tmp/config"; \
	cd "$$tmp/config/manager" && "$(KUSTOMIZE)" edit set image controller=${IMAGE}; \
	"$(KUSTOMIZE)" build "$$tmp/config/default" > "$$out"

ifndef ignore-not-found
  ignore-not-found = false
endif

# Install CRDs into the K8s cluster specified in ~/.kube/config.
.PHONY: install
install: generate
	@out="$$( "$(KUSTOMIZE)" build config/crd 2>/dev/null || true )"; \
	if [ -n "$$out" ]; then echo "$$out" | "$(KUBECTL)" apply -f -; else echo "No CRDs to install; skipping."; fi

# Uninstall CRDs from the K8s cluster specified in ~/.kube/config. Call with
# ignore-not-found=true to ignore resource not found errors during deletion.
.PHONY: uninstall
uninstall: generate
	@out="$$( "$(KUSTOMIZE)" build config/crd 2>/dev/null || true )"; \
	if [ -n "$$out" ]; then echo "$$out" | "$(KUBECTL)" delete --ignore-not-found=$(ignore-not-found) -f -; else echo "No CRDs to delete; skipping."; fi

# Deploy controller to the K8s cluster specified in ~/.kube/config.
.PHONY: deploy
deploy: generate
	cd config/manager && "$(KUSTOMIZE)" edit set image controller=${IMAGE}
	"$(KUSTOMIZE)" build config/default | "$(KUBECTL)" apply -f -

# Undeploy controller from the K8s cluster specified in ~/.kube/config. Call
# with ignore-not-found=true to ignore resource not found errors during
# deletion.
.PHONY: undeploy
undeploy:
	"$(KUSTOMIZE)" build config/default | "$(KUBECTL)" delete --ignore-not-found=$(ignore-not-found) -f -

# Location to install dependencies to
LOCALBIN ?= $(shell pwd)/bin
$(LOCALBIN):
	mkdir -p "$(LOCALBIN)"

# Tool Binaries
KUBECTL ?= kubectl
KUSTOMIZE ?= kustomize
CONTROLLER_GEN ?= controller-gen
ENVTEST ?= setup-envtest
GOLANGCI_LINT ?= golangci-lint

# Version of Kubernetes to use for setting up ENVTEST binaries (i.e. 1.31)
ENVTEST_K8S_VERSION ?= $(shell v='$(call gomodver,k8s.io/api)'; \
  [ -n "$$v" ] || { echo "Set ENVTEST_K8S_VERSION manually (k8s.io/api replace has no tag)" >&2; exit 1; }; \
  printf '%s\n' "$$v" | sed -E 's/^v?[0-9]+\.([0-9]+).*/1.\1/')

define gomodver
$(shell go list -m -f '{{if .Replace}}{{.Replace.Version}}{{else}}{{.Version}}{{end}}' $(1) 2>/dev/null)
endef

# generates clientset, informers and listers
CODEGEN_PKG = _output/tmp/code-generator
CODEGEN_PKG_VERSION ?= v0.35.3
.PHONY: codegen
codegen:
	@rm -rf $(CODEGEN_PKG)
	@echo "[~] Installing kube-codegen..."
	@git clone https://github.com/kubernetes/code-generator --branch $(CODEGEN_PKG_VERSION) --single-branch $(CODEGEN_PKG)
	@echo "[~] Generating clientset, informers & listers..."
	@mkdir -p pkg/agent-controller/clientset pkg/agent-controller/listers pkg/agent-controller/informers
	CODEGEN_PKG=$(CODEGEN_PKG) hack/update-codegen.sh
	@rm -rf _output/
