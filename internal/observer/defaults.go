package observer

import "time"

const (
	// DefaultKubeArmorRelayAddr is the local relay address used by development.
	DefaultKubeArmorRelayAddr = "localhost:32767"
	// DefaultHubbleRelayAddr is the local relay address used by development.
	DefaultHubbleRelayAddr = "localhost:4245"
	// DefaultNamespace is the namespace watched by the observer.
	DefaultNamespace = "default"
	// DefaultBatchSize balances COPY throughput with bounded shutdown drain.
	DefaultBatchSize = 500
	// DefaultFlushInterval caps event visibility latency in PostgreSQL.
	DefaultFlushInterval = time.Second
)
