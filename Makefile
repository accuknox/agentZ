# Setting SHELL to bash allows bash commands to be executed by recipes.
# Options are set to exit when a recipe line exits non-zero or a piped command fails.
SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

PROTO_FILES := internal/session/proto/session.proto internal/agent/proto/agent.proto

# Image URL to use all building/pushing image targets
IMG ?= murtazau/clawarmor:latest

# CONTAINER_TOOL defines the container tool to be used for building images.
# Be aware that the target commands are only tested with Docker which is
# scaffolded by default. However, you might want to replace it to use other
# tools. (i.e. podman)
CONTAINER_TOOL ?= docker

.PHONY: all
all: generate lint build

# Generate sql and protobuf stubs and code containing DeepCopy, DeepCopyInto,
# and DeepCopyObject method implementations and WebhookConfiguration,
# ClusterRole and CustomResourceDefinition objects.
.PHONY: generate
generate:
	sqlc generate
	buf generate
	"$(CONTROLLER_GEN)" object:headerFile="hack/boilerplate.go.txt" paths="./api/..."
	"$(CONTROLLER_GEN)" rbac:roleName=manager-role crd webhook \
		paths="./api/...;./internal/controller/..." \
		output:crd:artifacts:config=config/crd/bases

# Run go fmt against code.
.PHONY: fmt
fmt:
	go fmt ./...

# Run tests.
.PHONY: test
test: manifests generate fmt vet setup-envtest
	KUBEBUILDER_ASSETS="$(shell "$(ENVTEST)" use $(ENVTEST_K8S_VERSION) --bin-dir "$(LOCALBIN)" -p path)" go test $$(go list ./... | grep -v /e2e) -coverprofile cover.out

# TODO(user): To use a different vendor for e2e tests, modify the setup under 'tests/e2e'.
# The default setup assumes Kind is pre-installed and builds/loads the Manager Docker image locally.
# CertManager is installed by default; skip with:
# - CERT_MANAGER_INSTALL_SKIP=true
KIND_CLUSTER ?= clawarmor-test-e2e

# Set up a Kind cluster for e2e tests if it does not exist
.PHONY: setup-test-e2e
setup-test-e2e:
	@command -v $(KIND) >/dev/null 2>&1 || { \
		echo "Kind is not installed. Please install Kind manually."; \
		exit 1; \
	}
	@case "$$($(KIND) get clusters)" in \
		*"$(KIND_CLUSTER)"*) \
			echo "Kind cluster '$(KIND_CLUSTER)' already exists. Skipping creation." ;; \
		*) \
			echo "Creating Kind cluster '$(KIND_CLUSTER)'..."; \
			$(KIND) create cluster --name $(KIND_CLUSTER) ;; \
	esac

# Run the e2e tests. Expected an isolated environment using Kind.
.PHONY: test-e2e
test-e2e: setup-test-e2e manifests generate fmt vet
	KIND=$(KIND) KIND_CLUSTER=$(KIND_CLUSTER) go test -tags=e2e ./test/e2e/ -v -ginkgo.v
	$(MAKE) cleanup-test-e2e

# Tear down the Kind cluster used for e2e tests
.PHONY: cleanup-test-e2e
cleanup-test-e2e:
	@$(KIND) delete cluster --name $(KIND_CLUSTER)

# Run golangci-lint linter
.PHONY: lint
lint:
	go vet ./...
	"$(GOLANGCI_LINT)" run
	buf lint
	protoc --lint_out=sort_imports:. $(PROTO_FILES)

## Build clawarmor binary.
.PHONY: build
build:
	go build ./...

# Build docker image with the manager.
#
# If you wish to build the manager image targeting other platforms you can use
# the --platform flag (i.e. docker build --platform linux/arm64). However, you
# must enable docker buildKit for it.
#
# More info: https://docs.docker.com/develop/develop-images/build_enhancements/
.PHONY: docker-build
docker-build:
	$(CONTAINER_TOOL) build -t ${IMG} .

# Push docker image with the manager.
.PHONY: docker-push
docker-push:
	$(CONTAINER_TOOL) push ${IMG}

# PLATFORMS defines the target platforms for the manager image be built to
# provide support to multiple architectures (i.e. make docker-buildx IMG=myregistry/mypoperator:0.0.1).
# To use this option you need to:
# - be able to use docker buildx. More info: https://docs.docker.com/build/buildx/
# - have enabled BuildKit. More info: https://docs.docker.com/develop/develop-images/build_enhancements/
# - be able to push the image to your registry (i.e. if you do not set a valid value via IMG=<myregistry/image:<tag>> then the export will fail)
#
# To adequately provide solutions that are compatible with multiple platforms,
# you should consider using this option.
PLATFORMS ?= linux/arm64,linux/amd64,linux/s390x,linux/ppc64le

# Build and push docker image for the manager for cross-platform support
.PHONY: docker-buildx
docker-buildx:
	# copy existing Dockerfile and insert --platform=${BUILDPLATFORM} into Dockerfile.cross, and preserve the original Dockerfile
	sed -e '1 s/\(^FROM\)/FROM --platform=\$$\{BUILDPLATFORM\}/; t' -e ' 1,// s//FROM --platform=\$$\{BUILDPLATFORM\}/' Dockerfile > Dockerfile.cross
	- $(CONTAINER_TOOL) buildx create --name clawarmor-builder
	$(CONTAINER_TOOL) buildx use clawarmor-builder
	- $(CONTAINER_TOOL) buildx build --push --platform=$(PLATFORMS) --tag ${IMG} -f Dockerfile.cross .
	- $(CONTAINER_TOOL) buildx rm clawarmor-builder
	rm Dockerfile.cross

# Generate a consolidated YAML with CRDs and deployment.
.PHONY: build-manager-installer
build-installer: manifests generate kustomize
	mkdir -p dist
	cd config/manager && "$(KUSTOMIZE)" edit set image controller=${IMG}
	"$(KUSTOMIZE)" build config/default > dist/install.yaml

ifndef ignore-not-found
  ignore-not-found = false
endif

# Install CRDs into the K8s cluster specified in ~/.kube/config.
.PHONY: install
install: manifests kustomize
	@out="$$( "$(KUSTOMIZE)" build config/crd 2>/dev/null || true )"; \
	if [ -n "$$out" ]; then echo "$$out" | "$(KUBECTL)" apply -f -; else echo "No CRDs to install; skipping."; fi

# Uninstall CRDs from the K8s cluster specified in ~/.kube/config. Call with
# ignore-not-found=true to ignore resource not found errors during deletion.
.PHONY: uninstall
uninstall: manifests kustomize
	@out="$$( "$(KUSTOMIZE)" build config/crd 2>/dev/null || true )"; \
	if [ -n "$$out" ]; then echo "$$out" | "$(KUBECTL)" delete --ignore-not-found=$(ignore-not-found) -f -; else echo "No CRDs to delete; skipping."; fi

# Deploy controller to the K8s cluster specified in ~/.kube/config.
.PHONY: deploy
deploy: manifests kustomize
	cd config/manager && "$(KUSTOMIZE)" edit set image controller=${IMG}
	"$(KUSTOMIZE)" build config/default | "$(KUBECTL)" apply -f -

# Undeploy controller from the K8s cluster specified in ~/.kube/config. Call
# with ignore-not-found=true to ignore resource not found errors during
# deletion.
.PHONY: undeploy
undeploy: kustomize
	"$(KUSTOMIZE)" build config/default | "$(KUBECTL)" delete --ignore-not-found=$(ignore-not-found) -f -

# Location to install dependencies to
LOCALBIN ?= $(shell pwd)/bin
$(LOCALBIN):
	mkdir -p "$(LOCALBIN)"

# Tool Binaries
KUBECTL ?= kubectl
KIND ?= kind
KUSTOMIZE ?= kustomize
CONTROLLER_GEN ?= controller-gen
ENVTEST ?= setup-envtest
GOLANGCI_LINT = golangci-lint

# Version of Kubernetes to use for setting up ENVTEST binaries (i.e. 1.31)
ENVTEST_K8S_VERSION ?= $(shell v='$(call gomodver,k8s.io/api)'; \
  [ -n "$$v" ] || { echo "Set ENVTEST_K8S_VERSION manually (k8s.io/api replace has no tag)" >&2; exit 1; }; \
  printf '%s\n' "$$v" | sed -E 's/^v?[0-9]+\.([0-9]+).*/1.\1/')

define gomodver
$(shell go list -m -f '{{if .Replace}}{{.Replace.Version}}{{else}}{{.Version}}{{end}}' $(1) 2>/dev/null)
endef
