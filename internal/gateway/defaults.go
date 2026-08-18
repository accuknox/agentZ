package gateway

import "time"

const (
	// DefaultListenAddr is the default gateway listen address.
	DefaultListenAddr = "localhost:8090"
)

const (
	// DefaultMCPProbeStaleAfter bounds how long an MCP probe remains fresh.
	DefaultMCPProbeStaleAfter = time.Minute * 5
)
