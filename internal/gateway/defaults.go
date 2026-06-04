package gateway

import "time"

const (
	// DefaultListenAddr is the default gateway listen address.
	DefaultListenAddr = "localhost:8090"
	// DefaultNamespace is the default namespace to resolve Agents from.
	DefaultNamespace = "default"
)

const (
	statusPollInterval = time.Second
	// DefaultMCPProbeStaleAfter bounds how long an MCP probe remains fresh.
	DefaultMCPProbeStaleAfter = time.Minute * 5
)
