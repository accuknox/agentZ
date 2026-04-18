SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

PROTO_FILES := internal/session/proto/session.proto

.PHONY: all
all: generate lint test build

.PHONY: generate
generate:
	sqlc generate
	buf generate

.PHONY: fmt
fmt:
	gofmt -w $$(find cmd internal -name '*.go' -print)

.PHONY: test
test:
	go test -v ./...

.PHONY: lint
lint:
	go vet ./...
	golangci-lint run
	buf lint
	protoc --lint_out=sort_imports:. $(PROTO_FILES)

.PHONY: build
build:
	go build ./...
