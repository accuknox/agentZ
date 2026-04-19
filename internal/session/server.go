package sessionstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	grpcHealth "google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	sessiondb "github.com/accuknox/clawarmor/internal/session/db"
	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
	"trpc.group/trpc-go/trpc-agent-go/event"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
)

// Config describes how to start the session gRPC server.
type Config struct {
	Addr                    string
	PostgresDSN             string
	GracefulShutdownTimeout time.Duration
}

// Service implements the gRPC session store backed by PostgreSQL.
type Service struct {
	sessionpb.UnimplementedSessionServiceServer

	queries sessiondb.Querier
}

// NewService returns a Postgres-backed session service.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{queries: sessiondb.New(pool)}
}

// Serve starts the session gRPC server and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	addr := cfg.Addr
	if addr == "" {
		addr = DefaultListenAddr
	}
	if cfg.PostgresDSN == "" {
		return fmt.Errorf("postgres dsn is required")
	}

	pool, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	defer lis.Close()

	healthSvc := grpcHealth.NewServer()
	srv := grpc.NewServer()
	sessionpb.RegisterSessionServiceServer(srv, NewService(pool))
	healthpb.RegisterHealthServer(srv, healthSvc)
	healthSvc.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting session gRPC server", slog.String("addr", addr))
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		healthSvc.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
		stopped := make(chan struct{})
		go func() {
			srv.GracefulStop()
			close(stopped)
		}()

		if cfg.GracefulShutdownTimeout == 0 {
			<-stopped
		} else {
			select {
			case <-stopped:
			case <-time.After(cfg.GracefulShutdownTimeout):
				srv.Stop()
			}
		}

		err = <-errCh
		if err != nil && err != grpc.ErrServerStopped {
			return fmt.Errorf("serve grpc: %w", err)
		}
		return nil
	case err = <-errCh:
		if err != nil && err != grpc.ErrServerStopped {
			return fmt.Errorf("serve grpc: %w", err)
		}
		return nil
	}
}

// CreateSession creates a session row for administrative bootstrap.
func (s *Service) CreateSession(ctx context.Context, req *sessionpb.CreateSessionRequest) (*sessionpb.CreateSessionResponse, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	row, err := s.queries.CreateSession(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("create session", err)
	}
	return &sessionpb.CreateSessionResponse{Session: sessionMetaFromRow(row)}, nil
}

// GetSession returns one session with state and event history.
func (s *Service) GetSession(ctx context.Context, req *sessionpb.GetSessionRequest) (*sessionpb.GetSessionResponse, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}
	if err := validateEventWindow(req); err != nil {
		return nil, err
	}

	row, err := s.queries.GetSession(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("get session", err)
	}

	sessionStates, err := s.listStateEntries(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	summaries, err := s.listSessionSummaries(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	events, err := s.listEvents(ctx, sessionID, req)
	if err != nil {
		return nil, err
	}

	return &sessionpb.GetSessionResponse{
		Session:       sessionMetaFromRow(row),
		SessionStates: sessionStates,
		Events:        events,
		Summaries:     summaries,
	}, nil
}

// ListSessions returns known session metadata.
func (s *Service) ListSessions(ctx context.Context, _ *sessionpb.ListSessionsRequest) (*sessionpb.ListSessionsResponse, error) {
	rows, err := s.queries.ListSessions(ctx)
	if err != nil {
		return nil, mapStoreError("list sessions", err)
	}

	items := make([]*sessionpb.SessionMeta, 0, len(rows))
	for _, row := range rows {
		items = append(items, sessionMetaFromRow(row))
	}

	return &sessionpb.ListSessionsResponse{Sessions: items}, nil
}

// DeleteSession removes one session and its events.
func (s *Service) DeleteSession(ctx context.Context, req *sessionpb.DeleteSessionRequest) (*emptypb.Empty, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	rows, err := s.queries.DeleteSession(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("delete session", err)
	}
	if rows == 0 {
		return nil, status.Error(codes.NotFound, "session not found")
	}
	return &emptypb.Empty{}, nil
}

// AppendEvent appends one serialized runner event to the session log.
func (s *Service) AppendEvent(ctx context.Context, req *sessionpb.AppendEventRequest) (*sessionpb.AppendEventResponse, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	ev := req.GetEvent()
	if ev == nil {
		return nil, status.Error(codes.InvalidArgument, "event is required")
	}
	if ev.GetEventId() == "" {
		return nil, status.Error(codes.InvalidArgument, "event.event_id is required")
	}
	if ev.GetPayload() == nil {
		return nil, status.Error(codes.InvalidArgument, "event.payload is required")
	}

	_, err = s.queries.GetSession(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("get session", err)
	}

	payload, err := jsonFromPayload(ev.GetPayload())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "event.payload: %v", err)
	}

	var out *sessionpb.SessionEvent
	if ev.GetEventTs() != nil {
		row, err := s.queries.CreateEvent(ctx, sessiondb.CreateEventParams{
			SessionID:    sessionID,
			EventID:      ev.GetEventId(),
			EventTs:      ev.GetEventTs().AsTime(),
			EventPayload: payload,
		})
		if err != nil {
			return nil, mapStoreError("append event", err)
		}
		out, err = sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
		}
	} else {
		row, err := s.queries.CreateEventNow(ctx, sessiondb.CreateEventNowParams{
			SessionID:    sessionID,
			EventID:      ev.GetEventId(),
			EventPayload: payload,
		})
		if err != nil {
			return nil, mapStoreError("append event", err)
		}
		out, err = sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
		}
	}

	rows, err := s.queries.TouchSession(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("touch session", err)
	}
	if rows == 0 {
		return nil, status.Error(codes.NotFound, "session not found")
	}

	return &sessionpb.AppendEventResponse{Event: out}, nil
}

// UpdateSessionState upserts session-scoped state entries.
func (s *Service) UpdateSessionState(ctx context.Context, req *sessionpb.UpdateSessionStateRequest) (*emptypb.Empty, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}
	if err := s.updateSessionStates(ctx, sessionID, req.GetEntries()); err != nil {
		return nil, err
	}
	return &emptypb.Empty{}, nil
}

// DeleteSessionState removes one session-scoped state key.
func (s *Service) DeleteSessionState(ctx context.Context, req *sessionpb.DeleteSessionStateRequest) (*emptypb.Empty, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}
	if err := s.deleteSessionState(ctx, sessionID, req.GetKey()); err != nil {
		return nil, err
	}
	return &emptypb.Empty{}, nil
}

// ListSessionStates returns all session-scoped state entries.
func (s *Service) ListSessionStates(ctx context.Context, req *sessionpb.ListSessionStatesRequest) (*sessionpb.ListSessionStatesResponse, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	items, err := s.listStateEntries(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return &sessionpb.ListSessionStatesResponse{Entries: items}, nil
}

// UpsertSessionSummary persists one session summary.
func (s *Service) UpsertSessionSummary(ctx context.Context, req *sessionpb.UpsertSessionSummaryRequest) (*emptypb.Empty, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}
	if err := s.upsertSessionSummary(ctx, sessionID, req.GetSummary()); err != nil {
		return nil, err
	}
	return &emptypb.Empty{}, nil
}

// ListSessionSummaries returns persisted summaries for one session.
func (s *Service) ListSessionSummaries(ctx context.Context, req *sessionpb.ListSessionSummariesRequest) (*sessionpb.ListSessionSummariesResponse, error) {
	sessionID, err := parseSessionID(req.GetSessionId())
	if err != nil {
		return nil, err
	}
	items, err := s.listSessionSummaries(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return &sessionpb.ListSessionSummariesResponse{Summaries: items}, nil
}

func (s *Service) updateSessionStates(ctx context.Context, sessionID uuid.UUID, entries []*sessionpb.StateEntry) error {
	_, err := s.queries.GetSession(ctx, sessionID)
	if err != nil {
		return mapStoreError("get session", err)
	}

	for _, entry := range entries {
		if entry == nil {
			return status.Error(codes.InvalidArgument, "state entry is required")
		}
		if entry.GetKey() == "" {
			return status.Error(codes.InvalidArgument, "state key is required")
		}
		if strings.Contains(entry.GetKey(), ":") {
			return status.Error(codes.InvalidArgument, "scoped state keys are not supported")
		}

		err = s.queries.UpsertStateEntry(ctx, sessiondb.UpsertStateEntryParams{
			SessionID: sessionID,
			Key:       entry.GetKey(),
			Value:     slices.Clone(entry.GetValue()),
		})
		if err != nil {
			return mapStoreError("upsert state", err)
		}
	}

	rows, err := s.queries.TouchSession(ctx, sessionID)
	if err != nil {
		return mapStoreError("touch session", err)
	}
	if rows == 0 {
		return status.Error(codes.NotFound, "session not found")
	}
	return nil
}

func (s *Service) deleteSessionState(ctx context.Context, sessionID uuid.UUID, key string) error {
	if key == "" {
		return status.Error(codes.InvalidArgument, "key is required")
	}

	rows, err := s.queries.DeleteStateEntry(ctx, sessiondb.DeleteStateEntryParams{
		SessionID: sessionID,
		Key:       key,
	})
	if err != nil {
		return mapStoreError("delete state", err)
	}

	_, touchErr := s.queries.TouchSession(ctx, sessionID)
	if touchErr != nil {
		return mapStoreError("touch session", touchErr)
	}
	if rows == 0 {
		return status.Error(codes.NotFound, "state key not found")
	}
	return nil
}

func (s *Service) listStateEntries(ctx context.Context, sessionID uuid.UUID) ([]*sessionpb.StateEntry, error) {
	rows, err := s.queries.ListStateEntries(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("list states", err)
	}

	items := make([]*sessionpb.StateEntry, 0, len(rows))
	for _, row := range rows {
		items = append(items, &sessionpb.StateEntry{
			Key:   row.Key,
			Value: slices.Clone(row.Value),
		})
	}
	return items, nil
}

func (s *Service) upsertSessionSummary(ctx context.Context, sessionID uuid.UUID, item *sessionpb.SessionSummary) error {
	_, err := s.queries.GetSession(ctx, sessionID)
	if err != nil {
		return mapStoreError("get session", err)
	}
	if item == nil {
		return status.Error(codes.InvalidArgument, "summary is required")
	}
	if item.GetUpdatedAt() == nil {
		return status.Error(codes.InvalidArgument, "summary.updated_at is required")
	}

	raw, err := json.Marshal(agentsession.Summary{
		Summary:   item.GetSummary(),
		Topics:    slices.Clone(item.GetTopics()),
		UpdatedAt: item.GetUpdatedAt().AsTime().UTC(),
	})
	if err != nil {
		return status.Errorf(codes.Internal, "marshal summary: %v", err)
	}

	err = s.queries.UpsertSessionSummary(ctx, sessiondb.UpsertSessionSummaryParams{
		SessionID: sessionID,
		FilterKey: item.GetFilterKey(),
		Summary:   raw,
		UpdatedAt: item.GetUpdatedAt().AsTime().UTC(),
	})
	if err != nil {
		return mapStoreError("upsert session summary", err)
	}
	return nil
}

func (s *Service) listSessionSummaries(ctx context.Context, sessionID uuid.UUID) ([]*sessionpb.SessionSummary, error) {
	rows, err := s.queries.ListSessionSummaries(ctx, sessionID)
	if err != nil {
		return nil, mapStoreError("list session summaries", err)
	}

	items := make([]*sessionpb.SessionSummary, 0, len(rows))
	for _, row := range rows {
		item, err := sessionSummaryFromJSON(row.FilterKey, row.Summary)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "decode session summary: %v", err)
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) listEvents(ctx context.Context, sessionID uuid.UUID, req *sessionpb.GetSessionRequest) ([]*sessionpb.SessionEvent, error) {
	switch {
	case req.GetEventPageLimit() > 0:
		if req.GetEventPageBeforeSeq() > 0 {
			rows, err := s.queries.ListEventPage(ctx, sessiondb.ListEventPageParams{
				SessionID: sessionID,
				Seq:       req.GetEventPageBeforeSeq(),
				Limit:     req.GetEventPageLimit(),
			})
			if err != nil {
				return nil, mapStoreError("list event page", err)
			}
			slices.Reverse(rows)
			items := make([]*sessionpb.SessionEvent, 0, len(rows))
			for _, row := range rows {
				item, err := sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
				if err != nil {
					return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
				}
				items = append(items, item)
			}
			return items, nil
		}

		rows, err := s.queries.ListRecentEvents(ctx, sessiondb.ListRecentEventsParams{
			SessionID: sessionID,
			Limit:     req.GetEventPageLimit(),
		})
		if err != nil {
			return nil, mapStoreError("list recent events", err)
		}
		slices.Reverse(rows)
		items := make([]*sessionpb.SessionEvent, 0, len(rows))
		for _, row := range rows {
			item, err := sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
			if err != nil {
				return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
			}
			items = append(items, item)
		}
		return items, nil
	case req.GetEventNum() > 0:
		rows, err := s.queries.ListRecentEvents(ctx, sessiondb.ListRecentEventsParams{
			SessionID: sessionID,
			Limit:     req.GetEventNum(),
		})
		if err != nil {
			return nil, mapStoreError("list recent events", err)
		}
		slices.Reverse(rows)
		items := make([]*sessionpb.SessionEvent, 0, len(rows))
		for _, row := range rows {
			item, err := sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
			if err != nil {
				return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
			}
			items = append(items, item)
		}
		return items, nil
	case req.GetEventTime() != nil:
		rows, err := s.queries.ListEventsAfter(ctx, sessiondb.ListEventsAfterParams{
			SessionID: sessionID,
			EventTs:   req.GetEventTime().AsTime(),
		})
		if err != nil {
			return nil, mapStoreError("list events after", err)
		}
		items := make([]*sessionpb.SessionEvent, 0, len(rows))
		for _, row := range rows {
			item, err := sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
			if err != nil {
				return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
			}
			items = append(items, item)
		}
		return items, nil
	default:
		rows, err := s.queries.ListEvents(ctx, sessionID)
		if err != nil {
			return nil, mapStoreError("list events", err)
		}
		items := make([]*sessionpb.SessionEvent, 0, len(rows))
		for _, row := range rows {
			item, err := sessionEventFromJSON(row.Seq, row.EventID, row.EventTs, row.EventPayload)
			if err != nil {
				return nil, status.Errorf(codes.Internal, "decode event payload: %v", err)
			}
			items = append(items, item)
		}
		return items, nil
	}
}

func validateEventWindow(req *sessionpb.GetSessionRequest) error {
	if req.GetEventPageLimit() == 0 && req.GetEventPageBeforeSeq() == 0 {
		return nil
	}
	if req.GetEventPageLimit() <= 0 || req.GetEventPageBeforeSeq() < 0 {
		return status.Error(codes.InvalidArgument, "invalid event page")
	}
	if req.GetEventNum() > 0 || req.GetEventTime() != nil {
		return status.Error(codes.InvalidArgument, "event page conflicts with event filters")
	}
	return nil
}

func sessionMetaFromRow(row sessiondb.Session) *sessionpb.SessionMeta {
	return &sessionpb.SessionMeta{
		SessionId: row.SessionID.String(),
		CreatedAt: timestamppb.New(row.CreatedAt),
		UpdatedAt: timestamppb.New(row.UpdatedAt),
	}
}

func sessionEventFromJSON(seq int64, eventID string, eventTS time.Time, raw []byte) (*sessionpb.SessionEvent, error) {
	payload, err := payloadFromJSON(raw)
	if err != nil {
		return nil, err
	}
	return &sessionpb.SessionEvent{
		Seq:     seq,
		EventId: eventID,
		EventTs: timestamppb.New(eventTS),
		Payload: payload,
	}, nil
}

func sessionSummaryFromJSON(filterKey string, raw []byte) (*sessionpb.SessionSummary, error) {
	var sum agentsession.Summary
	err := json.Unmarshal(raw, &sum)
	if err != nil {
		return nil, fmt.Errorf("unmarshal summary: %w", err)
	}
	return &sessionpb.SessionSummary{
		FilterKey: filterKey,
		Summary:   sum.Summary,
		Topics:    slices.Clone(sum.Topics),
		UpdatedAt: timestamppb.New(sum.UpdatedAt),
	}, nil
}

func marshalEvent(evt *event.Event) ([]byte, error) {
	if evt == nil {
		return nil, fmt.Errorf("event is nil")
	}
	stored := *evt
	stored.ExecutionTrace = nil
	stored.StructuredOutput = nil
	raw, err := json.Marshal(&stored)
	if err != nil {
		return nil, fmt.Errorf("marshal event: %w", err)
	}
	return raw, nil
}

func payloadFromEvent(evt *event.Event) (*structpb.Struct, error) {
	raw, err := marshalEvent(evt)
	if err != nil {
		return nil, err
	}
	return payloadFromJSON(raw)
}

func payloadFromJSON(raw []byte) (*structpb.Struct, error) {
	payload := &structpb.Struct{}
	err := protojson.Unmarshal(raw, payload)
	if err != nil {
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}
	return payload, nil
}

func jsonFromPayload(payload *structpb.Struct) ([]byte, error) {
	if payload == nil {
		return nil, fmt.Errorf("payload is nil")
	}
	raw, err := protojson.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}
	return raw, nil
}

func unmarshalEvent(raw []byte) (*event.Event, error) {
	var evt event.Event
	err := json.Unmarshal(raw, &evt)
	if err != nil {
		return nil, fmt.Errorf("unmarshal event: %w", err)
	}
	return &evt, nil
}

func unmarshalEventPayload(item *sessionpb.SessionEvent) (*event.Event, error) {
	if item == nil {
		return nil, status.Error(codes.Internal, "session event is missing")
	}
	raw, err := jsonFromPayload(item.GetPayload())
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}
	evt, err := unmarshalEvent(raw)
	if err != nil {
		return nil, err
	}
	evt.ID = item.GetEventId()
	if item.GetEventTs() != nil {
		evt.Timestamp = item.GetEventTs().AsTime()
	}
	return evt, nil
}

func buildSession(meta *sessionpb.SessionMeta, sessionStates []*sessionpb.StateEntry, eventsPB []*sessionpb.SessionEvent, summariesPB []*sessionpb.SessionSummary) (*agentsession.Session, error) {
	if meta == nil {
		return nil, status.Error(codes.Internal, "session metadata missing")
	}

	items := make([]event.Event, 0, len(eventsPB))
	for _, item := range eventsPB {
		evt, err := unmarshalEventPayload(item)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "decode event: %v", err)
		}
		items = append(items, *evt)
	}

	state := make(agentsession.StateMap)
	for _, item := range sessionStates {
		if item == nil {
			return nil, status.Error(codes.Internal, "session state entry is missing")
		}
		state[item.GetKey()] = slices.Clone(item.GetValue())
	}

	summaries := make(map[string]*agentsession.Summary, len(summariesPB))
	for _, item := range summariesPB {
		if item == nil {
			return nil, status.Error(codes.Internal, "session summary is missing")
		}
		summaries[item.GetFilterKey()] = &agentsession.Summary{
			Summary:   item.GetSummary(),
			Topics:    slices.Clone(item.GetTopics()),
			UpdatedAt: item.GetUpdatedAt().AsTime(),
		}
	}

	sess := agentsession.NewSession(
		DefaultAppName,
		DefaultUserID,
		meta.GetSessionId(),
		agentsession.WithSessionCreatedAt(meta.GetCreatedAt().AsTime()),
		agentsession.WithSessionUpdatedAt(meta.GetUpdatedAt().AsTime()),
		agentsession.WithSessionState(state),
		agentsession.WithSessionEvents(items),
		agentsession.WithSessionSummaries(summaries),
	)
	return sess, nil
}

func mapStoreError(action string, err error) error {
	if err == nil {
		return nil
	}
	if status.Code(err) != codes.Unknown {
		return err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return status.Errorf(codes.NotFound, "%s: not found", action)
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		if pgErr.Code == "23505" {
			return status.Errorf(codes.AlreadyExists, "%s: already exists", action)
		}
	}
	return status.Errorf(codes.Internal, "%s: %v", action, err)
}
