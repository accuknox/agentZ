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
	"sync"
	"syscall"
	"time"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/sync/errgroup"
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
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	"github.com/accuknox/agentz/internal/mcp"
	baoclient "github.com/accuknox/agentz/internal/openbao"
	"github.com/accuknox/agentz/internal/scoperesolver"
	mcpconnwebhook "github.com/accuknox/agentz/internal/webhook/v1alpha1/mcpconn"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	agentzclientset "github.com/accuknox/agentz/pkg/controller/clientset/versioned"
	agentzinformers "github.com/accuknox/agentz/pkg/controller/informers/externalversions"
	agentzlisters "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
)

const (
	// DefaultListenAddr is the default gRPC listen address for ext-auth.
	DefaultListenAddr = ":18081"
	// DefaultNamespace is the default namespace for authorized resources.
	DefaultNamespace = "default"
	// DefaultMCPProbeInterval bounds how often MCP health is refreshed.
	DefaultMCPProbeInterval = time.Minute * 2
	// DefaultMCPProbeTimeout bounds one end-to-end MCP probe.
	DefaultMCPProbeTimeout = 15 * time.Second

	managedLabelKey      = "agentz.accuknox.com/managed"
	managedLabelValue    = "true"
	agentLabelKey        = "agentz.accuknox.com/agent"
	appNameLabelKey      = "app.kubernetes.io/name"
	appNameAgent         = "agentz-agent"
	sessionHeaderName    = "x-opencode-session-id"
	contextNamespaceKey  = "agentz.namespace"
	contextSandboxKey    = "agentz.sandbox"
	contextConnectionKey = "agentz.mcp_connection"
	contextProviderKey   = "agentz.inference_provider"
	contextPoolKey       = "agentz.inference_pool"
	kubeRequestTimeout   = 5 * time.Second
	grpcShutdownTimeout  = 15 * time.Second
	httpClientTimeout    = 15 * time.Second
	probeQueueName       = "extauth-mcp-probe"
)

var (
	errCredentialPending     = errors.New("credential pending")
	errCredentialUnavailable = errors.New("credential unavailable")
)

// Config describes how to start the ext-auth gRPC service.
type Config struct {
	Addr                    string
	Namespace               string
	SourceNamespaces        []string
	OpenBaoAddr             string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
	MCPProbeInterval        time.Duration
	MCPProbeTimeout         time.Duration
}

// Serve starts the Envoy-compatible ext-auth gRPC service.
//
//nolint:gocyclo
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	if strings.TrimSpace(cfg.OpenBaoAddr) == "" {
		return fmt.Errorf("openbao addr is required")
	}
	if strings.TrimSpace(cfg.OpenBaoSecretMountPath) == "" {
		return fmt.Errorf("openbao secret mount path is required")
	}
	if strings.TrimSpace(cfg.OpenBaoK8sAuthRole) == "" {
		return fmt.Errorf("openbao k8s auth role is required")
	}
	if cfg.MCPProbeInterval <= 0 {
		return fmt.Errorf("mcp probe interval must be greater than zero")
	}
	if cfg.MCPProbeTimeout <= 0 {
		return fmt.Errorf("mcp probe timeout must be greater than zero")
	}

	addr := strings.TrimSpace(cfg.Addr)
	if addr == "" {
		addr = DefaultListenAddr
	}

	namespace := strings.TrimSpace(cfg.Namespace)
	if namespace == "" {
		namespace = DefaultNamespace
	}
	sourceNamespaces := make([]string, 1, len(cfg.SourceNamespaces)+1)
	sourceNamespaces[0] = namespace
	for _, sourceNamespace := range cfg.SourceNamespaces {
		sourceNamespace = strings.TrimSpace(sourceNamespace)
		if sourceNamespace != "" {
			sourceNamespaces = append(sourceNamespaces, sourceNamespace)
		}
	}
	slices.Sort(sourceNamespaces)
	sourceNamespaces = slices.Compact(sourceNamespaces)

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("add core scheme: %w", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("add agentz scheme: %w", err)
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
	agentzClient, err := agentzclientset.NewForConfig(kubeCfg)
	if err != nil {
		return fmt.Errorf("create agentz clientset: %w", err)
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
	mcpAddr := fmt.Sprintf(":%d", mcp.ExtAuthMCPPort)
	mcpListener, err := net.Listen("tcp", mcpAddr)
	if err != nil {
		return fmt.Errorf("listen ext auth mcp %s: %w", mcpAddr, err)
	}

	svc := &Service{
		namespace:        namespace,
		sourceNamespaces: sourceNamespaces,
		probeInterval:    cfg.MCPProbeInterval,
		probeTimeout:     cfg.MCPProbeTimeout,
		kube:             kubeClient,
		kubeCore:         kubeCore,
		kv:               baoClient.KVv2(cfg.OpenBaoSecretMountPath),
		http: &http.Client{
			Timeout: httpClientTimeout,
		},
		probeQueue: workqueue.NewTypedWithConfig(workqueue.TypedQueueConfig[string]{
			Name: probeQueueName,
		}),
	}

	informerFactory := agentzinformers.NewSharedInformerFactoryWithOptions(
		agentzClient,
		cfg.MCPProbeInterval,
		agentzinformers.WithNamespace(namespace),
	)
	mcpInformer := informerFactory.Agentz().V1alpha1().MCPConnections()
	svc.mcpConnections = mcpInformer.Lister().MCPConnections(namespace)
	svc.probeTimes = map[string]time.Time{}

	mcpInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj any) {
			conn, ok := obj.(*agentzv1alpha1.MCPConnection)
			if !ok {
				return
			}
			if name := strings.TrimSpace(conn.Name); name != "" {
				svc.probeQueue.Add(name)
			}
		},
		UpdateFunc: func(oldObj, newObj any) {
			oldConn, ok := oldObj.(*agentzv1alpha1.MCPConnection)
			if !ok {
				return
			}
			newConn, ok := newObj.(*agentzv1alpha1.MCPConnection)
			if !ok {
				return
			}
			if oldConn.Generation == newConn.Generation {
				return
			}
			if name := strings.TrimSpace(newConn.Name); name != "" {
				svc.probeQueue.Add(name)
			}
		},
		DeleteFunc: func(obj any) {
			conn, ok := obj.(*agentzv1alpha1.MCPConnection)
			if !ok {
				tombstone, ok := obj.(cache.DeletedFinalStateUnknown)
				if !ok {
					return
				}
				conn, ok = tombstone.Obj.(*agentzv1alpha1.MCPConnection)
				if !ok {
					return
				}
			}
			svc.probeTimesMu.Lock()
			delete(svc.probeTimes, conn.Name)
			svc.probeTimesMu.Unlock()
		},
	})
	informerFactory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), mcpInformer.Informer().HasSynced) {
		return fmt.Errorf("sync mcpconnection informer cache")
	}

	srv := grpc.NewServer()
	authv3.RegisterAuthorizationServer(srv, svc)

	healthSrv := health.NewServer()
	healthpb.RegisterHealthServer(srv, healthSrv)
	healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	mcpServer := &http.Server{
		Addr:    mcpAddr,
		Handler: newMCPHandler(),
	}

	var bg sync.WaitGroup
	serveCtx, stopServers := context.WithCancel(ctx)
	serverGroup, serverCtx := errgroup.WithContext(serveCtx)
	serverGroup.Go(func() error {
		slog.InfoContext(
			serverCtx,
			"starting ext auth service",
			slog.String("addr", addr),
			slog.String("namespace", namespace),
		)
		err := srv.Serve(lis)
		if err == nil || errors.Is(err, grpc.ErrServerStopped) {
			return nil
		}
		return fmt.Errorf("serve ext auth grpc: %w", err)
	})
	serverGroup.Go(func() error {
		slog.InfoContext(
			serverCtx,
			"starting internal mcp helper",
			slog.String("addr", mcpAddr),
			slog.String("namespace", namespace),
		)
		err := mcpServer.Serve(mcpListener)
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve ext auth mcp helper: %w", err)
	})
	bg.Go(func() {
		svc.runMCPProbes(ctx)
	})
	bg.Go(func() {
		svc.runProbeQueue(ctx)
	})

	shutdownServers := func() error {
		stopServers()

		shutdownCtx, cancel := context.WithTimeout(
			context.Background(),
			grpcShutdownTimeout,
		)
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

		if err := mcpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("shutdown ext auth mcp helper: %w", err)
		}

		return nil
	}

	var serveErr error
	select {
	case <-ctx.Done():
		if err := shutdownServers(); err != nil {
			return err
		}
	case <-serverCtx.Done():
		serveErr = serverGroup.Wait()
		if err := shutdownServers(); err != nil {
			return err
		}
	}

	cancel()
	svc.probeQueue.ShutDown()
	bg.Wait()

	if serveErr == nil {
		serveErr = serverGroup.Wait()
	}
	return serveErr
}

// Service implements Envoy ext_authz for workload authorization and credential injection.
type Service struct {
	authv3.UnimplementedAuthorizationServer

	namespace          string
	sourceNamespaces   []string
	probeInterval      time.Duration
	probeTimeout       time.Duration
	kube               ctrlclient.Client
	kubeCore           kubernetes.Interface
	kv                 *baoapi.KVv2
	http               *http.Client
	sf                 singleflight.Group
	inferenceRefreshMu sync.Mutex
	mcpConnections     agentzlisters.MCPConnectionNamespaceLister
	probeQueue         workqueue.TypedInterface[string]
	probeTimes         map[string]time.Time
	probeTimesMu       sync.Mutex
}

var _ authv3.AuthorizationServer = (*Service)(nil)

func (s *Service) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	decision, attrs := s.evaluate(ctx, req)

	logAttrs := []slog.Attr{
		slog.String("namespace", attrs.namespace),
		slog.String("sandbox", attrs.sandbox),
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
		slog.LogAttrs(ctx, slog.LevelError, "ext auth request completed", logAttrs...)
	case slog.LevelWarn:
		slog.LogAttrs(ctx, slog.LevelWarn, "ext auth request completed", logAttrs...)
	default:
		slog.LogAttrs(ctx, slog.LevelInfo, "ext auth request completed", logAttrs...)
	}

	return decision.response, nil
}

type requestAttrs struct {
	namespace        string
	sandbox          string
	connection       string
	provider         string
	pool             string
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
	providerName := strings.TrimSpace(
		checkAttrs.GetContextExtensions()[contextProviderKey],
	)
	if providerName != "" {
		attrs.provider = providerName
		attrs.pool = strings.TrimSpace(
			checkAttrs.GetContextExtensions()[contextPoolKey],
		)
		return s.evaluateInference(ctx, checkAttrs, attrs)
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

	sandboxName := strings.TrimSpace(checkAttrs.GetContextExtensions()[contextSandboxKey])
	if sandboxName == "" {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"mcp sandbox context is missing",
			"missing_sandbox_context",
			slog.LevelError,
		), attrs
	}
	attrs.sandbox = sandboxName

	if ns := strings.TrimSpace(checkAttrs.GetContextExtensions()[contextNamespaceKey]); ns != "" {
		attrs.namespace = ns
	}

	request := checkAttrs.GetRequest()
	var httpReq *authv3.AttributeContext_HttpRequest
	if request != nil {
		httpReq = request.GetHttp()
	}
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

	agentName, err := s.authorizeSourceAgent(
		ctx,
		attrs.namespace,
		attrs.sourceIP,
		sandboxName,
		connName,
	)
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

	injection, err := s.resolveInjectedRequest(ctx, conn, &attrs)
	if err != nil {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"mcp connection is unavailable",
			"credential_resolution_failed",
			slog.LevelError,
		), attrs
	}

	return allowDecision(injection), attrs
}

func (s *Service) authorizeSourceAgent(ctx context.Context, namespace, sourceIP, sandboxName, connName string) (string, error) {
	pod, err := s.lookupAgentPodByIP(ctx, sourceIP)
	if err != nil {
		return "", err
	}

	agentName := strings.TrimSpace(pod.Labels[agentLabelKey])
	if agentName == "" {
		return "", fmt.Errorf("agent label is missing on pod %s", pod.Name)
	}

	agentCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	agent := &agentzv1alpha1.Agent{}
	agentKey := ctrlclient.ObjectKey{
		Namespace: pod.Namespace,
		Name:      agentName,
	}
	if err := s.kube.Get(agentCtx, agentKey, agent); err != nil {
		if apierrors.IsNotFound(err) {
			return "", fmt.Errorf("agent %q does not exist", agentName)
		}
		return "", fmt.Errorf(
			"get agent %q: %w: %w",
			agentName,
			err,
			errCredentialUnavailable,
		)
	}

	if strings.TrimSpace(agent.Spec.SandboxRef.Name) == "" {
		return "", fmt.Errorf("agent %q has no sandbox", agentName)
	}
	agentSandboxName := strings.TrimSpace(agent.Spec.SandboxRef.Name)
	if agentSandboxName != sandboxName {
		return "", fmt.Errorf(
			"agent %q is bound to sandbox %q, not %q",
			agentName,
			agentSandboxName,
			sandboxName,
		)
	}
	targetNamespace, err := scoperesolver.Namespace(
		ctx,
		s.kube,
		pod.Namespace,
		agent.Spec.SandboxRef.Scope,
	)
	if err != nil || targetNamespace != namespace {
		return "", fmt.Errorf("agent %q Sandbox scope is not authorized", agentName)
	}

	envCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	sandbox := &agentzv1alpha1.Sandbox{}
	sandboxKey := ctrlclient.ObjectKey{
		Namespace: namespace,
		Name:      sandboxName,
	}
	if err := s.kube.Get(envCtx, sandboxKey, sandbox); err != nil {
		if apierrors.IsNotFound(err) {
			return "", fmt.Errorf("sandbox %q does not exist", sandboxName)
		}
		return "", fmt.Errorf(
			"get sandbox %q: %w: %w",
			sandboxName,
			err,
			errCredentialUnavailable,
		)
	}

	hasConnection := slices.ContainsFunc(sandbox.Spec.MCPConnectionRefs, func(ref agentzv1alpha1.MCPConnectionRef) bool {
		return ref.Name == connName
	})
	if !hasConnection {
		return "", fmt.Errorf("sandbox %q does not include mcp connection %q", sandboxName, connName)
	}

	return agentName, nil
}

func (s *Service) lookupAgentPodByIP(ctx context.Context, ip string) (*corev1.Pod, error) {
	podCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	opts := metav1.ListOptions{
		FieldSelector: fields.OneTermEqualSelector("status.podIP", ip).String(),
		LabelSelector: strings.Join([]string{
			managedLabelKey + "=" + managedLabelValue,
			appNameLabelKey + "=" + appNameAgent,
		}, ","),
	}

	var found *corev1.Pod
	for _, namespace := range s.sourceNamespaces {
		pods, err := s.kubeCore.CoreV1().Pods(namespace).List(podCtx, opts)
		if err != nil {
			return nil, fmt.Errorf(
				"list source pods in namespace %q: %w: %w",
				namespace,
				err,
				errCredentialUnavailable,
			)
		}
		for i := range pods.Items {
			if found != nil {
				return nil, fmt.Errorf("multiple agent pods use source ip %q", ip)
			}
			found = pods.Items[i].DeepCopy()
		}
	}
	if found == nil {
		return nil, fmt.Errorf("no authorized agent pod uses source ip %q", ip)
	}
	return found, nil
}

func (s *Service) loadConnection(ctx context.Context, namespace, name string) (*agentzv1alpha1.MCPConnection, error) {
	connCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	conn := &agentzv1alpha1.MCPConnection{}
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

type injectedRequest struct {
	headers         []*corev3.HeaderValueOption
	headersToRemove []string
	queryParameters []*corev3.QueryParameter
}

func (s *Service) resolveInjectedRequest(ctx context.Context, conn *agentzv1alpha1.MCPConnection, attrs *requestAttrs) (injectedRequest, error) {
	conn = conn.DeepCopy()
	mcpconnwebhook.ApplyDefaults(&conn.Spec)

	if conn.Spec.Auth == nil {
		return injectedRequest{}, fmt.Errorf("mcp connection %q has no auth mode: %w", conn.Name, errCredentialUnavailable)
	}

	switch {
	case conn.Spec.Auth.Bearer != nil:
		return s.resolveBearerRequest(ctx, conn)
	case conn.Spec.Auth.OAuth != nil:
		return s.resolveOAuthRequest(ctx, conn, attrs)
	default:
		return injectedRequest{}, fmt.Errorf("mcp connection %q has no supported auth mode: %w", conn.Name, errCredentialUnavailable)
	}
}

func (s *Service) resolveBearerRequest(ctx context.Context, conn *agentzv1alpha1.MCPConnection) (injectedRequest, error) {
	auth := conn.Spec.Auth.Bearer
	if auth == nil || auth.SecretRef == nil {
		return injectedRequest{}, fmt.Errorf("bearer secret ref is missing: %w", errCredentialUnavailable)
	}

	record, err := s.readBearerRecord(ctx, *auth.SecretRef)
	if err != nil {
		return injectedRequest{}, err
	}

	token := strings.TrimSpace(record.Token)
	if token == "" {
		return injectedRequest{}, fmt.Errorf("bearer token is missing: %w", errCredentialUnavailable)
	}

	return injectionForLocation(auth.Location, token)
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

func headerLocation(location *agentzv1alpha1.MCPConnectionAuthLocation) (authHeaderLocation, error) {
	if location == nil {
		return authHeaderLocation{
			name:   "Authorization",
			prefix: "",
		}, nil
	}
	if location.QueryParameter != nil || location.Cookie != nil {
		return authHeaderLocation{}, fmt.Errorf("only header auth locations are supported: %w", errCredentialUnavailable)
	}
	if location.Header == nil {
		return authHeaderLocation{
			name:   "Authorization",
			prefix: "",
		}, nil
	}

	name := strings.TrimSpace(location.Header.Name)
	if name == "" {
		name = "Authorization"
	}

	var prefix string
	if location.Header.Prefix != nil {
		prefix = strings.TrimSpace(*location.Header.Prefix)
	}

	return authHeaderLocation{
		name:   name,
		prefix: prefix,
	}, nil
}

func injectionForLocation(location *agentzv1alpha1.MCPConnectionAuthLocation, token string) (injectedRequest, error) {
	if location == nil || location.Header != nil {
		header, err := headerLocation(location)
		if err != nil {
			return injectedRequest{}, err
		}
		value := token
		if prefix := strings.TrimSpace(header.prefix); prefix != "" {
			value = prefix + " " + token
		}
		return injectedRequest{
			headers: []*corev3.HeaderValueOption{{
				Header: &corev3.HeaderValue{
					Key:   header.name,
					Value: value,
				},
			}},
		}, nil
	}

	if location.QueryParameter != nil {
		return injectedRequest{
			queryParameters: []*corev3.QueryParameter{{
				Key:   location.QueryParameter.Name,
				Value: token,
			}},
		}, nil
	}

	if location.Cookie != nil {
		return injectedRequest{
			headers: []*corev3.HeaderValueOption{{
				Header: &corev3.HeaderValue{
					Key:   "Cookie",
					Value: (&http.Cookie{Name: location.Cookie.Name, Value: token}).String(),
				},
			}},
		}, nil
	}

	return injectedRequest{}, fmt.Errorf("auth location is empty: %w", errCredentialUnavailable)
}

func allowDecision(injection injectedRequest) checkDecision {
	okResp := &authv3.OkHttpResponse{
		Headers:         injection.headers,
		HeadersToRemove: injection.headersToRemove,
	}
	if len(injection.queryParameters) > 0 {
		okResp.QueryParametersToSet = injection.queryParameters
	}

	return checkDecision{
		response: &authv3.CheckResponse{
			Status: &statuspb.Status{
				Code: int32(codes.OK),
			},
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: okResp,
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
