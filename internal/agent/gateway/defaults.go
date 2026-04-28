package gateway

import "time"

const (
	// DefaultListenAddr is the default gateway listen address.
	DefaultListenAddr = "localhost:8090"
	// DefaultBaseURL is the default gateway HTTP base URL.
	DefaultBaseURL = "http://localhost:8090"
	// DefaultNamespace is the default namespace to resolve Agents from.
	DefaultNamespace = "default"
	// DefaultValkeyAddr is the default Valkey address.
	DefaultValkeyAddr = "localhost:6379"
)

const (
	statusPollInterval = time.Second
	defaultRunTTL      = 24 * time.Hour
)
