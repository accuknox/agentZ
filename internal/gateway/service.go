package gateway

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	keyfunc "github.com/MicahParks/keyfunc/v3"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	baoapi "github.com/openbao/openbao/api/v2"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	gatewaydb "github.com/accuknox/clawarmor/internal/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	baoclient "github.com/accuknox/clawarmor/internal/openbao"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const labelManagedBy = "app.kubernetes.io/managed-by"

var (
	errAgentNotFound = errors.New("agent not found")
	errBadRequest    = errors.New("bad request")
)

// Config describes how to start the gateway.
type Config struct {
	Addr                     string
	Namespace                string
	PostgresDSN              string
	ExternalJWTJWKSURL       string
	ExternalJWTIssuer        string
	ExternalJWTAudience      string
	InternalK8sTokenAudience string
	TargetOverride           string
	AgentImage               string
	AgentTraceEndpoint       string
	OpenBaoAddr              string
	OpenBaoSecretMountPath   string
	OpenBaoK8sAuthRole       string
	OpenBaoK8sAuthMountPath  string
	OpenBaoK8sAuthTokenPath  string
	MCPProbeStaleAfter       time.Duration
}

// Service implements the agent gateway HTTP API.
type Service struct {
	ctx                context.Context
	resolver           *resolver
	queries            gatewaydb.Querier
	db                 *pgxpool.Pool
	cfg                Config
	bao                *baoapi.Client
	baoKV              *baoapi.KVv2
	k8sClient          ctrlclient.Client
	k8s                kubernetes.Interface
	externalJWTKeyfunc jwt.Keyfunc
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

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (r *statusRecorder) ReadFrom(src io.Reader) (int64, error) {
	readerFrom, ok := r.ResponseWriter.(io.ReaderFrom)
	if ok {
		return readerFrom.ReadFrom(src)
	}
	return io.Copy(r.ResponseWriter, src)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Serve starts the agent gateway HTTP server and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if strings.TrimSpace(cfg.PostgresDSN) == "" {
		return fmt.Errorf("postgres dsn is required")
	}
	if strings.TrimSpace(cfg.ExternalJWTJWKSURL) == "" {
		return fmt.Errorf("external jwt jwks url is required")
	}
	if strings.TrimSpace(cfg.ExternalJWTIssuer) == "" {
		return fmt.Errorf("external jwt issuer is required")
	}
	if strings.TrimSpace(cfg.ExternalJWTAudience) == "" {
		return fmt.Errorf("external jwt audience is required")
	}
	if strings.TrimSpace(cfg.InternalK8sTokenAudience) == "" {
		return fmt.Errorf("internal k8s token audience is required")
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
	if cfg.MCPProbeStaleAfter <= 0 {
		return fmt.Errorf("mcp probe stale after is required")
	}

	resolver, err := newResolver(ctx, cfg.TargetOverride)
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
	k8s, err := kubernetes.NewForConfig(kubeCfg)
	if err != nil {
		return fmt.Errorf("create kubernetes clientset: %w", err)
	}

	db, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer db.Close()

	if err := db.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
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

	externalJWTKeyfunc, err := newExternalJWTKeyfunc(ctx, cfg.ExternalJWTJWKSURL)
	if err != nil {
		return err
	}

	svc := &Service{
		ctx:                ctx,
		resolver:           resolver,
		queries:            gatewaydb.New(db),
		db:                 db,
		cfg:                cfg,
		bao:                baoClient,
		baoKV:              baoClient.KVv2(cfg.OpenBaoSecretMountPath),
		k8sClient:          k8sClient,
		k8s:                k8s,
		externalJWTKeyfunc: externalJWTKeyfunc,
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           svc.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting agent gateway HTTP server",
			slog.String("addr", cfg.Addr),
			slog.String("target_override", cfg.TargetOverride),
		)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
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
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Use(requireTenantRequest(s))
	r.HandleFunc(opencodePrefix+"/{agentName}", s.handleOpenCodeProxy)
	r.HandleFunc(opencodePrefix+"/{agentName}/*", s.handleOpenCodeProxy)
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
		if rec.status >= http.StatusBadRequest && slog.Default().Enabled(r.Context(), slog.LevelDebug) {
			slog.LogAttrs(r.Context(), slog.LevelDebug, "gateway request completed", attrs...)
			return
		}
		slog.LogAttrs(r.Context(), slog.LevelInfo, "gateway request completed", attrs...)
	})
}

type gatewayClaims struct {
	jwt.RegisteredClaims
	TenantID string `json:"tenant_id"`
	UserID   string `json:"user_id"`
}

func newExternalJWTKeyfunc(ctx context.Context, jwksURL string) (jwt.Keyfunc, error) {
	k, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("create external jwt keyfunc: %w", err)
	}
	return k.Keyfunc, nil
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
