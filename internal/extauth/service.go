package extauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/sync/singleflight"
	statuspb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	health "google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	baoclient "github.com/accuknox/clawarmor/internal/openbao"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	// DefaultListenAddr is the default gRPC listen address for ext-auth.
	DefaultListenAddr = ":18081"
	// DefaultNamespace is the default namespace for MCP resources.
	DefaultNamespace = "default"

	managedLabelKey      = "clawarmor.accuknox.com/managed"
	managedLabelValue    = "true"
	agentLabelKey        = "clawarmor.accuknox.com/agent"
	appNameLabelKey      = "app.kubernetes.io/name"
	appNameAgent         = "clawarmor-agent"
	sessionHeaderName    = "x-opencode-session-id"
	contextNamespaceKey  = "clawarmor.namespace"
	contextConnectionKey = "clawarmor.mcp_connection"
	kubeRequestTimeout   = 5 * time.Second
	grpcShutdownTimeout  = 15 * time.Second
	httpClientTimeout    = 15 * time.Second
)

var errCredentialUnavailable = errors.New("credential unavailable")

// Config describes how to start the ext-auth gRPC service.
type Config struct {
	Addr                    string
	Namespace               string
	OpenBaoAddr             string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
}

// Serve starts the Envoy-compatible ext-auth gRPC service.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if strings.TrimSpace(cfg.OpenBaoAddr) == "" {
		return fmt.Errorf("openbao addr is required")
	}
	if strings.TrimSpace(cfg.OpenBaoSecretMountPath) == "" {
		return fmt.Errorf("openbao secret mount path is required")
	}
	if strings.TrimSpace(cfg.OpenBaoK8sAuthRole) == "" {
		return fmt.Errorf("openbao k8s auth role is required")
	}

	addr := strings.TrimSpace(cfg.Addr)
	if addr == "" {
		addr = DefaultListenAddr
	}

	namespace := strings.TrimSpace(cfg.Namespace)
	if namespace == "" {
		namespace = DefaultNamespace
	}

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("add core scheme: %w", err)
	}
	if err := clawarmorv1alpha1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("add clawarmor scheme: %w", err)
	}

	kubeCfg, err := ctrlconfig.GetConfig()
	if err != nil {
		return fmt.Errorf("load kube config: %w", err)
	}

	kubeClient, err := ctrlclient.New(kubeCfg, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create kube client: %w", err)
	}

	kubeCore, err := kubernetes.NewForConfig(kubeCfg)
	if err != nil {
		return fmt.Errorf("create kube clientset: %w", err)
	}

	baoClient, err := baoclient.NewClient(
		ctx,
		cfg.OpenBaoAddr,
		cfg.OpenBaoK8sAuthRole,
		cfg.OpenBaoK8sAuthMountPath,
		cfg.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return err
	}

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen ext auth grpc %s: %w", addr, err)
	}

	svc := &Service{
		namespace: namespace,
		kube:      kubeClient,
		kubeCore:  kubeCore,
		kv:        baoClient.KVv2(cfg.OpenBaoSecretMountPath),
		http: &http.Client{
			Timeout: httpClientTimeout,
		},
	}

	srv := grpc.NewServer()
	authv3.RegisterAuthorizationServer(srv, svc)

	healthSrv := health.NewServer()
	healthpb.RegisterHealthServer(srv, healthSrv)
	healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting mcp ext auth service",
			slog.String("addr", addr),
			slog.String("namespace", namespace),
		)
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), grpcShutdownTimeout)
		defer cancel()

		doneCh := make(chan struct{})
		go func() {
			srv.GracefulStop()
			close(doneCh)
		}()

		select {
		case <-doneCh:
		case <-shutdownCtx.Done():
			srv.Stop()
		}

		err = <-errCh
	case err = <-errCh:
	}

	if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
		return fmt.Errorf("serve ext auth grpc: %w", err)
	}
	return nil
}

// Service implements Envoy ext_authz for MCP authorization and credential injection.
type Service struct {
	authv3.UnimplementedAuthorizationServer

	namespace string
	kube      ctrlclient.Client
	kubeCore  kubernetes.Interface
	kv        *baoapi.KVv2
	http      *http.Client
	sf        singleflight.Group
}

var _ authv3.AuthorizationServer = (*Service)(nil)

func (s *Service) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	decision, attrs := s.evaluate(ctx, req)

	logAttrs := []slog.Attr{
		slog.String("namespace", attrs.namespace),
		slog.String("environment", attrs.environment),
		slog.String("connection", attrs.connection),
		slog.String("agent", attrs.agent),
		slog.String("source_ip", attrs.sourceIP),
		slog.String("session_id", attrs.sessionID),
		slog.String("outcome", decision.outcome),
		slog.String("reason", decision.reason),
		slog.Bool("refresh_attempted", attrs.refreshAttempted),
		slog.Bool("refresh_succeeded", attrs.refreshSucceeded),
	}

	switch decision.level {
	case slog.LevelError:
		slog.LogAttrs(ctx, slog.LevelError, "mcp ext auth request completed", logAttrs...)
	case slog.LevelWarn:
		slog.LogAttrs(ctx, slog.LevelWarn, "mcp ext auth request completed", logAttrs...)
	default:
		slog.LogAttrs(ctx, slog.LevelInfo, "mcp ext auth request completed", logAttrs...)
	}

	return decision.response, nil
}

type requestAttrs struct {
	namespace        string
	environment      string
	connection       string
	agent            string
	sourceIP         string
	sessionID        string
	refreshAttempted bool
	refreshSucceeded bool
}

type checkDecision struct {
	response *authv3.CheckResponse
	outcome  string
	reason   string
	level    slog.Level
}

func (s *Service) evaluate(ctx context.Context, req *authv3.CheckRequest) (checkDecision, requestAttrs) {
	attrs := requestAttrs{
		namespace: s.namespace,
	}

	checkAttrs := req.GetAttributes()
	if checkAttrs == nil {
		return denyDecision(
			codes.InvalidArgument,
			typev3.StatusCode_BadRequest,
			"invalid ext auth request",
			"missing_attributes",
			slog.LevelWarn,
		), attrs
	}

	connName := strings.TrimSpace(checkAttrs.GetContextExtensions()[contextConnectionKey])
	if connName == "" {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"mcp connection context is missing",
			"missing_connection_context",
			slog.LevelError,
		), attrs
	}
	attrs.connection = connName

	if ns := strings.TrimSpace(checkAttrs.GetContextExtensions()[contextNamespaceKey]); ns != "" {
		attrs.namespace = ns
	}

	httpReq := requestHTTP(checkAttrs)
	if httpReq == nil {
		return denyDecision(
			codes.InvalidArgument,
			typev3.StatusCode_BadRequest,
			"invalid ext auth request",
			"missing_http_request",
			slog.LevelWarn,
		), attrs
	}

	sessionID := strings.TrimSpace(httpReq.GetHeaders()[sessionHeaderName])
	attrs.sessionID = sessionID

	sourceIP, err := peerAddress(checkAttrs.GetSource())
	if err != nil {
		return denyDecision(
			codes.PermissionDenied,
			typev3.StatusCode_Forbidden,
			"request source is not allowed",
			"missing_source_ip",
			slog.LevelWarn,
		), attrs
	}
	attrs.sourceIP = sourceIP

	agentName, environmentName, err := s.authorizeSourceAgent(ctx, attrs.namespace, attrs.sourceIP, connName)
	if err != nil {
		if errors.Is(err, errCredentialUnavailable) {
			return denyDecision(
				codes.Unavailable,
				typev3.StatusCode_ServiceUnavailable,
				"mcp connection is unavailable",
				"authorization_lookup_failed",
				slog.LevelError,
			), attrs
		}
		return denyDecision(
			codes.PermissionDenied,
			typev3.StatusCode_Forbidden,
			"request is not allowed for this mcp connection",
			"agent_not_authorized",
			slog.LevelWarn,
		), attrs
	}
	attrs.agent = agentName
	attrs.environment = environmentName

	conn, err := s.loadConnection(ctx, attrs.namespace, connName)
	if err != nil {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"mcp connection is unavailable",
			"connection_lookup_failed",
			slog.LevelError,
		), attrs
	}

	header, err := s.resolveInjectedHeader(ctx, conn, &attrs)
	if err != nil {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"mcp connection is unavailable",
			"credential_resolution_failed",
			slog.LevelError,
		), attrs
	}

	return allowDecision(header.name, header.value), attrs
}

func (s *Service) authorizeSourceAgent(ctx context.Context, namespace, sourceIP, connName string) (string, string, error) {
	pod, err := s.lookupAgentPodByIP(ctx, namespace, sourceIP)
	if err != nil {
		return "", "", err
	}

	agentName := strings.TrimSpace(pod.Labels[agentLabelKey])
	if agentName == "" {
		return "", "", fmt.Errorf("agent label is missing on pod %s", pod.Name)
	}

	agentCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	agent := &clawarmorv1alpha1.Agent{}
	agentKey := ctrlclient.ObjectKey{
		Namespace: namespace,
		Name:      agentName,
	}
	if err := s.kube.Get(agentCtx, agentKey, agent); err != nil {
		if apierrors.IsNotFound(err) {
			return "", "", fmt.Errorf("agent %q does not exist", agentName)
		}
		return "", "", fmt.Errorf(
			"get agent %q: %w: %w",
			agentName,
			err,
			errCredentialUnavailable,
		)
	}

	if agent.Spec.EnvironmentRef == nil || strings.TrimSpace(agent.Spec.EnvironmentRef.Name) == "" {
		return "", "", fmt.Errorf("agent %q has no environment", agentName)
	}
	environmentName := strings.TrimSpace(agent.Spec.EnvironmentRef.Name)

	envCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	env := &clawarmorv1alpha1.Environment{}
	envKey := ctrlclient.ObjectKey{
		Namespace: namespace,
		Name:      environmentName,
	}
	if err := s.kube.Get(envCtx, envKey, env); err != nil {
		if apierrors.IsNotFound(err) {
			return "", "", fmt.Errorf("environment %q does not exist", environmentName)
		}
		return "", "", fmt.Errorf(
			"get environment %q: %w: %w",
			environmentName,
			err,
			errCredentialUnavailable,
		)
	}

	hasConnection := slices.ContainsFunc(env.Spec.MCPConnectionRefs, func(ref clawarmorv1alpha1.MCPConnectionRef) bool {
		return ref.Name == connName
	})
	if !hasConnection {
		return "", "", fmt.Errorf("environment %q does not include mcp connection %q", environmentName, connName)
	}

	return agentName, environmentName, nil
}

func (s *Service) lookupAgentPodByIP(ctx context.Context, namespace, ip string) (*corev1.Pod, error) {
	podCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	opts := metav1.ListOptions{
		FieldSelector: fields.OneTermEqualSelector("status.podIP", ip).String(),
		LabelSelector: strings.Join([]string{
			managedLabelKey + "=" + managedLabelValue,
			appNameLabelKey + "=" + appNameAgent,
		}, ","),
	}

	pods, err := s.kubeCore.CoreV1().Pods(namespace).List(podCtx, opts)
	if err != nil {
		return nil, fmt.Errorf("list pods for ip %q: %w: %w", ip, err, errCredentialUnavailable)
	}
	if len(pods.Items) != 1 {
		return nil, fmt.Errorf("expected 1 agent pod for ip %q, got %d", ip, len(pods.Items))
	}

	pod := pods.Items[0]
	return &pod, nil
}

func (s *Service) loadConnection(ctx context.Context, namespace, name string) (*clawarmorv1alpha1.MCPConnection, error) {
	connCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	conn := &clawarmorv1alpha1.MCPConnection{}
	key := ctrlclient.ObjectKey{
		Namespace: namespace,
		Name:      name,
	}
	if err := s.kube.Get(connCtx, key, conn); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("mcp connection %q does not exist: %w", name, errCredentialUnavailable)
		}
		return nil, fmt.Errorf("get mcp connection %q: %w: %w", name, err, errCredentialUnavailable)
	}
	return conn, nil
}

type injectedHeader struct {
	name  string
	value string
}

func (s *Service) resolveInjectedHeader(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection, attrs *requestAttrs) (injectedHeader, error) {
	if conn.Spec.Auth == nil {
		return injectedHeader{}, fmt.Errorf("mcp connection %q has no auth mode: %w", conn.Name, errCredentialUnavailable)
	}

	switch {
	case conn.Spec.Auth.Bearer != nil:
		return s.resolveBearerHeader(ctx, conn)
	case conn.Spec.Auth.OAuth != nil:
		return s.resolveOAuthHeader(ctx, conn, attrs)
	default:
		return injectedHeader{}, fmt.Errorf("mcp connection %q has no supported auth mode: %w", conn.Name, errCredentialUnavailable)
	}
}

func (s *Service) resolveBearerHeader(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection) (injectedHeader, error) {
	auth := conn.Spec.Auth.Bearer
	if auth == nil || auth.SecretRef == nil {
		return injectedHeader{}, fmt.Errorf("bearer secret ref is missing: %w", errCredentialUnavailable)
	}

	location, err := headerLocation(auth.Location)
	if err != nil {
		return injectedHeader{}, err
	}

	record, err := s.readBearerRecord(ctx, *auth.SecretRef)
	if err != nil {
		return injectedHeader{}, err
	}

	token := strings.TrimSpace(record.Token)
	if token == "" {
		return injectedHeader{}, fmt.Errorf("bearer token is missing: %w", errCredentialUnavailable)
	}

	return injectedHeader{
		name:  location.name,
		value: prefixedValue(location.prefix, token),
	}, nil
}

func requestHTTP(attrs *authv3.AttributeContext) *authv3.AttributeContext_HttpRequest {
	request := attrs.GetRequest()
	if request == nil {
		return nil
	}
	return request.GetHttp()
}

func peerAddress(peer *authv3.AttributeContext_Peer) (string, error) {
	if peer == nil || peer.GetAddress() == nil {
		return "", fmt.Errorf("peer address is missing")
	}

	socketAddr := peer.GetAddress().GetSocketAddress()
	if socketAddr == nil {
		return "", fmt.Errorf("peer socket address is missing")
	}

	addr := strings.TrimSpace(socketAddr.GetAddress())
	if addr == "" {
		return "", fmt.Errorf("peer socket address is empty")
	}
	return addr, nil
}

type authHeaderLocation struct {
	name   string
	prefix string
}

func headerLocation(location *clawarmorv1alpha1.MCPConnectionAuthLocation) (authHeaderLocation, error) {
	if location == nil || location.Header == nil {
		return authHeaderLocation{
			name:   "Authorization",
			prefix: "Bearer",
		}, nil
	}
	if location.QueryParameter != nil || location.Cookie != nil {
		return authHeaderLocation{}, fmt.Errorf("only header auth locations are supported: %w", errCredentialUnavailable)
	}

	name := strings.TrimSpace(location.Header.Name)
	if name == "" {
		name = "Authorization"
	}

	prefix := "Bearer"
	if location.Header.Prefix != nil {
		prefix = strings.TrimSpace(*location.Header.Prefix)
	}

	return authHeaderLocation{
		name:   name,
		prefix: prefix,
	}, nil
}

func prefixedValue(prefix string, token string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		return token
	}
	return prefix + " " + token
}

func allowDecision(headerName, headerValue string) checkDecision {
	return checkDecision{
		response: &authv3.CheckResponse{
			Status: &statuspb.Status{
				Code: int32(codes.OK),
			},
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: &authv3.OkHttpResponse{
					Headers: []*corev3.HeaderValueOption{{
						Header: &corev3.HeaderValue{
							Key:   headerName,
							Value: headerValue,
						},
					}},
				},
			},
		},
		outcome: "allow",
		reason:  "authorized",
		level:   slog.LevelInfo,
	}
}

func denyDecision(code codes.Code, httpCode typev3.StatusCode, message string, reason string, level slog.Level) checkDecision {
	return checkDecision{
		response: &authv3.CheckResponse{
			Status: &statuspb.Status{
				Code:    int32(code),
				Message: message,
			},
			HttpResponse: &authv3.CheckResponse_DeniedResponse{
				DeniedResponse: &authv3.DeniedHttpResponse{
					Status: &typev3.HttpStatus{
						Code: httpCode,
					},
					Body: message,
					Headers: []*corev3.HeaderValueOption{{
						Header: &corev3.HeaderValue{
							Key:   "content-type",
							Value: "text/plain; charset=utf-8",
						},
					}},
				},
			},
		},
		outcome: "deny",
		reason:  reason,
		level:   level,
	}
}
