package workflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"

	workflowapi "github.com/accuknox/clawarmor/internal/workflow/openapi"
)

// Config describes how to start the workflow service.
type Config struct {
	Addr        string
	PostgresDSN string
}

// Service implements the workflow HTTP API.
type Service struct {
	ctx   context.Context
	store *dbStore
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

func (r *statusRecorder) SetAPIError(code string, cause error) {
	r.apiCode = code
	r.cause = cause
}

// Serve starts the workflow HTTP server and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if strings.TrimSpace(cfg.PostgresDSN) == "" {
		return fmt.Errorf("postgres dsn is required")
	}

	db, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer db.Close()

	if err := db.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	svc := &Service{
		ctx:   ctx,
		store: &dbStore{pool: db},
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           svc.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting workflow HTTP server", slog.String("addr", cfg.Addr))
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
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	return workflowapi.HandlerWithOptions(s, workflowapi.ChiServerOptions{
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
			slog.LogAttrs(r.Context(), slog.LevelError, "workflow request completed", attrs...)
			return
		}
		if rec.status >= http.StatusBadRequest &&
			slog.Default().Enabled(r.Context(), slog.LevelDebug) {
			slog.LogAttrs(r.Context(), slog.LevelDebug, "workflow request completed", attrs...)
			return
		}
		slog.LogAttrs(r.Context(), slog.LevelInfo, "workflow request completed", attrs...)
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

var _ workflowapi.ServerInterface = (*Service)(nil)
