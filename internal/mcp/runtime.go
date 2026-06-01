package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	EnvironmentByMCPConnectionIndex       = "spec.mcpConnectionRefs.name"
	MCPConnectionFinalizer                = "clawarmor.accuknox.com/mcpconnection"
	EnvironmentFinalizer                  = "clawarmor.accuknox.com/environment-protection"
	GatewayClassName                      = "agentgateway"
	GatewayName                           = "mcp"
	ExtAuthServiceName                    = "extauth"
	ExtAuthRolePrefix                     = "extauth-"
	ExtAuthPort                     int32 = 18081
	AppProtocolMCP                        = "agentgateway.dev/mcp"
	// AgentgatewayParametersName is the name of the AgentgatewayParameters
	// resource that configures the Gateway proxy Service type.
	AgentgatewayParametersName = "mcp-clusterip"
)

// Target describes one resolved MCP upstream target.
type Target struct {
	Host     string
	Port     int32
	Path     *string
	Protocol *agentgatewayv1alpha1.MCPProtocol
	Secure   bool
}

// ParseTarget resolves one MCPConnection into the runtime target shape.
func ParseTarget(conn *clawarmorv1alpha1.MCPConnection) (Target, error) {
	rawURL := strings.TrimSpace(conn.Spec.Endpoint.URL)
	u, err := url.Parse(rawURL)
	if err != nil {
		return Target{}, fmt.Errorf("parse endpoint url: %w", err)
	}

	host := strings.TrimSpace(u.Hostname())
	if host == "" {
		return Target{}, fmt.Errorf("endpoint url %q is missing host", rawURL)
	}

	port, err := parsePort(u)
	if err != nil {
		return Target{}, err
	}

	var path *string
	if u.Path != "" {
		value := u.EscapedPath()
		if value == "" {
			value = u.Path
		}
		path = &value
	}

	protocol := inferProtocol(u.Path)
	return Target{
		Host:     host,
		Port:     port,
		Path:     path,
		Protocol: protocol,
		Secure:   strings.EqualFold(u.Scheme, "https"),
	}, nil
}

// EnvironmentAuthPolicyName returns the auth policy name for one environment
// and connection pair.
func EnvironmentAuthPolicyName(environmentName, connectionName string) string {
	return dnsLabel("env-" + environmentName + "-mcpconn-" + connectionName + "-auth")
}

// ExtAuthOpenBaoName returns the shared OpenBao role and policy name.
func ExtAuthOpenBaoName(namespace string) string {
	return dnsLabel(ExtAuthRolePrefix + namespace)
}

// EnvironmentBackendName returns the MCP backend name for one environment.
func EnvironmentBackendName(name string) string {
	return dnsLabel("env-" + name + "-mcp")
}

// EnvironmentRouteName returns the HTTPRoute name for one environment.
func EnvironmentRouteName(name string) string {
	return dnsLabel("env-" + name + "-route")
}

// EnvironmentRoutePath returns the route path exposed for one environment.
func EnvironmentRoutePath(name string) string {
	return "/mcp/" + name
}

// ManagedRef returns a status reference for one namespaced object.
func ManagedRef(namespace, name string) *clawarmorv1alpha1.MCPConnectionManagedResourceRef {
	return &clawarmorv1alpha1.MCPConnectionManagedResourceRef{
		Namespace: namespace,
		Name:      name,
	}
}

// Gateway returns the desired namespace-local Gateway.
func Gateway(namespace string) *gwv1.Gateway {
	return &gwv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{
			Name:      GatewayName,
			Namespace: namespace,
		},
		Spec: gwv1.GatewaySpec{
			GatewayClassName: gwv1.ObjectName(GatewayClassName),
			Infrastructure: &gwv1.GatewayInfrastructure{
				ParametersRef: &gwv1.LocalParametersReference{
					Group: gwv1.Group("agentgateway.dev"),
					Kind:  gwv1.Kind("AgentgatewayParameters"),
					Name:  AgentgatewayParametersName,
				},
			},
			Listeners: []gwv1.Listener{{
				Name:     gwv1.SectionName("http"),
				Protocol: gwv1.HTTPProtocolType,
				Port:     gwv1.PortNumber(80),
			}},
		},
	}
}

// IndexEnvironmentMCPConnections registers the environment MCP ref index.
func IndexEnvironmentMCPConnections(ctx context.Context, idx client.FieldIndexer) error {
	return idx.IndexField(
		ctx,
		&clawarmorv1alpha1.Environment{},
		EnvironmentByMCPConnectionIndex,
		func(obj client.Object) []string {
			env, ok := obj.(*clawarmorv1alpha1.Environment)
			if !ok {
				return nil
			}
			return MCPConnectionRefNames(env)
		},
	)
}

// MCPConnectionRefNames returns trimmed, non-empty MCP connection names.
func MCPConnectionRefNames(env *clawarmorv1alpha1.Environment) []string {
	names := make([]string, 0, len(env.Spec.MCPConnectionRefs))
	for _, ref := range env.Spec.MCPConnectionRefs {
		name := strings.TrimSpace(ref.Name)
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names
}

// LoadConnections returns live MCPConnection objects referenced by env.
//
// Missing references are ignored so callers can converge runtime state from
// currently resolvable connections.
func LoadConnections(ctx context.Context, c client.Reader, env *clawarmorv1alpha1.Environment) ([]clawarmorv1alpha1.MCPConnection, error) {
	names := MCPConnectionRefNames(env)
	conns := make([]clawarmorv1alpha1.MCPConnection, 0, len(names))
	for _, name := range names {
		conn := &clawarmorv1alpha1.MCPConnection{}
		key := types.NamespacedName{Namespace: env.Namespace, Name: name}
		err := c.Get(ctx, key, conn)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("get mcp connection %q: %w", name, err)
		}
		conns = append(conns, *conn)
	}
	return conns, nil
}

func parsePort(u *url.URL) (int32, error) {
	value := u.Port()
	if value == "" {
		return 443, nil
	}
	port, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("parse endpoint port %q: %w", value, err)
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("endpoint port %d is out of range", port)
	}
	return int32(port), nil
}

func inferProtocol(path string) *agentgatewayv1alpha1.MCPProtocol {
	value := strings.ToLower(strings.TrimSpace(path))
	protocol := agentgatewayv1alpha1.MCPProtocolStreamableHTTP
	if strings.HasSuffix(value, "/sse") {
		protocol = agentgatewayv1alpha1.MCPProtocolSSE
	}
	return &protocol
}

func dnsLabel(prefix string) string {
	value := strings.ToLower(prefix)
	value = strings.ReplaceAll(value, "_", "-")
	value = strings.Map(
		func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
				return r
			}
			return '-'
		},
		value,
	)
	value = strings.Trim(value, "-")
	value = strings.TrimSpace(value)
	if value == "" {
		return "mcp"
	}
	if len(value) <= 63 && isDNSLabel(value) {
		return value
	}

	sum := sha256.Sum256([]byte(value))
	suffix := hex.EncodeToString(sum[:])[:8]
	head := max(63-len(suffix)-1, 1)
	value = strings.Trim(value[:head], "-")
	if value == "" {
		value = "mcp"
	}
	return value + "-" + suffix
}

func isDNSLabel(value string) bool {
	return len(validation.IsDNS1123Label(value)) == 0
}
