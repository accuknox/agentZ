// Package relay serves authenticated connections from enrolled Linux hosts.
package relay

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os/signal"
	"reflect"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"
	ctrlcache "sigs.k8s.io/controller-runtime/pkg/cache"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/host"
	hostv1 "github.com/accuknox/agentz/internal/host/proto"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Config specifies the relay's listeners, identities and backend dependencies.
type Config struct {
	Addr, ControlAddr, HealthAddr                                string
	PublicAddress, SPIREAddress, SPIREPublicAddress, TrustDomain string
	IdentityCert, IdentityKey, TrustBundle                       string
	GatewayURL, InternalK8sTokenAudience, AgentTraceEndpoint     string
	ProxyCASecretName, ProxyCASecretKey, PostgresDSN             string
	SkillStore                                                   skill.Config
}

// Service owns host streams and validates their persisted assignments.
type Service struct {
	hostv1.UnimplementedRelayControlServer
	cfg         Config
	queries     gatewaydb.Querier
	db          *pgxpool.Pool
	k8s         kubernetes.Interface
	k8sClient   ctrlclient.Client
	cacheClient ctrlclient.Client
	skillStore  *skill.Client
	identity    *host.IdentityAdmin
	hosts       *host.Relay
	trace       tracev1.TraceServiceClient
}

// Serve starts the public host listener and private gateway control listener.
// Losing a relay does not terminate local host processes or replay accepted work.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if cfg.Addr == cfg.ControlAddr {
		return errors.New("host and gateway control listeners must use different addresses")
	}
	missingBackend := cfg.GatewayURL == "" || cfg.InternalK8sTokenAudience == ""
	if cfg.PublicAddress == "" || cfg.SPIREPublicAddress == "" || missingBackend {
		return errors.New("relay public address, SPIRE public address, gateway URL and token audience are required")
	}
	if err := cfg.SkillStore.Validate(); err != nil {
		return err
	}
	db, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		return err
	}
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		return err
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		return err
	}
	kubeConfig, err := ctrlconfig.GetConfig()
	if err != nil {
		return err
	}
	k8s, err := kubernetes.NewForConfig(kubeConfig)
	if err != nil {
		return err
	}
	direct, err := ctrlclient.New(kubeConfig, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return err
	}
	objects := map[ctrlclient.Object]ctrlcache.ByObject{}
	for _, object := range []ctrlclient.Object{
		&corev1.Namespace{}, &agentzv1alpha1.Agent{}, &agentzv1alpha1.Sandbox{},
		&agentzv1alpha1.InferencePool{}, &agentzv1alpha1.InferenceProvider{},
		&agentzv1alpha1.Workspace{}, &agentzv1alpha1.Tenant{},
		&agentzv1alpha1.Skill{}, &agentzv1alpha1.MCPConnection{},
	} {
		objects[object] = ctrlcache.ByObject{}
	}
	cache, err := ctrlcache.New(kubeConfig, ctrlcache.Options{
		Scheme: scheme, ReaderFailOnMissingInformer: true, ByObject: objects,
	})
	if err != nil {
		return err
	}
	for object := range objects {
		if _, err := cache.GetInformer(ctx, object); err != nil {
			return err
		}
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	failures := make(chan error, 5)
	go func() { failures <- cache.Start(runCtx) }()
	if !cache.WaitForCacheSync(runCtx) {
		return errors.New("sync relay runtime cache")
	}
	cached, err := ctrlclient.New(kubeConfig, ctrlclient.Options{
		Scheme: scheme, Cache: &ctrlclient.CacheOptions{Reader: cache},
	})
	if err != nil {
		return err
	}
	skills, err := skill.New(runCtx, cfg.SkillStore)
	if err != nil {
		return err
	}
	adminTLS, err := host.ClientTLS(cfg.IdentityCert, cfg.IdentityKey, cfg.TrustBundle, cfg.TrustDomain, "/spire/server")
	if err != nil {
		return err
	}
	identity, err := host.NewRemoteIdentityAdmin(cfg.SPIREAddress, cfg.TrustDomain, adminTLS)
	if err != nil {
		return err
	}
	defer identity.Close()
	var publicTLS *tls.Config
	var identityErr error
	err = wait.PollUntilContextTimeout(runCtx, time.Second, time.Minute, true, func(attempt context.Context) (bool, error) {
		publicTLS, identityErr = identity.ServerTLS(attempt)
		return identityErr == nil, nil
	})
	if err != nil {
		return errors.Join(err, identityErr)
	}
	go func() { failures <- identity.Maintain(runCtx) }()
	observer, err := grpc.NewClient(cfg.AgentTraceEndpoint, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer observer.Close()
	svc := &Service{
		cfg: cfg, queries: gatewaydb.New(db), db: db, k8s: k8s,
		k8sClient: direct, cacheClient: cached, skillStore: skills,
		identity: identity, trace: tracev1.NewTraceServiceClient(observer),
	}
	svc.hosts = host.NewRelay(host.Callbacks{
		Authorize: svc.authorizeHost, Validate: svc.validateAssignment,
		Desired: svc.desiredRuntime, Observe: svc.observeHost,
		DialUpstream: svc.dialUpstream,
	})
	// Before accepting connections, clear readiness left by a previous process.
	var agents agentzv1alpha1.AgentList
	if err := direct.List(runCtx, &agents); err != nil {
		return err
	}
	for i := range agents.Items {
		agent := &agents.Items[i]
		if agent.Spec.Execution != agentzv1alpha1.AgentExecutionNative || !agent.DeletionTimestamp.IsZero() {
			continue
		}
		key := ctrlclient.ObjectKeyFromObject(agent)
		check, cancel := context.WithTimeout(runCtx, 5*time.Second)
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			if err := direct.Get(check, key, agent); err != nil {
				return ctrlclient.IgnoreNotFound(err)
			}
			if agent.Spec.Execution != agentzv1alpha1.AgentExecutionNative || !agent.DeletionTimestamp.IsZero() {
				return nil
			}
			before := agent.DeepCopy()
			agent.Status.Connected = false
			agent.Status.SetCondition(metav1.Condition{
				Type: agentzv1alpha1.ConditionTypeReady.String(), Status: metav1.ConditionFalse,
				Reason: "HostOffline", Message: "Host is offline", ObservedGeneration: agent.Generation,
			})
			if reflect.DeepEqual(before.Status, agent.Status) {
				return nil
			}
			patch := ctrlclient.MergeFromWithOptions(before, ctrlclient.MergeFromWithOptimisticLock{})
			return ctrlclient.IgnoreNotFound(direct.Status().Patch(check, agent, patch))
		})
		cancel()
		if err != nil {
			return err
		}
	}
	domain, err := spiffeid.TrustDomainFromString(cfg.TrustDomain)
	if err != nil {
		return err
	}
	gatewayID, err := spiffeid.FromPath(domain, "/agentz/gateway")
	if err != nil {
		return err
	}
	privateTLS := tlsconfig.MTLSServerConfig(identity, identity, tlsconfig.AuthorizeID(gatewayID))
	public := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(publicTLS)),
		grpc.MaxRecvMsgSize(64<<10), grpc.MaxSendMsgSize(4<<20),
		grpc.MaxConcurrentStreams(128),
	)
	private := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(privateTLS)),
		grpc.MaxRecvMsgSize(64<<10), grpc.MaxSendMsgSize(4<<20),
		grpc.MaxConcurrentStreams(256),
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionAge: 3 * time.Minute,
		}),
	)
	hostv1.RegisterHostRelayServer(public, svc.hosts)
	hostv1.RegisterRelayControlServer(private, svc)
	defer public.Stop()
	defer private.Stop()
	for address, server := range map[string]*grpc.Server{cfg.Addr: public, cfg.ControlAddr: private} {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			return err
		}
		defer listener.Close()
		go func() { failures <- server.Serve(listener) }()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		identity, err := svc.identity.GetX509SVID()
		if err != nil || !identity.Certificates[0].NotAfter.After(time.Now()) {
			http.Error(w, "relay identity unavailable", http.StatusServiceUnavailable)
			return
		}
		check, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := db.Ping(check); err != nil {
			http.Error(w, "relay storage unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	health := &http.Server{Addr: cfg.HealthAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer health.Close()
	go func() { failures <- health.ListenAndServe() }()
	slog.InfoContext(runCtx, "host relay started",
		"address", cfg.Addr, "control_address", cfg.ControlAddr,
	)
	select {
	case <-runCtx.Done():
		return nil
	case err := <-failures:
		if runCtx.Err() != nil {
			return nil
		}
		return err
	}
}
