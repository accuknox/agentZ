package observer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	observerpb "github.com/cilium/cilium/api/v1/observer"
	"github.com/jackc/pgx/v5/pgxpool"
	pb "github.com/kubearmor/KubeArmor/protobuf"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

var (
	errPostgresDSNEmpty        = errors.New("postgres dsn must not be empty")
	errKubeArmorRelayAddrEmpty = errors.New("kubearmor relay address must not be empty")
	errHubbleRelayAddrEmpty    = errors.New("hubble relay address must not be empty")
	errOTLPTraceGRPCAddrEmpty  = errors.New("otlp trace grpc address must not be empty")
	errNamespaceEmpty          = errors.New("namespace must not be empty")
	errBatchSizeInvalid        = errors.New("batch size must be greater than zero")
	errFlushIntervalInvalid    = errors.New("flush interval must be greater than zero")
)

// Config describes how the observer consumes telemetry and writes PostgreSQL.
type Config struct {
	PostgresDSN        string
	KubeArmorRelayAddr string
	HubbleRelayAddr    string
	OTLPTraceGRPCAddr  string
	Namespace          string
	BatchSize          int
	FlushInterval      time.Duration
}

// Validate reports invalid observer configuration before any side effects.
func (c Config) Validate() error {
	if c.PostgresDSN == "" {
		return errPostgresDSNEmpty
	}
	if c.KubeArmorRelayAddr == "" {
		return errKubeArmorRelayAddrEmpty
	}
	if c.HubbleRelayAddr == "" {
		return errHubbleRelayAddrEmpty
	}
	if c.OTLPTraceGRPCAddr == "" {
		return errOTLPTraceGRPCAddrEmpty
	}
	if c.Namespace == "" {
		return errNamespaceEmpty
	}
	if c.BatchSize <= 0 {
		return errBatchSizeInvalid
	}
	if c.FlushInterval <= 0 {
		return errFlushIntervalInvalid
	}
	return nil
}

// Serve starts the observer and blocks until context cancellation or failure.
func Serve(ctx context.Context, cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	res, err := newResolver()
	if err != nil {
		return fmt.Errorf("create resolver: %w", err)
	}

	evCh := make(chan event, cfg.BatchSize*4)
	stats := &stats{}
	sink := &sink{
		store:  &dbStore{pool: pool},
		stats:  stats,
		cfg:    cfg,
		events: evCh,
	}

	var wg sync.WaitGroup
	wg.Go(func() {
		sink.run(ctx)
	})
	wg.Go(func() {
		runKubeArmorWatcher(ctx, cfg, res, watchModeLogs, evCh, stats)
	})
	wg.Go(func() {
		runKubeArmorWatcher(ctx, cfg, res, watchModeAlerts, evCh, stats)
	})
	wg.Go(func() {
		runHubbleWatcher(ctx, cfg, res, evCh, stats)
	})
	wg.Go(func() {
		if err := runOTLPTraceReceiver(ctx, cfg, evCh, stats); err != nil {
			slog.ErrorContext(ctx, "otlp trace receiver failed", slog.Any("error", err))
		}
	})
	wg.Go(func() {
		logStats(ctx, stats)
	})

	<-ctx.Done()
	wg.Wait()
	return nil
}

type watchMode string

const (
	watchModeLogs   watchMode = "logs"
	watchModeAlerts watchMode = "alerts"
)

func runKubeArmorWatcher(ctx context.Context, cfg Config, r *resolver, mode watchMode, out chan<- event, s *stats) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := consumeKubeArmorStream(ctx, cfg, r, mode, out, s)
		if err == nil || ctx.Err() != nil {
			return
		}

		slog.ErrorContext(
			ctx,
			"kubearmor relay stream failed",
			slog.String("mode", string(mode)),
			slog.Any("error", err),
		)

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func consumeKubeArmorStream(ctx context.Context, cfg Config, r *resolver, mode watchMode, out chan<- event, s *stats) error {
	conn, client, err := newKubeArmorRelayClient(ctx, cfg.KubeArmorRelayAddr)
	if err != nil {
		return err
	}
	defer conn.Close()

	switch mode {
	case watchModeLogs:
		stream, err := client.WatchLogs(ctx, &pb.RequestMessage{Filter: "all"})
		if err != nil {
			return err
		}
		slog.InfoContext(ctx, "connected to KubeArmor logs stream")
		for {
			item, err := stream.Recv()
			if err != nil {
				return err
			}
			atomic.AddUint64(&s.received, 1)
			agentName, ok := resolveAgent(ctx, r, item.GetNamespaceName(), item.GetLabels(), item.GetOwner(), item.GetPodName())
			if !ok {
				atomic.AddUint64(&s.filtered, 1)
				continue
			}
			ev, ok := normalizeLog(item, cfg.Namespace, agentName)
			if !ok {
				atomic.AddUint64(&s.filtered, 1)
				continue
			}
			if err := sendEvent(ctx, out, ev); err != nil {
				return err
			}
		}
	case watchModeAlerts:
		stream, err := client.WatchAlerts(ctx, &pb.RequestMessage{Filter: "all"})
		if err != nil {
			return err
		}
		slog.InfoContext(ctx, "connected to KubeArmor alerts stream")
		for {
			item, err := stream.Recv()
			if err != nil {
				return err
			}
			atomic.AddUint64(&s.received, 1)
			agentName, ok := resolveAgent(ctx, r, item.GetNamespaceName(), item.GetLabels(), item.GetOwner(), item.GetPodName())
			if !ok {
				atomic.AddUint64(&s.filtered, 1)
				continue
			}
			ev, ok := normalizeAlert(item, cfg.Namespace, agentName)
			if !ok {
				atomic.AddUint64(&s.filtered, 1)
				continue
			}
			if err := sendEvent(ctx, out, ev); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unsupported watch mode %q", mode)
	}
}

func resolveAgent(ctx context.Context, r *resolver, namespace, rawLabels string, owner *pb.Podowner, podName string) (string, bool) {
	ownerName := ""
	if owner != nil {
		ownerName = owner.GetName()
	}
	return r.resolve(ctx, namespace, parseLabels(rawLabels), ownerName, podName)
}

func sendEvent(ctx context.Context, out chan<- event, ev event) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case out <- ev:
		return nil
	}
}

func newKubeArmorRelayClient(ctx context.Context, addr string) (*grpc.ClientConn, pb.LogServiceClient, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, fmt.Errorf("dial kubearmor relay %s: %w", addr, err)
	}

	client := pb.NewLogServiceClient(conn)
	nonce := time.Now().UnixNano()
	reply, err := client.HealthCheck(ctx, &pb.NonceMessage{Nonce: int32(nonce)})
	if err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("kubearmor relay healthcheck: %w", err)
	}
	if reply.GetRetval() != int32(nonce) {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("kubearmor relay healthcheck nonce mismatch")
	}
	return conn, client, nil
}

func newHubbleRelayClient(ctx context.Context, addr string) (*grpc.ClientConn, observerpb.ObserverClient, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, fmt.Errorf("dial hubble relay %s: %w", addr, err)
	}

	client := observerpb.NewObserverClient(conn)
	_, err = client.ServerStatus(ctx, &observerpb.ServerStatusRequest{})
	if err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("hubble relay status: %w", err)
	}
	return conn, client, nil
}

func runHubbleWatcher(ctx context.Context, cfg Config, r *resolver, out chan<- event, s *stats) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := consumeHubbleStream(ctx, cfg, r, out, s)
		if err == nil || ctx.Err() != nil {
			return
		}

		slog.ErrorContext(ctx, "hubble relay stream failed", slog.Any("error", err))
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func consumeHubbleStream(ctx context.Context, cfg Config, r *resolver, out chan<- event, s *stats) error {
	conn, client, err := newHubbleRelayClient(ctx, cfg.HubbleRelayAddr)
	if err != nil {
		return err
	}
	defer conn.Close()

	stream, err := client.GetFlows(ctx, &observerpb.GetFlowsRequest{Follow: true})
	if err != nil {
		return fmt.Errorf("get hubble flows: %w", err)
	}
	slog.InfoContext(ctx, "connected to Hubble relay stream")

	cache := newDNSCache()
	for {
		item, err := stream.Recv()
		if err != nil {
			return err
		}
		if item.GetFlow() == nil {
			continue
		}
		atomic.AddUint64(&s.received, 1)
		ev, ok := normalizeFlow(ctx, item.GetFlow(), cfg.Namespace, r, cache)
		if !ok {
			atomic.AddUint64(&s.filtered, 1)
			continue
		}
		if err := sendEvent(ctx, out, ev); err != nil {
			return err
		}
	}
}

func logStats(ctx context.Context, s *stats) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			vals := s.values()
			slog.InfoContext(
				ctx,
				"observer stats",
				slog.Uint64("received", vals.received),
				slog.Uint64("filtered", vals.filtered),
				slog.Uint64("flushed", vals.flushed),
				slog.Uint64("failed", vals.failed),
			)
		}
	}
}
