package gateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/utils/ptr"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/compute"
	computev1 "github.com/accuknox/agentz/internal/compute/proto"
	agentcontroller "github.com/accuknox/agentz/internal/controller/agent"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/observer"
	"github.com/accuknox/agentz/internal/scope"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// CreateComputeEnrollment issues a short, single-use bootstrap for an authored Agent.
func (s *Service) CreateComputeEnrollment(w http.ResponseWriter, r *http.Request, agentName string, _ gatewayapi.CreateComputeEnrollmentParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUpdateAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if s.computeIdentity == nil {
		apiutil.WriteError(w, r, apiutil.NewError(503, "compute_unavailable", "Host enrollment is not configured", nil))
		return
	}
	agt := &agentzv1alpha1.Agent{}
	err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: agentName}, agt)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get Agent", err))
		return
	}
	if agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		apiutil.WriteError(w, r, apiutil.NewError(409, "execution_conflict", "This Agent uses Kubernetes compute", nil))
		return
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	code := base64.RawURLEncoding.EncodeToString(secret)
	hash := sha256.Sum256([]byte(code))
	expires := time.Now().Add(15 * time.Minute)
	_, err = s.queries.GatewayPrepareComputeEnrollment(r.Context(), gatewaydb.GatewayPrepareComputeEnrollmentParams{
		ID: uuid.New(), TenantNamespace: access.namespace, AgentName: agentName,
		EnrollmentHash: hash[:], EnrollmentExpiresAt: expires,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteError(w, r, apiutil.NewError(409, "host_already_enrolled", "Disconnect the current host before enrolling another", nil))
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	apiutil.WriteJSON(w, http.StatusCreated, gatewayapi.ComputeEnrollment{Code: code, ExpiresAt: expires})
}

// RedeemComputeEnrollment exchanges the one-time code for native SPIRE bootstrap.
func (s *Service) RedeemComputeEnrollment(w http.ResponseWriter, r *http.Request) {
	if s.computeIdentity == nil {
		apiutil.WriteError(w, r, apiutil.NewError(503, "compute_unavailable", "Host enrollment is not configured", nil))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req gatewayapi.RedeemComputeEnrollmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	validHost := len(req.Hostname) > 0 && len(req.Hostname) <= 253
	validDirectory := filepath.IsAbs(req.WorkDirectory) && req.WorkDirectory != "/" &&
		filepath.Clean(req.WorkDirectory) == req.WorkDirectory && len(req.WorkDirectory) <= 4096 &&
		!strings.ContainsAny(req.WorkDirectory, "\x00\r\n")
	if len(req.Code) != 43 || !validHost || !validDirectory {
		apiutil.WriteError(w, r, apiutil.NewError(400, "invalid_request", "Invalid enrollment details", nil))
		return
	}
	hash := sha256.Sum256([]byte(req.Code))
	host, err := s.queries.GatewayConsumeComputeEnrollment(r.Context(), gatewaydb.GatewayConsumeComputeEnrollmentParams{
		EnrollmentHash: hash[:], Hostname: req.Hostname, WorkDirectory: req.WorkDirectory,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteError(w, r, apiutil.NewError(401, "invalid_enrollment", "Enrollment code has expired or was already used", nil))
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	agt := &agentzv1alpha1.Agent{}
	err = s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: host.TenantNamespace, Name: host.AgentName}, agt)
	if err != nil || !agt.DeletionTimestamp.IsZero() || agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		apiutil.WriteError(w, r, apiutil.NewError(409, "agent_unavailable", "Agent is no longer available for enrollment", err))
		return
	}
	enrollment, err := s.computeIdentity.Enroll(r.Context(), host.ID.String(), 0, compute.DaemonExecutable)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	count, err := s.queries.GatewayBindComputeHost(r.Context(), gatewaydb.GatewayBindComputeHostParams{
		ID: host.ID, NodeID: enrollment.NodeID, WorkloadID: enrollment.WorkloadID,
	})
	if err != nil || count != 1 {
		revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
		defer cancel()
		revokeErr := s.computeIdentity.Revoke(revokeCtx, enrollment.NodeID, enrollment.WorkloadID)
		apiutil.WriteInternalError(w, r, errors.Join(err, revokeErr, errors.New("enrollment was replaced or revoked")))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.RedeemComputeEnrollmentResponse{
		JoinToken: enrollment.JoinToken, TrustDomain: s.cfg.ComputeTrustDomain,
		TrustBundle: enrollment.TrustBundle, WorkloadId: enrollment.WorkloadID,
		SpireServer: s.cfg.ComputeSPIREPublicAddress, ComputeServer: s.cfg.ComputePublicAddress,
	})
}

// RevokeComputeHost disconnects the host and bans its native SPIRE node.
func (s *Service) RevokeComputeHost(w http.ResponseWriter, r *http.Request, agentName string, _ gatewayapi.RevokeComputeHostParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUpdateAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if err := s.revokeCompute(r.Context(), access.namespace, agentName); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) revokeCompute(ctx context.Context, namespace, name string) error {
	host, err := s.queries.GatewayRevokeComputeHost(ctx, gatewaydb.GatewayRevokeComputeHostParams{TenantNamespace: namespace, AgentName: name})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if s.computeServer != nil {
		s.computeServer.Revoke(namespace, name)
	}
	var revokeErr error
	if s.computeIdentity != nil && host.NodeID != "" {
		revokeErr = s.computeIdentity.Revoke(ctx, host.NodeID, host.WorkloadID)
	}
	agt := &agentzv1alpha1.Agent{}
	err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, agt)
	if err != nil {
		return errors.Join(revokeErr, ctrlclient.IgnoreNotFound(err))
	}
	patch := ctrlclient.MergeFrom(agt.DeepCopy())
	agt.Status.Connected = false
	agt.Status.Hostname = ""
	agt.Status.RuntimeRoot = ""
	agt.Status.SetCondition(metav1.Condition{
		Type: agentzv1alpha1.ConditionTypeReady.String(), Status: metav1.ConditionFalse,
		Reason: "HostRevoked", Message: "Host disconnected. Enroll again to reconnect.",
		ObservedGeneration: agt.Generation,
	})
	return errors.Join(revokeErr, s.k8sClient.Status().Patch(ctx, agt, patch))
}

func (s *Service) startCompute(ctx context.Context) (func(), error) {
	if s.cfg.ComputeAddr == "" {
		return func() {}, nil
	}
	if s.cfg.ComputePublicAddress == "" || s.cfg.ComputeSPIREPublicAddress == "" {
		return nil, errors.New("compute public and SPIRE addresses are required")
	}
	identity, err := compute.NewIdentityAdmin(s.cfg.ComputeSPIRESocket, s.cfg.ComputeTrustDomain)
	if err != nil {
		return nil, err
	}
	var config *tls.Config
	var identityErr error
	err = wait.PollUntilContextTimeout(ctx, time.Second, time.Minute, true, func(attempt context.Context) (bool, error) {
		config, identityErr = identity.ServerTLS(attempt)
		return identityErr == nil, nil
	})
	if err != nil {
		identity.Close()
		return nil, errors.Join(err, identityErr)
	}
	listener, err := net.Listen("tcp", s.cfg.ComputeAddr)
	if err != nil {
		identity.Close()
		return nil, err
	}
	traceConnection, err := grpc.NewClient(s.cfg.AgentTraceEndpoint, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		listener.Close()
		identity.Close()
		return nil, err
	}
	s.computeTrace = tracev1.NewTraceServiceClient(traceConnection)
	s.computeIdentity = identity
	s.computeServer = compute.NewServer(compute.Callbacks{
		Authorize: s.authorizeCompute, Desired: s.computeRuntime,
		Observe: s.observeCompute, DialUpstream: s.computeUpstream,
	})
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(config)), grpc.MaxRecvMsgSize(64<<10), grpc.MaxSendMsgSize(4<<20), grpc.MaxConcurrentStreams(128))
	computev1.RegisterComputeServer(server, s.computeServer)
	runCtx, cancel := context.WithCancel(ctx)
	go func() {
		if err := identity.Maintain(runCtx); err != nil && runCtx.Err() == nil {
			slog.ErrorContext(runCtx, "maintain compute identity", slog.Any("err", err))
			server.Stop()
		}
	}()
	go func() {
		if err := server.Serve(listener); err != nil && runCtx.Err() == nil {
			slog.ErrorContext(runCtx, "serve compute", slog.Any("err", err))
		}
	}()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(request *http.Request) (*url.URL, error) {
		if strings.HasSuffix(request.URL.Hostname(), ".native.agentz") {
			return nil, nil
		}
		return http.ProxyFromEnvironment(request)
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		hostname, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if !strings.HasSuffix(hostname, ".native.agentz") {
			return dialer.DialContext(ctx, network, address)
		}
		parts := strings.Split(strings.TrimSuffix(hostname, ".native.agentz"), ".")
		if len(parts) != 3 {
			return nil, errors.New("invalid native Agent address")
		}
		service := "opencode"
		switch port {
		case "4096":
		case "4097":
			service = "filesystem"
		default:
			return nil, errors.New("invalid native service")
		}
		return s.computeServer.DialConnection(ctx, parts[1], parts[0], service, parts[2])
	}
	s.outboundHTTP.Transport = &computeHTTPTransport{server: s.computeServer, transport: transport}
	return func() {
		cancel()
		server.Stop()
		identity.Close()
		traceConnection.Close()
		transport.CloseIdleConnections()
	}, nil
}

type computeHTTPTransport struct {
	server    *compute.Server
	transport *http.Transport
}

// RoundTrip keys HTTP connection pooling by the live control connection. An
// earlier queued admission cannot be replayed onto a newly connected runtime.
func (t *computeHTTPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if !strings.HasSuffix(request.URL.Hostname(), ".native.agentz") {
		return t.transport.RoundTrip(request)
	}
	parts := strings.Split(strings.TrimSuffix(request.URL.Hostname(), ".native.agentz"), ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid native Agent address")
	}
	connection, ready := t.server.Connection(parts[1], parts[0])
	if !ready {
		return nil, errors.New("native Agent is offline")
	}
	if expected := request.Header.Get("X-Agentz-Compute-Connection"); expected != "" && expected != connection {
		return nil, errors.New("native Agent reconnected; submit new work explicitly")
	}
	if expected, _ := request.Context().Value(computeConnectionContextKey{}).(string); expected != "" && expected != connection {
		return nil, errors.New("native Agent reconnected; submit new work explicitly")
	}
	forward := request.Clone(request.Context())
	forward.Header.Del("X-Agentz-Compute-Connection")
	forward.URL.Host = net.JoinHostPort(parts[0]+"."+parts[1]+"."+connection+".native.agentz", request.URL.Port())
	return t.transport.RoundTrip(forward)
}

func (s *Service) authorizeCompute(ctx context.Context) (compute.Binding, error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return compute.Binding{}, status.Error(codes.Unauthenticated, "missing TLS peer")
	}
	// go-spiffe verifies the chain in its TLS callback, so VerifiedChains is empty.
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.PeerCertificates) == 0 || len(tlsInfo.State.PeerCertificates[0].URIs) != 1 {
		return compute.Binding{}, status.Error(codes.Unauthenticated, "missing verified identity")
	}
	id, err := spiffeid.FromURI(tlsInfo.State.PeerCertificates[0].URIs[0])
	if err != nil {
		return compute.Binding{}, status.Error(codes.Unauthenticated, "invalid SPIFFE identity")
	}
	host, err := s.queries.GatewayComputeIdentity(ctx, id.String())
	if err != nil {
		return compute.Binding{}, status.Error(codes.PermissionDenied, "host is not assigned")
	}
	agt := &agentzv1alpha1.Agent{}
	err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: host.TenantNamespace, Name: host.AgentName}, agt)
	if err != nil || !agt.DeletionTimestamp.IsZero() || agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		return compute.Binding{}, status.Error(codes.PermissionDenied, "Agent is unavailable")
	}
	return compute.Binding{Namespace: host.TenantNamespace, Agent: host.AgentName, Epoch: host.ID.String()}, nil
}

func (s *Service) nativeSpec(ctx context.Context, binding compute.Binding) (compute.RuntimeSpec, error) {
	host, err := s.queries.GatewayComputeHost(ctx, gatewaydb.GatewayComputeHostParams{TenantNamespace: binding.Namespace, AgentName: binding.Agent})
	if err != nil {
		return compute.RuntimeSpec{}, err
	}
	if host.Revoked || host.ID.String() != binding.Epoch {
		return compute.RuntimeSpec{}, status.Error(codes.PermissionDenied, "host assignment revoked")
	}
	agt := &agentzv1alpha1.Agent{}
	if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: binding.Agent}, agt); err != nil {
		return compute.RuntimeSpec{}, err
	}
	if !agt.DeletionTimestamp.IsZero() {
		return compute.RuntimeSpec{}, status.Error(codes.PermissionDenied, "Agent deleted")
	}
	compiler := agentcontroller.Reconciler{
		Client: s.computeClient,
		Config: agentcontroller.RuntimeConfig{
			GatewayURL: "http://127.0.0.1:4183", GatewayTokenAudience: s.cfg.InternalK8sTokenAudience,
		},
	}
	spec, err := compiler.NativeRuntime(ctx, agt, compute.NativeEndpoints{
		MCP: "http://127.0.0.1:4181", Inference: "http://127.0.0.1:4182",
		Proxy: "http://127.0.0.1:4184", Platform: "http://127.0.0.1:4183",
		ConfigDirectory:          "/var/lib/agentz/runtime/config",
		BundledSkillsDirectory:   "/var/lib/agentz/runtime/bundle/skills",
		ImmutableSkillsDirectory: "/var/lib/agentz/runtime/skills/immutable",
		WritableSkillsDirectory:  filepath.Join(host.WorkDirectory, ".agents/skills"),
		CABundlePath:             "/var/lib/agentz/runtime/ca.pem",
		GatewayTokenPath:         "/var/lib/agentz/runtime/gateway-token", WorkDirectory: host.WorkDirectory,
	})
	if err != nil {
		return spec, err
	}
	if spec.SecretProxy {
		secret := &corev1.Secret{}
		if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: s.cfg.ComputeCASecretName}, secret); err != nil {
			return spec, fmt.Errorf("read proxy CA: %w", err)
		}
		spec.CABundle = secret.Data[s.cfg.ComputeCASecretKey]
		if len(spec.CABundle) == 0 {
			return spec, errors.New("proxy CA bundle is empty")
		}
	}
	return spec, nil
}

func (s *Service) computeRuntime(ctx context.Context, binding compute.Binding) (*computev1.Runtime, error) {
	spec, err := s.nativeSpec(ctx, binding)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	return &computev1.Runtime{Generation: hex.EncodeToString(digest[:]), Configuration: data}, nil
}

func (s *Service) observeCompute(ctx context.Context, binding compute.Binding, state compute.Status) error {
	host, err := s.queries.GatewayComputeHost(ctx, gatewaydb.GatewayComputeHostParams{TenantNamespace: binding.Namespace, AgentName: binding.Agent})
	if err != nil {
		return err
	}
	if host.Revoked || host.ID.String() != binding.Epoch {
		return status.Error(codes.PermissionDenied, "host assignment revoked")
	}
	expires, err := s.computeIdentity.Validate(ctx, host.NodeID)
	if err != nil {
		return err
	}
	_, err = s.queries.GatewayObserveComputeHost(ctx, gatewaydb.GatewayObserveComputeHostParams{ID: host.ID, NodeExpiresAt: expires})
	if err != nil {
		return err
	}
	agt := &agentzv1alpha1.Agent{}
	if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: binding.Agent}, agt); err != nil {
		return err
	}
	before := agt.DeepCopy()
	patch := ctrlclient.MergeFrom(before)
	agt.Status.Hostname = host.Hostname
	agt.Status.RuntimeRoot = host.WorkDirectory
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
	return s.k8sClient.Status().Patch(ctx, agt, patch)
}

// computeListener gives net/http one authenticated stream without opening a port.
type computeListener struct {
	conn   net.Conn
	once   sync.Once
	closed sync.Once
	done   chan struct{}
}

// Accept supplies the authenticated connection once.
func (l *computeListener) Accept() (net.Conn, error) {
	var conn net.Conn
	l.once.Do(func() { conn = l.conn })
	if conn != nil {
		return conn, nil
	}
	<-l.done
	return nil, net.ErrClosed
}

// Close unblocks a waiting Accept.
func (l *computeListener) Close() error { l.closed.Do(func() { close(l.done) }); return nil }

// Addr reports the address of the authenticated connection.
func (l *computeListener) Addr() net.Addr { return l.conn.LocalAddr() }

func (s *Service) computeUpstream(ctx context.Context, binding compute.Binding, service computev1.Service) (net.Conn, error) {
	agt := &agentzv1alpha1.Agent{}
	if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: binding.Namespace, Name: binding.Agent}, agt); err != nil {
		return nil, err
	}
	if !agt.DeletionTimestamp.IsZero() || agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		return nil, status.Error(codes.PermissionDenied, "Agent is unavailable")
	}

	if service == computev1.Service_SERVICE_TRACES {
		local, remote := net.Pipe()
		listener := &computeListener{conn: remote, done: make(chan struct{})}
		server := grpc.NewServer(grpc.MaxRecvMsgSize(4<<20), grpc.MaxConcurrentStreams(4))
		tracev1.RegisterTraceServiceServer(server, observer.NativeTraceServer(binding.Namespace, binding.Agent, s.computeTrace))
		go func() { defer remote.Close(); _ = server.Serve(listener) }()
		go func() { <-ctx.Done(); server.Stop() }()
		return local, nil
	}

	if service == computev1.Service_SERVICE_SECRET_PROXY {
		if agt.Spec.SecretProxy != nil && !*agt.Spec.SecretProxy {
			return nil, status.Error(codes.PermissionDenied, "secret proxy is disabled")
		}
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", agt.Name+"-sinjector."+agt.Namespace+".svc.cluster.local:4096")
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
	case computev1.Service_SERVICE_MCP:
		target = "http://" + mcp.GatewayName + "." + sandboxNamespace + ".svc.cluster.local"
		prefix = mcp.AgentRoutePath(agt.Spec.SandboxRef.Name, agt.Namespace, agt.Name)
	case computev1.Service_SERVICE_INFERENCE:
		target = "http://" + inference.GatewayName + "." + sandboxNamespace + ".svc.cluster.local"
		prefix = "/sandboxes/" + agt.Spec.SandboxRef.Name + "/"
	case computev1.Service_SERVICE_TELEMETRY:
		target = "http://localhost"
	case computev1.Service_SERVICE_PLATFORM:
		host, port, err := net.SplitHostPort(s.cfg.Addr)
		if err != nil {
			return nil, err
		}
		if host == "" || host == "0.0.0.0" || host == "::" {
			host = "127.0.0.1"
		}
		target = "http://" + net.JoinHostPort(host, port)
	default:
		return nil, status.Error(codes.Unimplemented, "unsupported host service")
	}
	upstream, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	local, remote := net.Pipe()
	listener := &computeListener{conn: remote, done: make(chan struct{})}
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(upstream)
		pr.Out.Host = upstream.Host
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Del("Proxy-Authorization")
		pr.Out.Header.Del(internalTenantNamespaceHeader)
	}}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if service == computev1.Service_SERVICE_TELEMETRY {
			if r.Method != http.MethodPost || r.URL.Path != "/events" {
				http.NotFound(w, r)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 70<<10)
			var event compute.SecurityEvent
			if !decodeJSONBody(w, r, &event, false) {
				return
			}
			if err := observer.NativeSecurityEvent(r.Context(), s.db, binding.Namespace, binding.Agent, event); err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if prefix != "" && (strings.Contains(r.URL.Path, "\\") || strings.TrimSuffix(r.URL.Path, "/") != path.Clean(r.URL.Path)) {
			http.Error(w, "invalid upstream path", http.StatusForbidden)
			return
		}
		if prefix != "" && r.URL.Path != prefix && !strings.HasPrefix(r.URL.Path, strings.TrimSuffix(prefix, "/")+"/") {
			http.Error(w, "route is not assigned to this Agent", http.StatusForbidden)
			return
		}
		if service == computev1.Service_SERVICE_PLATFORM {
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
					selections = append(selections, skill.VersionSelection{Namespace: ns, Name: item.Name, Version: item.Version})
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
