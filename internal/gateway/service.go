package gateway

import (
	"bufio"
	"context"
	"encoding/json"
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
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"
	baoapi "github.com/openbao/openbao/api/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	ctrlcache "sigs.k8s.io/controller-runtime/pkg/cache"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	baoclient "github.com/accuknox/agentz/internal/openbao"
	"github.com/accuknox/agentz/internal/sandboxutil"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	agentzclient "github.com/accuknox/agentz/pkg/controller/clientset/versioned"
)

const labelManagedBy = "app.kubernetes.io/managed-by"

var (
	errAgentNotFound = errors.New("agent not found")
	errBadRequest    = errors.New("bad request")
)

type cleanupJobPayload struct {
	Operation   gatewaydb.DestructiveOperation `json:"operation"`
	OwnedAgents []cleanupAgent                 `json:"owned_agents"`
	WorkspaceID string                         `json:"workspace_id"`
}

type cleanupAgent struct {
	AgentName   string `json:"agent_name"`
	WorkspaceID string `json:"workspace_id"`
}

const cleanupMaxAttempts = 8

// Config describes how to start the gateway.
type Config struct {
	Addr                     string
	PostgresDSN              string
	ExternalJWTJWKSURL       string
	ExternalJWTIssuer        string
	ExternalJWTAudience      string
	InternalK8sTokenAudience string
	TargetOverride           string
	FilesystemTargetOverride string
	AgentImage               string
	AgentTraceEndpoint       string
	OpenBaoAddr              string
	OpenBaoSecretMountPath   string
	OpenBaoK8sAuthRole       string
	OpenBaoK8sAuthMountPath  string
	OpenBaoK8sAuthTokenPath  string
	MCPProbeStaleAfter       time.Duration
	SkillStore               skill.Config
}

// Service implements the agent gateway HTTP API.
type Service struct {
	gatewayapi.Unimplemented
	ctx                context.Context
	resolver           *resolver
	queries            gatewaydb.Querier
	db                 *pgxpool.Pool
	cfg                Config
	bao                *baoapi.Client
	baoKV              *baoapi.KVv2
	k8sClient          ctrlclient.Client
	usageReader        ctrlclient.Reader
	k8s                kubernetes.Interface
	agentz             agentzclient.Interface
	externalJWTKeyfunc jwt.Keyfunc
	skillStore         *skill.Client
	skillImports       chan struct{}
	catalog            *inference.Catalog
	openAPI            *openapi3.T
	outboundHTTP       *http.Client
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
	if err := cfg.SkillStore.Validate(); err != nil {
		return err
	}

	resolver, err := newResolver(ctx, cfg.TargetOverride)
	if err != nil {
		return err
	}
	defer resolver.Close()

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
	k8sClient, err := ctrlclient.New(kubeCfg, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}
	usageCache, err := ctrlcache.New(
		kubeCfg,
		ctrlcache.Options{
			Scheme:                      scheme,
			ReaderFailOnMissingInformer: true,
			ByObject: map[ctrlclient.Object]ctrlcache.ByObject{
				&agentzv1alpha1.Agent{}:         {},
				&agentzv1alpha1.Sandbox{}:       {},
				&agentzv1alpha1.InferencePool{}: {},
			},
		},
	)
	if err != nil {
		return fmt.Errorf("create inference usage cache: %w", err)
	}
	if err := inference.IndexSandboxes(ctx, usageCache); err != nil {
		return fmt.Errorf("index sandboxes by inference provider: %w", err)
	}
	if err := inference.IndexPools(ctx, usageCache); err != nil {
		return fmt.Errorf("index inference pool references: %w", err)
	}
	if err := sandboxutil.IndexAgentsBySandbox(ctx, usageCache); err != nil {
		return fmt.Errorf("index agents by sandbox: %w", err)
	}
	runCtx, stopRun := context.WithCancel(ctx)
	defer stopRun()
	cacheErrCh := make(chan error, 1)
	go func() {
		cacheErrCh <- usageCache.Start(runCtx)
	}()
	if !usageCache.WaitForCacheSync(runCtx) {
		return fmt.Errorf("sync inference usage cache")
	}
	k8s, err := kubernetes.NewForConfig(kubeCfg)
	if err != nil {
		return fmt.Errorf("create kubernetes clientset: %w", err)
	}
	agentz, err := agentzclient.NewForConfig(kubeCfg)
	if err != nil {
		return fmt.Errorf("create agentz clientset: %w", err)
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
	skillStore, err := skill.New(ctx, cfg.SkillStore)
	if err != nil {
		return fmt.Errorf("create immutable skill store: %w", err)
	}
	openAPISpec, err := gatewayapi.GetSwagger()
	if err != nil {
		return fmt.Errorf("load gateway OpenAPI schema: %w", err)
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
		usageReader:        usageCache,
		k8s:                k8s,
		agentz:             agentz,
		externalJWTKeyfunc: externalJWTKeyfunc,
		skillStore:         skillStore,
		skillImports:       make(chan struct{}, 4),
		catalog:            inference.NewCatalog(nil),
		openAPI:            openAPISpec,
		outboundHTTP:       &http.Client{Timeout: 10 * time.Second},
	}
	if err := svc.recoverWorkspaceProvisioning(ctx); err != nil {
		return err
	}
	eventTrailRetentionDone := make(chan struct{})
	go func() {
		defer close(eventTrailRetentionDone)
		svc.runEventTrailRetention(runCtx)
	}()
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		svc.runCleanupJobs(runCtx)
	}()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           svc.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(
			ctx,
			"starting agent gateway HTTP server",
			slog.String("addr", cfg.Addr),
			slog.String("target_override", cfg.TargetOverride),
		)
		errCh <- srv.ListenAndServe()
	}()

	var serverStopped bool

	select {
	case <-ctx.Done():
	case err = <-errCh:
		serverStopped = true
	case cacheErr := <-cacheErrCh:
		if ctx.Err() != nil && (cacheErr == nil || errors.Is(cacheErr, context.Canceled)) {
			break
		}
		if cacheErr == nil {
			cacheErr = errors.New("inference usage cache stopped")
		}
		err = fmt.Errorf("run inference usage cache: %w", cacheErr)
	}

	if !serverStopped {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		shutdownErr := srv.Shutdown(shutdownCtx)
		cancel()
		if shutdownErr != nil {
			shutdownErr = errors.Join(shutdownErr, srv.Close())
			err = errors.Join(err, fmt.Errorf("shutdown http server: %w", shutdownErr))
		}
		serveErr := <-errCh
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			err = errors.Join(err, serveErr)
		}
	}
	stopRun()
	<-cleanupDone
	<-eventTrailRetentionDone

	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve http: %w", err)
	}
	return nil
}

func (s *Service) runCleanupJobs(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		s.drainCleanupJobs(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) drainCleanupJobs(ctx context.Context) {
	for {
		now := time.Now()
		token := fmt.Sprintf("gateway-%d", now.UnixNano())
		job, err := s.queries.GatewayClaimCleanupJob(
			ctx,
			gatewaydb.GatewayClaimCleanupJobParams{
				LeaseToken:     pgtype.Text{String: token, Valid: true},
				LeaseExpiresAt: pgtype.Timestamptz{Time: now.Add(2 * time.Minute), Valid: true},
				NowAt:          pgtype.Timestamptz{Time: now, Valid: true},
			},
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return
		}
		if err != nil {
			slog.ErrorContext(ctx, "claim cleanup job", slog.Any("err", err))
			return
		}

		if err := s.processCleanupJob(ctx, job); err != nil {
			now = time.Now()
			if job.Attempts >= cleanupMaxAttempts {
				updated, failErr := s.queries.GatewayFailCleanupJob(
					ctx,
					gatewaydb.GatewayFailCleanupJobParams{
						FailedAt:   pgtype.Timestamptz{Time: now, Valid: true},
						LastError:  pgtype.Text{String: err.Error(), Valid: true},
						ID:         job.ID,
						LeaseToken: job.LeaseToken,
					},
				)
				if failErr != nil {
					slog.ErrorContext(
						ctx,
						"fail cleanup job",
						slog.String("job_id", job.ID),
						slog.Any("err", failErr),
					)
					continue
				}
				if updated == 0 {
					slog.WarnContext(ctx, "cleanup job lease lost", slog.String("job_id", job.ID))
				}
				continue
			}

			next := now.Add(time.Duration(job.Attempts) * time.Minute)
			updated, retryErr := s.queries.GatewayRetryCleanupJob(
				ctx,
				gatewaydb.GatewayRetryCleanupJobParams{
					NextAttemptAt: pgtype.Timestamptz{Time: next, Valid: true},
					LastError:     pgtype.Text{String: err.Error(), Valid: true},
					UpdatedAt:     pgtype.Timestamptz{Time: now, Valid: true},
					ID:            job.ID,
					LeaseToken:    job.LeaseToken,
				},
			)
			if retryErr != nil {
				slog.ErrorContext(ctx, "retry cleanup job", slog.String("job_id", job.ID), slog.Any("err", retryErr))
				continue
			}
			if updated == 0 {
				slog.WarnContext(ctx, "cleanup job lease lost", slog.String("job_id", job.ID))
			}
			continue
		}

		updated, err := s.queries.GatewayCompleteCleanupJob(
			ctx,
			gatewaydb.GatewayCompleteCleanupJobParams{
				CompletedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
				ID:          job.ID,
				LeaseToken:  job.LeaseToken,
			},
		)
		if err != nil {
			slog.ErrorContext(ctx, "complete cleanup job", slog.String("job_id", job.ID), slog.Any("err", err))
			continue
		}
		if updated == 0 {
			slog.WarnContext(ctx, "cleanup job lease lost", slog.String("job_id", job.ID))
		}
	}
}

func (s *Service) processCleanupJob(ctx context.Context, job gatewaydb.CleanupJob) error {
	var payload cleanupJobPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("decode cleanup payload: %w", err)
	}
	if payload.Operation != job.Operation {
		return fmt.Errorf(
			"cleanup payload operation %q does not match job operation %q",
			payload.Operation,
			job.Operation,
		)
	}
	if job.Operation == gatewaydb.DestructiveOperationWorkspaceDelete {
		return s.processWorkspaceCleanup(ctx, job, payload)
	}
	switch job.Operation {
	case gatewaydb.DestructiveOperationMembershipDisable,
		gatewaydb.DestructiveOperationMembershipRemove,
		gatewaydb.DestructiveOperationTeamDelete,
		gatewaydb.DestructiveOperationRoleReduce,
		gatewaydb.DestructiveOperationAccessRevoke:
	default:
		return fmt.Errorf("unsupported cleanup operation %q", job.Operation)
	}

	for _, agent := range payload.OwnedAgents {
		workspace, err := s.queries.GatewayGetWorkspace(
			ctx,
			gatewaydb.GatewayGetWorkspaceParams{
				ID:             agent.WorkspaceID,
				OrganizationID: job.OrganizationID,
			},
		)
		if err != nil {
			return fmt.Errorf("get workspace %q for cleanup: %w", agent.WorkspaceID, err)
		}

		schedules, err := s.agentz.AgentzV1alpha1().WorkflowSchedules(workspace.Namespace).List(
			ctx,
			metav1.ListOptions{},
		)
		if err != nil {
			return fmt.Errorf("list Agent %q WorkflowSchedules: %w", agent.AgentName, err)
		}
		for i := range schedules.Items {
			if schedules.Items[i].Spec.AgentName != agent.AgentName {
				continue
			}
			err = s.agentz.AgentzV1alpha1().WorkflowSchedules(workspace.Namespace).Delete(
				ctx,
				schedules.Items[i].Name,
				metav1.DeleteOptions{
					PropagationPolicy: new(metav1.DeletePropagationBackground),
				},
			)
			if err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf(
					"delete Agent %q WorkflowSchedule %q: %w",
					agent.AgentName,
					schedules.Items[i].Name,
					err,
				)
			}
		}

		runs, err := s.agentz.AgentzV1alpha1().WorkflowRuns(workspace.Namespace).List(
			ctx,
			metav1.ListOptions{},
		)
		if err != nil {
			return fmt.Errorf("list Agent %q WorkflowRuns: %w", agent.AgentName, err)
		}
		for i := range runs.Items {
			if runs.Items[i].Spec.AgentName != agent.AgentName {
				continue
			}
			err = s.agentz.AgentzV1alpha1().WorkflowRuns(workspace.Namespace).Delete(
				ctx,
				runs.Items[i].Name,
				metav1.DeleteOptions{
					PropagationPolicy: new(metav1.DeletePropagationBackground),
				},
			)
			if err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf(
					"delete Agent %q WorkflowRun %q: %w",
					agent.AgentName,
					runs.Items[i].Name,
					err,
				)
			}
		}

		err = s.resolver.client.AgentzV1alpha1().Agents(workspace.Namespace).Delete(
			ctx,
			agent.AgentName,
			metav1.DeleteOptions{
				PropagationPolicy: new(metav1.DeletePropagationForeground),
			},
		)
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete Agent %q: %w", agent.AgentName, err)
		}
		if err := s.deleteAgentSecretResources(ctx, workspace.Namespace, agent.AgentName); err != nil {
			return fmt.Errorf("delete Agent %q secrets: %w", agent.AgentName, err)
		}

		schedules, err = s.agentz.AgentzV1alpha1().WorkflowSchedules(workspace.Namespace).List(
			ctx,
			metav1.ListOptions{},
		)
		if err != nil {
			return fmt.Errorf("confirm Agent %q WorkflowSchedule cleanup: %w", agent.AgentName, err)
		}
		for i := range schedules.Items {
			if schedules.Items[i].Spec.AgentName == agent.AgentName {
				return fmt.Errorf(
					"agent %q WorkflowSchedule %q cleanup is pending",
					agent.AgentName,
					schedules.Items[i].Name,
				)
			}
		}

		runs, err = s.agentz.AgentzV1alpha1().WorkflowRuns(workspace.Namespace).List(
			ctx,
			metav1.ListOptions{},
		)
		if err != nil {
			return fmt.Errorf("confirm Agent %q WorkflowRun cleanup: %w", agent.AgentName, err)
		}
		for i := range runs.Items {
			if runs.Items[i].Spec.AgentName == agent.AgentName {
				return fmt.Errorf(
					"agent %q WorkflowRun %q cleanup is pending",
					agent.AgentName,
					runs.Items[i].Name,
				)
			}
		}

		_, err = s.resolver.client.AgentzV1alpha1().Agents(workspace.Namespace).Get(
			ctx,
			agent.AgentName,
			metav1.GetOptions{},
		)
		if err == nil {
			return fmt.Errorf("agent %q cleanup is pending", agent.AgentName)
		}
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("confirm Agent %q cleanup: %w", agent.AgentName, err)
		}

		secrets, err := s.listAgentSecrets(workspace.Namespace, agent.AgentName)
		if err != nil {
			return fmt.Errorf("confirm Agent %q secret cleanup: %w", agent.AgentName, err)
		}
		if len(secrets) != 0 {
			return fmt.Errorf("agent %q secret cleanup is pending", agent.AgentName)
		}

		_, err = s.queries.GatewayDeleteAgent(
			ctx,
			gatewaydb.GatewayDeleteAgentParams{
				TenantNamespace: workspace.Namespace,
				AgentName:       agent.AgentName,
			},
		)
		if err != nil {
			return fmt.Errorf("delete Agent %q row: %w", agent.AgentName, err)
		}
	}
	return nil
}

func (s *Service) processWorkspaceCleanup(ctx context.Context, job gatewaydb.CleanupJob, payload cleanupJobPayload) error {
	if payload.WorkspaceID == "" || payload.WorkspaceID != job.TargetID {
		return errors.New("workspace cleanup payload does not match its target")
	}
	workspace, err := s.queries.GatewayGetWorkspace(
		ctx,
		gatewaydb.GatewayGetWorkspaceParams{
			ID: payload.WorkspaceID, OrganizationID: job.OrganizationID,
		},
	)
	if err != nil {
		return fmt.Errorf("get Workspace %q for cleanup: %w", payload.WorkspaceID, err)
	}
	err = s.agentz.AgentzV1alpha1().Workspaces().Delete(
		ctx,
		workspace.Namespace,
		metav1.DeleteOptions{PropagationPolicy: new(metav1.DeletePropagationForeground)},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete Workspace %q: %w", workspace.Namespace, err)
	}
	_, err = s.agentz.AgentzV1alpha1().Workspaces().Get(
		ctx,
		workspace.Namespace,
		metav1.GetOptions{},
	)
	if err == nil {
		return fmt.Errorf("workspace %q cleanup is pending", workspace.Namespace)
	}
	if !apierrors.IsNotFound(err) {
		return fmt.Errorf("confirm Workspace %q cleanup: %w", workspace.Namespace, err)
	}
	_, err = s.queries.GatewayDeleteWorkspaceAgents(ctx, workspace.Namespace)
	if err != nil {
		return fmt.Errorf("delete Workspace %q Agent rows: %w", workspace.Namespace, err)
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
	r.With(requireTenantRequest(s)).HandleFunc(opencodePrefix+"/{agentName}", s.handleOpenCodeProxy)
	r.With(requireTenantRequest(s)).HandleFunc(opencodePrefix+"/{agentName}/*", s.handleOpenCodeProxy)

	apiRouter := chi.NewRouter()
	apiRouter.Use(nethttpmiddleware.OapiRequestValidatorWithOptions(
		s.openAPI,
		&nethttpmiddleware.Options{
			Options: openapi3filter.Options{
				AuthenticationFunc: openapi3filter.NoopAuthenticationFunc,
			},
			ErrorHandlerWithOpts: func(_ context.Context, err error, w http.ResponseWriter, r *http.Request, opts nethttpmiddleware.ErrorHandlerOpts) {
				converted := openapi3filter.ConvertErrors(err)
				status := opts.StatusCode
				if statusErr, ok := converted.(openapi3filter.StatusCoder); ok {
					status = statusErr.StatusCode()
				}
				writeError(
					w,
					r,
					newAPIError(
						status,
						"invalid_request",
						"request is invalid",
						err,
					),
				)
			},
			DoNotValidateServers: true,
		},
	))
	gatewayapi.HandlerWithOptions(
		s,
		gatewayapi.ChiServerOptions{
			BaseRouter:       apiRouter,
			ErrorHandlerFunc: s.handleRouteError,
			Middlewares: []gatewayapi.MiddlewareFunc{
				requireExplicitCapability,
				requireTenantRequest(s),
				requireAgentBoundAccess(s),
			},
		},
	)
	r.Mount("/", apiRouter)
	return r
}

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		debug := slog.Default().Enabled(r.Context(), slog.LevelDebug)

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
		if rec.status >= http.StatusBadRequest && debug {
			slog.LogAttrs(r.Context(), slog.LevelDebug, "gateway request completed", attrs...)
			return
		}
		slog.LogAttrs(r.Context(), slog.LevelInfo, "gateway request completed", attrs...)
	})
}

type gatewayScopeType string

const (
	gatewayScopeOrganization gatewayScopeType = "organization"
	gatewayScopeWorkspace    gatewayScopeType = "workspace"
)

type gatewayAgentAccess struct {
	AgentName    string                           `json:"agent_name"`
	Capabilities []gatewaydb.AgentShareCapability `json:"capabilities"`
	Owner        bool                             `json:"owner"`
}

// gatewayClaims binds identity and its issuance-time authority snapshot to one
// selected scope. Handlers still resolve PostgreSQL authority for revocation.
type gatewayClaims struct {
	jwt.RegisteredClaims
	OrganizationID       string                `json:"organization_id"`
	ScopeType            gatewayScopeType      `json:"scope_type"`
	ScopeID              string                `json:"scope_id"`
	UserID               string                `json:"user_id"`
	UserName             string                `json:"user_name"`
	Capabilities         *[]string             `json:"capabilities"`
	AdministrativeBypass *bool                 `json:"administrative_bypass"`
	AgentACL             *[]gatewayAgentAccess `json:"agent_acl"`
	WorkspaceID          string                `json:"-"`
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
