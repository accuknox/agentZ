package sessionstore

const (
	// DefaultAppName is the fixed application scope for ClawArmor sessions.
	DefaultAppName = "clawarmor-agent"
	// DefaultUserID is the fixed user scope for ClawArmor sessions.
	DefaultUserID = "default-user"
	// DefaultSessionID is the local in-memory session id fallback.
	DefaultSessionID = "00000000-0000-4000-8000-000000000001"
	// DefaultTarget is the default gRPC address for the session service.
	DefaultTarget = "localhost:8081"
	// DefaultListenAddr is the default server listen address.
	DefaultListenAddr = ":8081"
)
