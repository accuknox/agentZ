package observer

import "time"

const (
	// DefaultKubeArmorRelayAddr is the local relay address used by development.
	DefaultKubeArmorRelayAddr = "localhost:32767"
	// DefaultHubbleRelayAddr is the local relay address used by development.
	DefaultHubbleRelayAddr = "localhost:4245"
	// DefaultOTLPTraceGRPCAddr is the OTLP/gRPC trace receiver address.
	DefaultOTLPTraceGRPCAddr = ":4317"
	// DefaultOTLPAppGRPCAddr stays local until network isolation is configured.
	DefaultOTLPAppGRPCAddr = "127.0.0.1:4318"
	// DefaultOTLPTraceMaxMessageSize accommodates measured full input/output exports.
	DefaultOTLPTraceMaxMessageSize = 128 << 20
	// DefaultBatchSize balances COPY throughput with bounded shutdown drain.
	DefaultBatchSize = 500
	// DefaultFlushInterval caps event visibility latency in PostgreSQL.
	DefaultFlushInterval = time.Second
)
