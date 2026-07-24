package sandbox

import (
	"fmt"
	"strings"

	gwv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const (
	tracePolicyName           = "mcp-tracing"
	traceBackendName          = "mcp-tracing-backend"
	inferenceTracePolicyName  = "inference-tracing"
	inferenceTraceBackendName = "inference-tracing-backend"
)

// TraceBackendMode selects how AgentGateway exports traces.
type TraceBackendMode string

const (
	// TraceBackendModeService routes MCP traces to a Kubernetes Service.
	TraceBackendModeService TraceBackendMode = "service"
	// TraceBackendModeStatic routes MCP traces to a static host or IP.
	TraceBackendModeStatic TraceBackendMode = "static"
)

// TraceBackend configures the AgentGateway OTLP destination.
type TraceBackend struct {
	Mode             TraceBackendMode
	ServiceName      string
	ServiceNamespace string
	ServicePort      gwv1.PortNumber
	Host             string
	Port             gwv1.PortNumber
}

// Validate rejects incomplete or conflicting trace backend configuration.
func (c TraceBackend) Validate() error {
	switch c.Mode {
	case TraceBackendModeService:
		if c.ServiceName == "" {
			return fmt.Errorf("agentgateway trace service name is required")
		}
		if c.ServiceNamespace == "" {
			return fmt.Errorf("agentgateway trace service namespace is required")
		}
		if c.ServicePort < 1 || c.ServicePort > 65535 {
			return fmt.Errorf("agentgateway trace service port %d is invalid", c.ServicePort)
		}
		return nil
	case TraceBackendModeStatic:
		if c.Host == "" {
			return fmt.Errorf("agentgateway trace host is required")
		}
		if c.Port < 1 || c.Port > 65535 {
			return fmt.Errorf("agentgateway trace port %d is invalid", c.Port)
		}
		return nil
	default:
		return fmt.Errorf("agentgateway trace mode %q is invalid", c.Mode)
	}
}

// ParseTraceBackend builds trace backend config from explicit manager flags.
func ParseTraceBackend(mode string, svcName string, svcNS string, svcPort int, host string, port int) (TraceBackend, error) {
	cfg := TraceBackend{
		Mode:             TraceBackendMode(strings.TrimSpace(mode)),
		ServiceName:      strings.TrimSpace(svcName),
		ServiceNamespace: strings.TrimSpace(svcNS),
		ServicePort:      gwv1.PortNumber(svcPort),
		Host:             strings.TrimSpace(host),
		Port:             gwv1.PortNumber(port),
	}
	return cfg, cfg.Validate()
}
