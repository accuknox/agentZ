package relay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	agentcontroller "github.com/accuknox/agentz/internal/controller/agent"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/host"
	hostv1 "github.com/accuknox/agentz/internal/host/proto"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/observer"
	"github.com/accuknox/agentz/internal/scope"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
)

func (s *Service) authorizeHost(ctx context.Context) (host.Binding, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	p, ok := peer.FromContext(ctx)
	if !ok {
		return host.Binding{}, status.Error(codes.Unauthenticated, "missing TLS peer")
	}
	// go-spiffe verifies the chain in its TLS callback, so VerifiedChains is empty.
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.PeerCertificates) == 0 {
		return host.Binding{}, status.Error(codes.Unauthenticated, "missing verified identity")
	}
	if len(tlsInfo.State.PeerCertificates[0].URIs) != 1 {
		return host.Binding{}, status.Error(codes.Unauthenticated, "missing verified identity")
	}
	id, err := spiffeid.FromURI(tlsInfo.State.PeerCertificates[0].URIs[0])
	if err != nil {
		return host.Binding{}, status.Error(codes.Unauthenticated, "invalid SPIFFE identity")
	}
	record, err := s.queries.GatewayComputeIdentity(ctx, id.String())
	if err != nil {
		return host.Binding{}, status.Error(codes.PermissionDenied, "host is not assigned")
	}
	agt := &agentzv1alpha1.Agent{}
	key := ctrlclient.ObjectKey{Namespace: record.TenantNamespace, Name: record.AgentName}
	err = s.k8sClient.Get(ctx, key, agt)
	agentUnavailable := err != nil || !agt.DeletionTimestamp.IsZero() || agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative
	if agentUnavailable {
		return host.Binding{}, status.Error(codes.PermissionDenied, "Agent is unavailable")
	}
	method, _ := grpc.Method(ctx)
	if method != hostv1.HostRelay_Control_FullMethodName {
		session, _ := s.hosts.Connection(host.Binding{
			Namespace: record.TenantNamespace, Agent: record.AgentName, Epoch: record.ID.String(),
		})
		if session == "" {
			return host.Binding{}, status.Error(codes.PermissionDenied, "host is not connected")
		}
	}
	return host.Binding{
		Namespace: record.TenantNamespace,
		Agent:     record.AgentName,
		Epoch:     record.ID.String(),
	}, nil
}

func (s *Service) nativeSpec(ctx context.Context, binding host.Binding) (host.RuntimeSpec, error) {
	record, err := s.queries.GatewayComputeHost(ctx, gatewaydb.GatewayComputeHostParams{
		TenantNamespace: binding.Namespace, AgentName: binding.Agent,
	})
	if err != nil {
		return host.RuntimeSpec{}, err
	}
	if record.Revoked || record.ID.String() != binding.Epoch {
		return host.RuntimeSpec{}, status.Error(codes.PermissionDenied, "host assignment revoked")
	}
	session, _ := s.hosts.Connection(binding)
	if session == "" {
		return host.RuntimeSpec{}, status.Error(codes.PermissionDenied, "host is not connected")
	}
	agt := &agentzv1alpha1.Agent{}
	key := ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: binding.Agent}
	if err := s.k8sClient.Get(ctx, key, agt); err != nil {
		return host.RuntimeSpec{}, err
	}
	if !agt.DeletionTimestamp.IsZero() {
		return host.RuntimeSpec{}, status.Error(codes.PermissionDenied, "Agent deleted")
	}
	compiler := agentcontroller.Reconciler{
		Client: s.cacheClient,
		Config: agentcontroller.RuntimeConfig{
			GatewayURL: "http://127.0.0.1:4183", GatewayTokenAudience: s.cfg.InternalK8sTokenAudience,
		},
	}
	spec, err := compiler.NativeRuntime(ctx, agt, host.NativeEndpoints{
		MCP: "http://127.0.0.1:4181", Inference: "http://127.0.0.1:4182",
		Proxy: "http://127.0.0.1:4184", Platform: "http://127.0.0.1:4183",
		ConfigDirectory:          "/var/lib/agentz/runtime/config",
		BundledSkillsDirectory:   "/var/lib/agentz/runtime/bundle/skills",
		ImmutableSkillsDirectory: "/var/lib/agentz/runtime/skills/immutable",
		WritableSkillsDirectory:  filepath.Join(record.WorkDirectory, ".agents/skills"),
		CABundlePath:             "/var/lib/agentz/runtime/ca.pem",
		GatewayTokenPath:         "/var/lib/agentz/runtime/gateway-token",
		WorkDirectory:            record.WorkDirectory,
	})
	if err != nil {
		return spec, err
	}
	if spec.SecretProxy {
		secret := &corev1.Secret{}
		key := ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: s.cfg.ProxyCASecretName}
		if err := s.k8sClient.Get(ctx, key, secret); err != nil {
			return spec, fmt.Errorf("read proxy CA: %w", err)
		}
		spec.CABundle = secret.Data[s.cfg.ProxyCASecretKey]
		if len(spec.CABundle) == 0 {
			return spec, errors.New("proxy CA bundle is empty")
		}
	}
	return spec, nil
}

func (s *Service) desiredRuntime(ctx context.Context, binding host.Binding) (*hostv1.Runtime, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	spec, err := s.nativeSpec(ctx, binding)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	return &hostv1.Runtime{Generation: hex.EncodeToString(digest[:]), Configuration: data}, nil
}

func (s *Service) observeHost(ctx context.Context, binding host.Binding, state host.Status) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	record, err := s.queries.GatewayComputeHost(ctx, gatewaydb.GatewayComputeHostParams{
		TenantNamespace: binding.Namespace, AgentName: binding.Agent,
	})
	if err != nil {
		return err
	}
	if record.Revoked || record.ID.String() != binding.Epoch {
		return status.Error(codes.PermissionDenied, "host assignment revoked")
	}
	agt := &agentzv1alpha1.Agent{}
	key := ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: binding.Agent}
	if err := s.k8sClient.Get(ctx, key, agt); err != nil {
		return err
	}
	before := agt.DeepCopy()
	patch := ctrlclient.MergeFromWithOptions(before, ctrlclient.MergeFromWithOptimisticLock{})
	if state.Connected {
		session, _ := s.hosts.Connection(binding)
		if session != state.SessionID {
			return status.Error(codes.PermissionDenied, "host session changed")
		}
		count, err := s.queries.GatewayObserveComputeHost(ctx, gatewaydb.GatewayObserveComputeHostParams{
			ID: record.ID, NodeExpiresAt: record.NodeExpiresAt,
		})
		if err != nil {
			return err
		}
		if count != 1 {
			return status.Error(codes.PermissionDenied, "host assignment revoked")
		}
	}
	agt.Status.Hostname = record.Hostname
	agt.Status.RuntimeRoot = record.WorkDirectory
	agt.Status.Connected = state.Connected
	ready := metav1.ConditionFalse
	reason, message := "HostStarting", "Host is preparing the Agent"
	switch {
	case !agt.Status.Connected:
		reason, message = "HostOffline", "Host is offline"
	case state.Error != "":
		reason, message = "HostError", state.Error
	case state.Ready:
		ready = metav1.ConditionTrue
		reason, message = "HostReady", "Agent is running on the connected host"
	}
	agt.Status.SetCondition(metav1.Condition{
		Type: agentzv1alpha1.ConditionTypeReady.String(), Status: ready,
		Reason: reason, Message: message, ObservedGeneration: agt.Generation,
	})
	if reflect.DeepEqual(before.Status, agt.Status) {
		return nil
	}
	err = s.k8sClient.Status().Patch(ctx, agt, patch)
	if apierrors.IsConflict(err) {
		return nil
	}
	return err
}

// streamListener gives net/http one authenticated stream without opening a port.
type streamListener struct {
	conn   net.Conn
	once   sync.Once
	closed sync.Once
	done   chan struct{}
}

// Accept supplies the authenticated connection once.
func (l *streamListener) Accept() (net.Conn, error) {
	var conn net.Conn
	l.once.Do(func() { conn = l.conn })
	if conn != nil {
		return conn, nil
	}
	<-l.done
	return nil, net.ErrClosed
}

// Close unblocks a waiting Accept.
func (l *streamListener) Close() error { l.closed.Do(func() { close(l.done) }); return nil }

// Addr reports the address of the authenticated connection.
func (l *streamListener) Addr() net.Addr { return l.conn.LocalAddr() }

func (s *Service) dialUpstream(ctx context.Context, binding host.Binding, service hostv1.Service) (net.Conn, error) {
	agt := &agentzv1alpha1.Agent{}
	key := ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: binding.Agent}
	if err := s.k8sClient.Get(ctx, key, agt); err != nil {
		return nil, err
	}
	if !agt.DeletionTimestamp.IsZero() || agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		return nil, status.Error(codes.PermissionDenied, "Agent is unavailable")
	}

	if service == hostv1.Service_SERVICE_TRACES {
		local, remote := net.Pipe()
		listener := &streamListener{conn: remote, done: make(chan struct{})}
		server := grpc.NewServer(grpc.MaxRecvMsgSize(4<<20), grpc.MaxConcurrentStreams(4))
		traceServer := observer.NativeTraceServer(binding.Namespace, binding.Agent, s.trace)
		tracev1.RegisterTraceServiceServer(server, traceServer)
		go func() { defer remote.Close(); _ = server.Serve(listener) }()
		go func() { <-ctx.Done(); server.Stop() }()
		return local, nil
	}

	if service == hostv1.Service_SERVICE_SECRET_PROXY {
		if agt.Spec.SecretProxy != nil && !*agt.Spec.SecretProxy {
			return nil, status.Error(codes.PermissionDenied, "secret proxy is disabled")
		}
		address := agt.Name + "-sinjector." + agt.Namespace + ".svc.cluster.local:4096"
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", address)
	}
	sandboxNamespace, err := scope.SelectedNamespace(ctx, s.k8sClient, agt.Namespace, scope.Selection{
		Scope: agt.Spec.SandboxRef.Scope, Kind: agentzv1alpha1.OrganizationResourceKindSandbox,
		Name: agt.Spec.SandboxRef.Name,
	})
	if err != nil {
		return nil, err
	}
	var target, prefix string
	switch service {
	case hostv1.Service_SERVICE_MCP:
		target = "http://" + mcp.GatewayName + "." + sandboxNamespace + ".svc.cluster.local"
		prefix = mcp.AgentRoutePath(agt.Spec.SandboxRef.Name, agt.Namespace, agt.Name)
	case hostv1.Service_SERVICE_INFERENCE:
		target = "http://" + inference.GatewayName + "." + sandboxNamespace + ".svc.cluster.local"
		prefix = "/sandboxes/" + agt.Spec.SandboxRef.Name + "/"
	case hostv1.Service_SERVICE_TELEMETRY:
		target = "http://localhost"
	case hostv1.Service_SERVICE_PLATFORM:
		target = s.cfg.GatewayURL
	default:
		return nil, status.Error(codes.Unimplemented, "unsupported host service")
	}
	upstream, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	local, remote := net.Pipe()
	listener := &streamListener{conn: remote, done: make(chan struct{})}
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(upstream)
		pr.Out.Host = upstream.Host
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Del("Proxy-Authorization")
		pr.Out.Header.Del("X-AgentZ-Tenant-Namespace")
	}}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if service == hostv1.Service_SERVICE_TELEMETRY {
			if r.Method != http.MethodPost || r.URL.Path != "/events" {
				http.NotFound(w, r)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 70<<10)
			var event host.SecurityEvent
			if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
				http.Error(w, "invalid event", http.StatusBadRequest)
				return
			}
			err := observer.NativeSecurityEvent(r.Context(), s.db, binding.Namespace, binding.Agent, event)
			if err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		cleanPath := strings.TrimSuffix(r.URL.Path, "/") == path.Clean(r.URL.Path)
		if prefix != "" && (strings.Contains(r.URL.Path, "\\") || !cleanPath) {
			http.Error(w, "invalid upstream path", http.StatusForbidden)
			return
		}
		assignedRoute := r.URL.Path == prefix || strings.HasPrefix(r.URL.Path, strings.TrimSuffix(prefix, "/")+"/")
		if prefix != "" && !assignedRoute {
			http.Error(w, "route is not assigned to this Agent", http.StatusForbidden)
			return
		}
		if service == hostv1.Service_SERVICE_PLATFORM {
			if r.URL.Path == "/api/compute/skills" && r.Method == http.MethodGet {
				spec, err := s.nativeSpec(r.Context(), binding)
				if err != nil {
					apiutil.WriteInternalError(w, r, err)
					return
				}
				selections := make([]skill.VersionSelection, 0, len(spec.Skills))
				for _, item := range spec.Skills {
					ns := item.Namespace
					if ns == "" {
						ns = binding.Namespace
					}
					selections = append(selections, skill.VersionSelection{
						Namespace: ns, Name: item.Name, Version: item.Version,
					})
				}
				w.Header().Set("Content-Type", "application/zip")
				if err := s.skillStore.WriteVersionsZIP(r.Context(), w, selections); err != nil {
					slog.ErrorContext(r.Context(), "stream native skills", slog.Any("err", err))
				}
				return
			}
			token, err := s.k8s.CoreV1().ServiceAccounts(binding.Namespace).CreateToken(
				r.Context(), binding.Agent, &authenticationv1.TokenRequest{
					Spec: authenticationv1.TokenRequestSpec{
						Audiences:         []string{s.cfg.InternalK8sTokenAudience},
						ExpirationSeconds: ptr.To(int64(600)),
					},
				}, metav1.CreateOptions{},
			)
			if err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			r.Header.Set("Authorization", "Bearer "+token.Status.Token)
		}
		proxy.ServeHTTP(w, r)
	})
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 32 << 10,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() { defer remote.Close(); _ = server.Serve(listener) }()
	go func() { <-ctx.Done(); server.Close() }()
	return local, nil
}
