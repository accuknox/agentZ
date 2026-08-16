SHELL := bash
.SHELLFLAGS := -euo pipefail -c

IMAGE ?= murtazau/agentz:latest
AGENT_IMAGE ?= murtazau/agentz-agent:latest
BETTER_AUTH_URL ?= http://localhost:3000
GATEWAY_JWT_AUDIENCE ?= agentz-gateway
POSTGRES_DSN ?= postgresql://postgres:postgres@localhost:5432/postgres
K8S_NAMESPACE ?= default
OPENBAO_TOKEN_PATH ?= /tmp/sa-token
OPENBAO_AUTH_SERVICE_ACCOUNT ?= default
EXTAUTH_OPENBAO_K8S_AUTH_ROLE ?= extauth
IGNORE_NOT_FOUND ?= false
SKILLS_S3_ENDPOINT ?= http://localhost:9000
SKILLS_S3_REGION ?= us-east-1
SKILLS_S3_BUCKET ?= agentz
SKILLS_S3_ACCESS_KEY_ID ?= admin
SKILLS_S3_SECRET_ACCESS_KEY ?= admin

KUBECTL ?= kubectl
KUSTOMIZE ?= kustomize
CONTROLLER_GEN ?= controller-gen

GO_PKGS := ./cmd ./hack/... ./internal/... ./pkg/...

.PHONY: all
all: generate lint build

.PHONY: generate
generate:
	sqlc generate
	go run ./hack/inference/generate_providers.go
	go run ./hack/openapi/generate_opencode_gateway.go
	oapi-codegen \
		--include-tags agents,tenants,workspaces,event-trail,lens,secrets,sandboxes,inference,skills,mcp-connections,workflows,workflow-schedules,workflow-runs,workflow-webhooks,session \
		-config oapi-codegen.gateway.yaml openapi/gateway.yaml
	$(CONTROLLER_GEN) object:headerFile="hack/boilerplate.go.txt" paths="./pkg/apis/..."
	$(CONTROLLER_GEN) rbac:roleName=manager-role crd:allowDangerousTypes=false webhook \
		paths="./pkg/apis/...;./internal/controller/...;./internal/webhook/..." \
		output:rbac:artifacts:config=deploy/kustomize/rbac \
		output:webhook:artifacts:config=deploy/kustomize/webhook \
		output:crd:artifacts:config=deploy/kustomize/crd/bases
	cp deploy/kustomize/crd/bases/*.yaml deploy/helm/charts/manager/crds/
	cd web && bun run gen:openapi-client
	cd opencode/config && bun run gen:openapi-client

.PHONY: fmt
fmt:
	go fmt $(GO_PKGS)
	goimports -w cmd hack internal pkg
	yamlfmt .
	cd web && bun run format
	cd opencode/config && bun run format

.PHONY: test
test:
	mkdir -p bin
	version="$(ENVTEST_K8S_VERSION)"; \
	if [ -z "$$version" ]; then \
		version="$$(go list -m -f '{{if .Replace}}{{.Replace.Version}}{{else}}{{.Version}}{{end}}' k8s.io/api | sed -E 's/^v?[0-9]+\.([0-9]+).*/1.\1/')"; \
	fi; \
	KUBEBUILDER_ASSETS="$$(setup-envtest use "$$version" --bin-dir "$(CURDIR)/bin" -p path)" \
		go test -tags="controller webhook" $(GO_PKGS) -coverprofile cover.out

.PHONY: lint
lint:
	go vet $(GO_PKGS)
	golangci-lint run $(GO_PKGS)
	yamllint .
	cd web && bun run lint && bun run typecheck
	cd opencode/config && bun run lint && bun run typecheck

.PHONY: build
build:
	go build $(GO_PKGS)

.PHONY: run-gateway
run-gateway:
	umask 077; \
		$(KUBECTL) -n $(K8S_NAMESPACE) create token default --duration=24h > "$(OPENBAO_TOKEN_PATH)"
	@AGENTZ_SKILLS_S3_ACCESS_KEY_ID=$(SKILLS_S3_ACCESS_KEY_ID) \
	AGENTZ_SKILLS_S3_SECRET_ACCESS_KEY=$(SKILLS_S3_SECRET_ACCESS_KEY) \
		go run ./cmd/agentz gateway serve \
		--log-level=info \
		--addr=0.0.0.0:8090 \
		--target-override=localhost:4096 \
		--filesystem-target-override=localhost:4097 \
		--postgres-dsn="$(POSTGRES_DSN)" \
		--external-jwt-jwks-url=$(BETTER_AUTH_URL)/api/auth/.well-known/jwks.json \
		--external-jwt-issuer=$(BETTER_AUTH_URL) \
		--external-jwt-audience=$(GATEWAY_JWT_AUDIENCE) \
		--internal-k8s-token-audience=$(GATEWAY_JWT_AUDIENCE) \
		--agent-image=$(AGENT_IMAGE) \
		--agent-trace-endpoint=172.18.0.1:4317 \
		--openbao-addr=http://localhost:8200 \
		--openbao-secret-mount-path=kv \
		--openbao-k8s-auth-role=gateway \
		--openbao-k8s-auth-token-path=$(OPENBAO_TOKEN_PATH) \
		--skills-s3-endpoint=$(SKILLS_S3_ENDPOINT) \
		--skills-s3-region=$(SKILLS_S3_REGION) \
		--skills-s3-bucket=$(SKILLS_S3_BUCKET)

.PHONY: run-manager
run-manager:
	umask 077; \
		$(KUBECTL) -n $(K8S_NAMESPACE) create token default --duration=24h > "$(OPENBAO_TOKEN_PATH)"; \
		$(KUBECTL) -n $(K8S_NAMESPACE) create token default --audience=$(GATEWAY_JWT_AUDIENCE) --duration=24h > /tmp/gateway-sa-token
	@AGENTZ_SKILLS_S3_ACCESS_KEY_ID=$(SKILLS_S3_ACCESS_KEY_ID) \
	AGENTZ_SKILLS_S3_SECRET_ACCESS_KEY=$(SKILLS_S3_SECRET_ACCESS_KEY) \
		go run ./cmd/agentz manager \
		--health-probe-bind-address=:8888 \
		--enable-webhooks=false \
		--workflowrun-orphan-retention=168h \
		--controller-image=$(IMAGE) \
		--agent-image=$(AGENT_IMAGE) \
		--openbao-addr=http://openbao.openbao.svc.cluster.local:8200 \
		--openbao-secret-mount-path=kv \
		--manager-openbao-addr=http://localhost:8200 \
		--manager-openbao-k8s-auth-role=manager \
		--manager-openbao-k8s-auth-token-path=$(OPENBAO_TOKEN_PATH) \
		--manager-gateway-token-path=/tmp/gateway-sa-token \
		--manager-service-account-name=default \
		--manager-service-account-namespace=$(K8S_NAMESPACE) \
		--gateway-service-account-name=default \
		--gateway-service-account-namespace=$(K8S_NAMESPACE) \
		--sinjector-ca-secret-name=sinjector \
		--nix-store-pvc=nix-store \
		--nix-store-size=5Gi \
		--nix-store-access-mode=ReadWriteOnce \
		--nix-cache-endpoint=https://cache.nixos.org \
		--skills-s3-endpoint=$(SKILLS_S3_ENDPOINT) \
		--skills-s3-region=$(SKILLS_S3_REGION) \
		--skills-s3-bucket=$(SKILLS_S3_BUCKET) \
		--tenant-sinjector-clusterissuer-name=selfsigned \
		--agentgateway-trace-mode=static \
		--agentgateway-trace-host=172.18.0.1 \
		--agentgateway-trace-port=4317 \
		--gateway-url=http://172.18.0.1:8090

.PHONY: run-observer
run-observer:
	go run ./cmd/agentz observer serve --postgres-dsn "$(POSTGRES_DSN)"

.PHONY: run-extauth
run-extauth:
	umask 077; \
		$(KUBECTL) -n $(K8S_NAMESPACE) create token $(OPENBAO_AUTH_SERVICE_ACCOUNT) --duration=24h > "$(OPENBAO_TOKEN_PATH)"
	go run ./cmd/agentz extauth serve \
		--addr 0.0.0.0:18081 \
		--namespace=$(K8S_NAMESPACE) \
		--openbao-addr=http://localhost:8200 \
		--openbao-secret-mount-path=kv \
		--openbao-k8s-auth-role=$(EXTAUTH_OPENBAO_K8S_AUTH_ROLE) \
		--openbao-k8s-auth-token-path=$(OPENBAO_TOKEN_PATH)

.PHONY: build-installer
build-installer: generate
	mkdir -p dist
	tmp="$$(mktemp -d)"; \
	trap 'rm -rf "$$tmp"' EXIT; \
	cp -R deploy "$$tmp/deploy"; \
	cd "$$tmp/deploy/kustomize/manager"; \
	$(KUSTOMIZE) edit set image controller=$(IMAGE); \
	$(KUSTOMIZE) build "$$tmp/deploy/kustomize/default" > "$(CURDIR)/dist/install.yaml"

.PHONY: install
install: generate
	$(KUSTOMIZE) build deploy/kustomize/crd | $(KUBECTL) apply -f -

.PHONY: uninstall
uninstall:
	$(KUSTOMIZE) build deploy/kustomize/crd | $(KUBECTL) delete --ignore-not-found=$(IGNORE_NOT_FOUND) -f -

.PHONY: deploy
deploy: generate
	tmp="$$(mktemp -d)"; \
	trap 'rm -rf "$$tmp"' EXIT; \
	cp -R deploy "$$tmp/deploy"; \
	cd "$$tmp/deploy/kustomize/manager"; \
	$(KUSTOMIZE) edit set image controller=$(IMAGE); \
	$(KUSTOMIZE) build "$$tmp/deploy/kustomize/default" | $(KUBECTL) apply -f -

.PHONY: undeploy
undeploy:
	$(KUSTOMIZE) build deploy/kustomize/default | $(KUBECTL) delete --ignore-not-found=$(IGNORE_NOT_FOUND) -f -

.PHONY: codegen
codegen:
	tmp="$$(mktemp -d)"; \
	trap 'rm -rf "$$tmp"' EXIT; \
	git clone --depth 1 \
		--branch "$$(go list -m -f '{{if .Replace}}{{.Replace.Version}}{{else}}{{.Version}}{{end}}' k8s.io/client-go)" \
		https://github.com/kubernetes/code-generator "$$tmp/code-generator"; \
	CODEGEN_PKG="$$tmp/code-generator" hack/update-codegen.sh
