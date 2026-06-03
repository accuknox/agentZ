package mcp

// MCPConnection condition types shared by the controller, observer, and
// gateway.
const (
	ConditionAccepted              = "Accepted"
	ConditionReady                 = "Ready"
	ConditionDegraded              = "Degraded"
	ConditionExtAuthReady          = "ExtAuthReady"
	ConditionProbeHealthy          = "ProbeHealthy"
	ConditionConnectionUnreachable = "ConnectionUnreachable"
	ConditionCredentialsInvalid    = "CredentialsInvalid"
	ConditionInternalError         = "InternalError"
	ConditionProtocolError         = "ProtocolError"
)

// MCPConnection condition reasons shared by the controller and observer.
const (
	ReasonAccepted              = "Accepted"
	ReasonReady                 = "Ready"
	ReasonReconcileFailed       = "ReconcileFailed"
	ReasonProbePending          = "ProbePending"
	ReasonConnectionUnreachable = "ConnectionUnreachable"
	ReasonCredentialsInvalid    = "CredentialsInvalid"
	ReasonInternalError         = "InternalError"
	ReasonProtocolError         = "ProtocolError"
)
