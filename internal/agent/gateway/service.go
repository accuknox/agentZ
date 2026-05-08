package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	k8sauth "github.com/openbao/openbao/api/auth/kubernetes/v2"
	baoapi "github.com/openbao/openbao/api/v2"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	gatewaydb "github.com/accuknox/clawarmor/internal/agent/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var (
	errAgentNotFound = errors.New("agent not found")
	errRunNotFound   = errors.New("run not found")
	errBadRequest    = errors.New("bad request")
)

const (
	labelManagedBy = "app.kubernetes.io/managed-by"
	labelSessionID = "clawarmor.accuknox.com/session-id"
)

// Config describes how to start the gateway.
type Config struct {
	Addr                    string
	Namespace               string
	ValkeyAddr              string
	PostgresDSN             string
	GracefulShutdownTimeout time.Duration
	TargetOverride          string
	AgentImage              string
	AgentServerAddress      string
	AgentSessionTarget      string
	AgentTraceEndpoint      string
	OpenBaoAddr             string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
}

// Service implements the agent gateway HTTP API.
type Service struct {
	ctx       context.Context
	resolver  *resolver
	store     *valkeyStore
	queries   gatewaydb.Querier
	cfg       Config
	bao       *baoapi.Client
	baoKV     *baoapi.KVv2
	k8sClient ctrlclient.Client

	mu             sync.Mutex
	consumers      map[string]struct{}
	sessionWaiters map[string]map[chan struct{}]struct{}
	backendMu      sync.Mutex
	backends       map[string]*backendClient
}

type statusRecorder struct {
	http.ResponseWriter
	status  int
	apiCode string
	cause   error
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// SetAPIError stores the structured error details for request logging.
func (r *statusRecorder) SetAPIError(code string, cause error) {
	r.apiCode = code
	r.cause = cause
}

func (r *statusRecorder) Flush() {
	flusher, ok := r.ResponseWriter.(http.Flusher)
	if ok {
		flusher.Flush()
	}
}

// Serve starts the agent gateway HTTP server and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if strings.TrimSpace(cfg.PostgresDSN) == "" {
		return fmt.Errorf("postgres dsn is required")
	}
	if strings.TrimSpace(cfg.AgentSessionTarget) == "" {
		return fmt.Errorf("agent session target is required")
	}
	if strings.TrimSpace(cfg.AgentTraceEndpoint) == "" {
		return fmt.Errorf("agent trace endpoint is required")
	}
	if strings.TrimSpace(cfg.OpenBaoAddr) == "" {
		return fmt.Errorf("openbao addr is required")
	}
	if strings.TrimSpace(cfg.OpenBaoSecretMountPath) == "" {
		return fmt.Errorf("openbao secret mount path is required")
	}
	if strings.TrimSpace(cfg.OpenBaoK8sAuthRole) == "" {
		return fmt.Errorf("openbao k8s auth role is required")
	}

	resolver, err := newResolver(ctx, cfg.Namespace, cfg.TargetOverride)
	if err != nil {
		return err
	}
	defer resolver.Close()

	scheme := runtime.NewScheme()
	if err := clawarmorv1alpha1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("add clawarmor scheme: %w", err)
	}
	kubeCfg, err := ctrlconfig.GetConfig()
	if err != nil {
		return fmt.Errorf("load kube config: %w", err)
	}
	k8sClient, err := ctrlclient.New(kubeCfg, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}

	store, err := newValkeyStore(cfg.ValkeyAddr, defaultRunTTL)
	if err != nil {
		return err
	}
	defer store.Close()

	db, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer db.Close()

	if err := db.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	baoClient, err := baoapi.NewClient(&baoapi.Config{Address: cfg.OpenBaoAddr})
	if err != nil {
		return fmt.Errorf("create openbao client: %w", err)
	}

	auth, err := k8sauth.NewKubernetesAuth(
		cfg.OpenBaoK8sAuthRole,
		k8sauth.WithMountPath(cfg.OpenBaoK8sAuthMountPath),
		k8sauth.WithServiceAccountTokenPath(cfg.OpenBaoK8sAuthTokenPath),
	)
	if err != nil {
		return fmt.Errorf("create kubernetes auth: %w", err)
	}
	if _, err := baoClient.Auth().Login(ctx, auth); err != nil {
		return fmt.Errorf("openbao kubernetes auth login: %w", err)
	}

	svc := &Service{
		ctx:            ctx,
		resolver:       resolver,
		store:          store,
		queries:        gatewaydb.New(db),
		cfg:            cfg,
		bao:            baoClient,
		baoKV:          baoClient.KVv2(cfg.OpenBaoSecretMountPath),
		k8sClient:      k8sClient,
		consumers:      make(map[string]struct{}),
		sessionWaiters: make(map[string]map[chan struct{}]struct{}),
		backends:       make(map[string]*backendClient),
	}
	defer svc.closeBackendClients()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           svc.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting agent gateway HTTP server",
			slog.String("addr", cfg.Addr),
			slog.String("namespace", cfg.Namespace),
			slog.String("valkey_addr", cfg.ValkeyAddr),
		)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		timeout := cfg.GracefulShutdownTimeout
		if timeout == 0 {
			timeout = 15 * time.Second
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			_ = srv.Close()
		}
		err = <-errCh
	case err = <-errCh:
	}

	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve http: %w", err)
	}
	return nil
}

func (s *Service) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(requestLog)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	return gatewayapi.HandlerWithOptions(s, gatewayapi.ChiServerOptions{
		BaseRouter:       r,
		ErrorHandlerFunc: s.handleRouteError,
	})
}

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		attrs := []slog.Attr{
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", rec.status),
			slog.Duration("duration", time.Since(start)),
			slog.String("request_id", requestID(r)),
		}
		if rec.apiCode != "" {
			attrs = append(attrs, slog.String("code", rec.apiCode))
		}
		if rec.cause != nil && shouldLogRequestCause(r.Context(), rec.status) {
			attrs = append(attrs, slog.Any("err", rec.cause))
		}
		if rec.status >= http.StatusInternalServerError {
			slog.LogAttrs(r.Context(), slog.LevelError, "gateway request completed", attrs...)
			return
		}
		if rec.status >= http.StatusBadRequest &&
			slog.Default().Enabled(r.Context(), slog.LevelDebug) {
			slog.LogAttrs(r.Context(), slog.LevelDebug, "gateway request completed", attrs...)
			return
		}
		slog.LogAttrs(r.Context(), slog.LevelInfo, "gateway request completed", attrs...)
	})
}

func shouldLogRequestCause(ctx context.Context, status int) bool {
	if status >= http.StatusInternalServerError || status == http.StatusOK {
		return true
	}
	if status < http.StatusBadRequest {
		return false
	}
	return slog.Default().Enabled(ctx, slog.LevelDebug)
}
