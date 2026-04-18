package sessionstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/timestamppb"

	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
	"trpc.group/trpc-go/trpc-agent-go/event"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
)

// ClientConfig configures the remote session service adapter.
type ClientConfig struct {
	Target    string
	Insecure  bool
	Timeout   time.Duration
	SessionID string
}

// Client implements session.Service over gRPC.
type Client struct {
	conn      *grpc.ClientConn
	client    sessionpb.SessionServiceClient
	timeout   time.Duration
	sessionID string
}

// NewSessionServiceClient dials the remote session service.
func NewSessionServiceClient(cfg ClientConfig) (*Client, error) {
	target := strings.TrimSpace(cfg.Target)
	if target == "" {
		target = DefaultTarget
	}

	if !cfg.Insecure {
		return nil, fmt.Errorf("tls is not implemented for the session client yet")
	}
	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	conn, err := grpc.NewClient(target, opts...)
	if err != nil {
		return nil, fmt.Errorf("dial session service: %w", err)
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	sessionID := strings.TrimSpace(cfg.SessionID)
	if sessionID != "" {
		sessionID, err = normalizeSessionID(sessionID)
		if err != nil {
			conn.Close()
			return nil, err
		}
	}

	return &Client{
		conn:      conn,
		client:    sessionpb.NewSessionServiceClient(conn),
		timeout:   timeout,
		sessionID: sessionID,
	}, nil
}

// CreateSession creates a new persisted session for administrative use.
func (s *Client) CreateSession(ctx context.Context, key agentsession.Key, state agentsession.StateMap, _ ...agentsession.Option) (*agentsession.Session, error) {
	if err := validateSessionKey(key); err != nil {
		return nil, err
	}
	if len(state) > 0 {
		return nil, fmt.Errorf("initial session state is not supported")
	}

	sessionID, err := normalizeSessionID(key.SessionID)
	if err != nil {
		return nil, err
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	resp, err := s.client.CreateSession(callCtx, &sessionpb.CreateSessionRequest{
		SessionId: sessionID,
	})
	if err != nil {
		return nil, err
	}

	return buildSession(resp.GetSession(), nil, nil)
}

// GetSession loads one session, its state, and filtered events.
func (s *Client) GetSession(ctx context.Context, key agentsession.Key, opts ...agentsession.Option) (*agentsession.Session, error) {
	if err := validateSessionKey(key); err != nil {
		return nil, err
	}

	sessionID, err := normalizeSessionID(key.SessionID)
	if err != nil {
		return nil, err
	}

	opt := &agentsession.Options{}
	for _, o := range opts {
		o(opt)
	}
	if err := agentsession.ValidateGetSessionOptions(opt, true); err != nil {
		return nil, err
	}

	req := &sessionpb.GetSessionRequest{
		SessionId: sessionID,
		EventNum:  int32(opt.EventNum),
	}
	if !opt.EventTime.IsZero() {
		req.EventTime = timestamppb.New(opt.EventTime)
	}
	if opt.EventPage != nil {
		req.EventPageLimit = int32(opt.EventPage.Limit)
		req.EventPageBeforeSeq = int64(opt.EventPage.Offset)
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	resp, err := s.client.GetSession(callCtx, req)
	if err != nil {
		return nil, err
	}
	return buildSession(
		resp.GetSession(),
		resp.GetSessionStates(),
		resp.GetEvents(),
	)
}

// ListSessions lists known sessions for the fixed app/user scope.
func (s *Client) ListSessions(ctx context.Context, userKey agentsession.UserKey, opts ...agentsession.Option) ([]*agentsession.Session, error) {
	if err := validateUserKey(userKey); err != nil {
		return nil, err
	}

	opt := &agentsession.Options{}
	for _, o := range opts {
		o(opt)
	}
	if err := agentsession.ValidateListSessionsOptions(opt); err != nil {
		return nil, err
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	resp, err := s.client.ListSessions(callCtx, &sessionpb.ListSessionsRequest{})
	if err != nil {
		return nil, err
	}

	items := make([]*agentsession.Session, 0, len(resp.GetSessions()))
	for _, meta := range resp.GetSessions() {
		if opt.ListSessionOnlyMeta {
			sess, buildErr := buildSession(meta, nil, nil)
			if buildErr != nil {
				return nil, buildErr
			}
			items = append(items, sess)
			continue
		}

		sess, getErr := s.GetSession(ctx, agentsession.Key{
			AppName:   userKey.AppName,
			UserID:    userKey.UserID,
			SessionID: meta.GetSessionId(),
		})
		if getErr != nil {
			return nil, getErr
		}
		items = append(items, sess)
	}

	return items, nil
}

// DeleteSession deletes one persisted session.
func (s *Client) DeleteSession(ctx context.Context, key agentsession.Key, _ ...agentsession.Option) error {
	if err := validateSessionKey(key); err != nil {
		return err
	}

	sessionID, err := normalizeSessionID(key.SessionID)
	if err != nil {
		return err
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	_, err = s.client.DeleteSession(callCtx, &sessionpb.DeleteSessionRequest{
		SessionId: sessionID,
	})
	return err
}

// UpdateAppState rejects app-scoped state because the store is session-only.
func (s *Client) UpdateAppState(context.Context, string, agentsession.StateMap) error {
	return errUnsupportedScopeState("app")
}

// DeleteAppState rejects app-scoped state because the store is session-only.
func (s *Client) DeleteAppState(context.Context, string, string) error {
	return errUnsupportedScopeState("app")
}

// ListAppStates rejects app-scoped state because the store is session-only.
func (s *Client) ListAppStates(context.Context, string) (agentsession.StateMap, error) {
	return nil, errUnsupportedScopeState("app")
}

// UpdateUserState rejects user-scoped state because the store is session-only.
func (s *Client) UpdateUserState(context.Context, agentsession.UserKey, agentsession.StateMap) error {
	return errUnsupportedScopeState("user")
}

// ListUserStates rejects user-scoped state because the store is session-only.
func (s *Client) ListUserStates(context.Context, agentsession.UserKey) (agentsession.StateMap, error) {
	return nil, errUnsupportedScopeState("user")
}

// DeleteUserState rejects user-scoped state because the store is session-only.
func (s *Client) DeleteUserState(context.Context, agentsession.UserKey, string) error {
	return errUnsupportedScopeState("user")
}

// UpdateSessionState upserts one session's direct state map.
func (s *Client) UpdateSessionState(ctx context.Context, key agentsession.Key, state agentsession.StateMap) error {
	if err := validateSessionKey(key); err != nil {
		return err
	}

	sessionID, err := normalizeSessionID(key.SessionID)
	if err != nil {
		return err
	}

	for k := range state {
		if strings.Contains(k, ":") {
			return fmt.Errorf("%s is not allowed, scoped state keys are not supported", k)
		}
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	items := make([]*sessionpb.StateEntry, 0, len(state))
	for key, value := range state {
		items = append(items, &sessionpb.StateEntry{
			Key:   key,
			Value: append([]byte(nil), value...),
		})
	}

	_, err = s.client.UpdateSessionState(callCtx, &sessionpb.UpdateSessionStateRequest{
		SessionId: sessionID,
		Entries:   items,
	})
	return err
}

// AppendEvent appends one event to the remote session and updates the local session copy.
func (s *Client) AppendEvent(ctx context.Context, sess *agentsession.Session, evt *event.Event, opts ...agentsession.Option) error {
	if sess == nil {
		return agentsession.ErrNilSession
	}
	key := agentsession.Key{
		AppName:   sess.AppName,
		UserID:    sess.UserID,
		SessionID: sess.ID,
	}
	if err := validateSessionKey(key); err != nil {
		return err
	}
	if evt == nil {
		return fmt.Errorf("event is nil")
	}
	if evt.ID == "" {
		evt.ID = uuid.NewString()
	}

	payload, err := payloadFromEvent(evt)
	if err != nil {
		return err
	}

	sessionID, err := normalizeSessionID(sess.ID)
	if err != nil {
		return err
	}

	req := &sessionpb.AppendEventRequest{
		SessionId: sessionID,
		Event: &sessionpb.SessionEvent{
			EventId: evt.ID,
			Payload: payload,
		},
	}
	if !evt.Timestamp.IsZero() {
		req.Event.EventTs = timestamppb.New(evt.Timestamp)
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	resp, err := s.client.AppendEvent(callCtx, req)
	if err != nil {
		return err
	}
	if stored := resp.GetEvent(); stored != nil {
		evt.ID = stored.GetEventId()
		if stored.GetEventTs() != nil {
			evt.Timestamp = stored.GetEventTs().AsTime()
		}
	}
	sess.UpdateUserSession(evt, opts...)
	return nil
}

// CreateSessionSummary is a no-op until summary persistence is added.
func (s *Client) CreateSessionSummary(ctx context.Context, sess *agentsession.Session, filterKey string, force bool) error {
	return nil
}

// EnqueueSummaryJob is a no-op until summary persistence is added.
func (s *Client) EnqueueSummaryJob(ctx context.Context, sess *agentsession.Session, filterKey string, force bool) error {
	return nil
}

// GetSessionSummaryText reports no persisted summary for now.
func (s *Client) GetSessionSummaryText(ctx context.Context, sess *agentsession.Session, opts ...agentsession.SummaryOption) (string, bool) {
	return "", false
}

// Close closes the underlying gRPC connection.
func (s *Client) Close() error {
	if s == nil || s.conn == nil {
		return nil
	}
	return s.conn.Close()
}

// EnsureSessionExists verifies the configured session exists before agent use.
func (s *Client) EnsureSessionExists(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		sessionID = s.sessionID
	}
	if sessionID == "" {
		return errors.New("session id is required")
	}

	sessionID, err := normalizeSessionID(sessionID)
	if err != nil {
		return err
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	_, err = s.client.GetSession(callCtx, &sessionpb.GetSessionRequest{
		SessionId: sessionID,
	})
	return err
}

func (s *Client) rpcContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if s.timeout <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, s.timeout)
}

func validateUserKey(key agentsession.UserKey) error {
	if err := key.CheckUserKey(); err != nil {
		return err
	}
	if key.AppName != DefaultAppName {
		return fmt.Errorf("unexpected appName %q", key.AppName)
	}
	if key.UserID != DefaultUserID {
		return fmt.Errorf("unexpected userID %q", key.UserID)
	}
	return nil
}

func validateSessionKey(key agentsession.Key) error {
	if err := key.CheckSessionKey(); err != nil {
		return err
	}
	if key.AppName != DefaultAppName {
		return fmt.Errorf("unexpected appName %q", key.AppName)
	}
	if key.UserID != DefaultUserID {
		return fmt.Errorf("unexpected userID %q", key.UserID)
	}
	_, err := normalizeSessionID(key.SessionID)
	return err
}

func errUnsupportedScopeState(scope string) error {
	return fmt.Errorf("%s-scoped state is not supported", scope)
}

var (
	_ agentsession.Service = (*Client)(nil)
	_ io.Closer            = (*Client)(nil)
)
