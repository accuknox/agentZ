# Build the agentz binary
FROM --platform=$BUILDPLATFORM golang:1.26 AS builder
ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace
# Copy the Go Modules manifests
COPY go.mod go.mod
COPY go.sum go.sum
# cache deps before building and copying source so that we don't need to re-download as much
# and so that source changes don't invalidate our downloaded layer
RUN go mod download

# Copy the Go source (relies on .dockerignore to filter)
COPY . .

# Build
# the GOARCH has no default value to allow the binary to be built according to the host where the command
# was called. For example, if we call make docker-build in a local env which has the Apple Silicon M1 SO
# the docker BUILDPLATFORM arg will be linux/arm64 when for Apple x86 it will be linux/amd64. Therefore,
# by leaving it empty we can ensure that the container and binary shipped on it will have the same platform.
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -a -o agentz ./cmd/agentz

# The gateway uses native Git for authenticated repository operations.
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /
COPY --from=builder /workspace/agentz .
COPY --from=builder /workspace/internal/gateway/db/migrations /internal/gateway/db/migrations
COPY --from=builder /workspace/internal/observer/db/migrations /internal/observer/db/migrations
COPY --from=builder /workspace/internal/gateway/workflow/db/migrations /internal/gateway/workflow/db/migrations
COPY --from=builder /workspace/internal/gateway/dashboard/db/migrations /internal/gateway/dashboard/db/migrations
USER 65532:65532
ENTRYPOINT ["/agentz"]
