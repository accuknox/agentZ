# Setting SHELL to bash allows bash commands to be executed by recipes.
# Options are set to exit when a recipe line exits non-zero or a piped command fails.
SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

SESSION_PROTO_DIR := internal/session/proto
SESSION_PROTO_FILE := $(SESSION_PROTO_DIR)/session.proto
AGENT_PROTO_DIR := internal/agent/proto
AGENT_PROTO_FILE := $(AGENT_PROTO_DIR)/agent.proto
AGENT_GATEWAY_PROTO_DIR := internal/agent/gateway/proto
AGENT_GATEWAY_PROTO_FILE := $(AGENT_GATEWAY_PROTO_DIR)/gateway.proto
PROTO_FILES := $(SESSION_PROTO_FILE) $(AGENT_PROTO_FILE) $(AGENT_GATEWAY_PROTO_FILE)
WEB_SESSION_PROTO_DIR := web/src/lib/server/session
WEB_SESSION_PROTO_OUT := $(WEB_SESSION_PROTO_DIR)/session.ts $(WEB_SESSION_PROTO_DIR)/google
WEB_AGENT_GATEWAY_PROTO_DIR := web/src/lib/server/agent-gateway
WEB_AGENT_GATEWAY_PROTO_OUT := $(WEB_AGENT_GATEWAY_PROTO_DIR)/gateway.ts
WEB_TS_PROTO_PLUGIN := ./web/node_modules/.bin/protoc-gen-ts_proto
WEB_PACKAGE_JSON := web/package.json
WEB_BUN_LOCK := web/bun.lock
PROTOC_INCLUDE := $(dir $(shell command -v protoc))../include

# Image URL to render into Kubernetes manifests.
IMAGE ?= murtazau/clawarmor:latest

.PHONY: all
all: generate lint build

# Generate sql and protobuf stubs and code containing DeepCopy, DeepCopyInto,
# and DeepCopyObject method implementations and WebhookConfiguration,
# ClusterRole and CustomResourceDefinition objects.
.PHONY: generate
generate:
	sqlc generate
	buf generate
	$(MAKE) web-proto
	"$(CONTROLLER_GEN)" object:headerFile="hack/boilerplate.go.txt" paths="./api/..."
	"$(CONTROLLER_GEN)" rbac:roleName=manager-role crd:allowDangerousTypes=true webhook \
		paths="./api/...;./internal/controller/...;./internal/webhook/..." \
		output:crd:artifacts:config=config/crd/bases

.PHONY: web-proto
web-proto: $(WEB_TS_PROTO_PLUGIN)
	mkdir -p $(WEB_SESSION_PROTO_DIR)
	rm -rf $(WEB_SESSION_PROTO_OUT)
	protoc -I $(SESSION_PROTO_DIR) -I "$(PROTOC_INCLUDE)" \
		--plugin=protoc-gen-ts_proto=$(WEB_TS_PROTO_PLUGIN) \
		--ts_proto_out=$(WEB_SESSION_PROTO_DIR) \
		--ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true,importSuffix=.js \
		session.proto
	mkdir -p $(WEB_AGENT_GATEWAY_PROTO_DIR)
	rm -rf $(WEB_AGENT_GATEWAY_PROTO_OUT)
	protoc -I $(AGENT_GATEWAY_PROTO_DIR) -I "$(PROTOC_INCLUDE)" \
		--plugin=protoc-gen-ts_proto=$(WEB_TS_PROTO_PLUGIN) \
		--ts_proto_out=$(WEB_AGENT_GATEWAY_PROTO_DIR) \
		--ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true,importSuffix=.js \
		gateway.proto

$(WEB_TS_PROTO_PLUGIN): $(WEB_PACKAGE_JSON) $(WEB_BUN_LOCK)
	cd web && bun install

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
	buf lint
	protoc --lint_out=sort_imports:. $(PROTO_FILES)
	yamllint .

# Build clawarmor binary.
.PHONY: build
build:
	go build ./...

# Run agent controller manager
.PHONY: run-manager
run-manager:
	ENABLE_WEBHOOKS=false WATCH_NAMESPACE=default go run ./cmd/clawarmor manager --health-probe-bind-address :8888

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
