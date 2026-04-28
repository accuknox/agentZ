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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
	sessionsummary "trpc.group/trpc-go/trpc-agent-go/session/summary"
)

// ClientConfig configures the remote session service adapter.
type ClientConfig struct {
	Target                string
	Insecure              bool
	Timeout               time.Duration
	SessionID             string
	Summarizer            sessionsummary.SessionSummarizer
	SummaryTokenThreshold int
	ToolResultMaxTokens   int
}

// Client implements session.Service over gRPC.
type Client struct {
	conn                  *grpc.ClientConn
	client                sessionpb.SessionServiceClient
	timeout               time.Duration
	sessionID             string
	summarizer            sessionsummary.SessionSummarizer
	summaryTokenThreshold int
	toolResultMaxTokens   int
}

// NewSessionServiceClient dials the remote session service.
func NewSessionServiceClient(cfg ClientConfig) (*Client, error) {
	target := cfg.Target
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

	sessionID := cfg.SessionID
	if sessionID != "" {
		sessionID, err = normalizeSessionID(sessionID)
		if err != nil {
			conn.Close()
			return nil, err
		}
	}

	return &Client{
		conn:                  conn,
		client:                sessionpb.NewSessionServiceClient(conn),
		timeout:               timeout,
		sessionID:             sessionID,
		summarizer:            cfg.Summarizer,
		summaryTokenThreshold: cfg.SummaryTokenThreshold,
		toolResultMaxTokens:   cfg.ToolResultMaxTokens,
	}, nil
}

// CreateSession is unsupported because the agent gateway owns Agent lifecycle.
func (s *Client) CreateSession(_ context.Context, key agentsession.Key, state agentsession.StateMap, _ ...agentsession.Option) (*agentsession.Session, error) {
	if err := validateSessionKey(key); err != nil {
		return nil, err
	}
	if len(state) > 0 {
		return nil, fmt.Errorf("initial session state is not supported")
	}
	return nil, fmt.Errorf("create session through session service is unsupported; use agent gateway")
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
		resp.GetSummaries(),
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
			sess, buildErr := buildSession(meta, nil, nil, nil)
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

// DeleteSession is unsupported because the agent gateway owns Agent lifecycle.
func (s *Client) DeleteSession(_ context.Context, key agentsession.Key, _ ...agentsession.Option) error {
	if err := validateSessionKey(key); err != nil {
		return err
	}
	return fmt.Errorf("delete session through session service is unsupported; use agent gateway")
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

	storedEvt, err := truncateEventToolResults(ctx, evt, s.toolResultMaxTokens)
	if err != nil {
		return err
	}

	payload, err := payloadFromEvent(storedEvt)
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
		if errors.Is(err, context.Canceled) || status.Code(err) == codes.Canceled {
			return nil
		}
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

// CreateSessionSummary generates and persists a summary for a session.
func (s *Client) CreateSessionSummary(ctx context.Context, sess *agentsession.Session, filterKey string, force bool) error {
	if s.summarizer == nil {
		return nil
	}

	if sess == nil {
		return agentsession.ErrNilSession
	}

	err := validateSessionKey(agentsession.Key{
		AppName:   sess.AppName,
		UserID:    sess.UserID,
		SessionID: sess.ID,
	})
	if err != nil {
		return err
	}

	sum, updated, err := s.generateSessionSummary(ctx, sess, filterKey, force)
	if err != nil || !updated {
		return err
	}

	return s.persistSessionSummary(ctx, sess.ID, filterKey, sum)
}

// EnqueueSummaryJob generates a summary synchronously for the remote service.
func (s *Client) EnqueueSummaryJob(ctx context.Context, sess *agentsession.Session, filterKey string, force bool) error {
	return s.CreateSessionSummary(ctx, sess, filterKey, force)
}

// GetSessionSummaryText returns a cached or persisted session summary.
func (s *Client) GetSessionSummaryText(ctx context.Context, sess *agentsession.Session, opts ...agentsession.SummaryOption) (string, bool) {
	if sess == nil {
		return "", false
	}

	options := &agentsession.SummaryOptions{
		FilterKey: agentsession.SummaryFilterKeyAllContents,
	}
	for _, opt := range opts {
		opt(options)
	}

	if text, ok := summaryTextFromSession(sess, options.FilterKey); ok {
		return text, true
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	resp, err := s.client.ListSessionSummaries(callCtx, &sessionpb.ListSessionSummariesRequest{
		SessionId: sess.ID,
	})
	if err != nil {
		return "", false
	}

	sess.SummariesMu.Lock()

	if sess.Summaries == nil {
		sess.Summaries = make(map[string]*agentsession.Summary, len(resp.GetSummaries()))
	}

	for _, item := range resp.GetSummaries() {
		if item == nil {
			sess.SummariesMu.Unlock()
			return "", false
		}
		sess.Summaries[item.GetFilterKey()] = &agentsession.Summary{
			Summary:   item.GetSummary(),
			Topics:    append([]string(nil), item.GetTopics()...),
			UpdatedAt: item.GetUpdatedAt().AsTime(),
		}
	}

	sess.SummariesMu.Unlock()

	return summaryTextFromSession(sess, options.FilterKey)
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

func (s *Client) generateSessionSummary(ctx context.Context, sess *agentsession.Session, filterKey string, force bool) (*agentsession.Summary, bool, error) {
	prev := sessionSummarySnapshot(sess, filterKey)
	delta, latest := summaryDeltaEvents(sess, prev.UpdatedAt, filterKey)
	if !force && len(delta) == 0 {
		return nil, false, nil
	}

	events := delta
	if strings.TrimSpace(prev.Summary) != "" {
		events = append([]event.Event{{
			Author: "system",
			Response: &model.Response{
				Choices: []model.Choice{{
					Message: model.NewSystemMessage(prev.Summary),
				}},
			},
			Timestamp: time.Now().UTC(),
		}}, delta...)
	}

	tmp := agentsession.NewSession(
		sess.AppName,
		sess.UserID,
		sess.ID,
		agentsession.WithSessionCreatedAt(sess.CreatedAt),
		agentsession.WithSessionUpdatedAt(sess.UpdatedAt),
		agentsession.WithSessionEvents(events),
	)
	if !force && !shouldSummarize(ctx, s.summarizer, tmp) &&
		!rawEventsExceedTokenThreshold(ctx, delta, s.summaryTokenThreshold) {
		return nil, false, nil
	}

	text, err := s.summarizer.Summarize(ctx, tmp)
	if err != nil {
		return nil, false, err
	}
	if strings.TrimSpace(text) == "" {
		return nil, false, nil
	}

	updatedAt := latest.UTC()
	if updatedAt.IsZero() {
		updatedAt = prev.UpdatedAt.UTC()
	}
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}

	sum := &agentsession.Summary{
		Summary:   text,
		UpdatedAt: updatedAt,
	}

	sess.SummariesMu.Lock()
	if sess.Summaries == nil {
		sess.Summaries = make(map[string]*agentsession.Summary)
	}
	sess.Summaries[filterKey] = sum
	sess.SummariesMu.Unlock()

	return sum, true, nil
}

func (s *Client) persistSessionSummary(ctx context.Context, sessionID string, filterKey string, sum *agentsession.Summary) error {
	if sum == nil {
		return nil
	}

	callCtx, cancel := s.rpcContext(ctx)
	defer cancel()

	_, err := s.client.UpsertSessionSummary(
		callCtx,
		&sessionpb.UpsertSessionSummaryRequest{
			SessionId: sessionID,
			Summary: &sessionpb.SessionSummary{
				FilterKey: filterKey,
				Summary:   sum.Summary,
				Topics:    append([]string(nil), sum.Topics...),
				UpdatedAt: timestamppb.New(sum.UpdatedAt.UTC()),
			},
		},
	)
	return err
}

func sessionSummarySnapshot(sess *agentsession.Session, filterKey string) agentsession.Summary {
	if sess == nil {
		return agentsession.Summary{}
	}
	sess.SummariesMu.RLock()
	defer sess.SummariesMu.RUnlock()
	if sess.Summaries == nil || sess.Summaries[filterKey] == nil {
		return agentsession.Summary{}
	}
	return *sess.Summaries[filterKey]
}

func summaryDeltaEvents(sess *agentsession.Session, since time.Time, filterKey string) ([]event.Event, time.Time) {
	if sess == nil {
		return nil, time.Time{}
	}

	sess.EventMu.RLock()
	defer sess.EventMu.RUnlock()

	items := make([]event.Event, 0, len(sess.Events))
	var latest time.Time
	for _, item := range sess.Events {
		if !since.IsZero() && !item.Timestamp.After(since) {
			continue
		}
		if filterKey != "" && !item.Filter(filterKey) {
			continue
		}
		items = append(items, item)
		if item.Timestamp.After(latest) {
			latest = item.Timestamp
		}
	}
	return items, latest
}

func shouldSummarize(ctx context.Context, summarizer sessionsummary.SessionSummarizer, sess *agentsession.Session) bool {
	if summarizer == nil {
		return false
	}
	contextAware, ok := summarizer.(sessionsummary.ContextAwareSummarizer)
	if ok {
		return contextAware.ShouldSummarizeWithContext(ctx, sess)
	}
	return summarizer.ShouldSummarize(sess)
}

func rawEventsExceedTokenThreshold(ctx context.Context, events []event.Event, threshold int) bool {
	if threshold <= 0 || len(events) == 0 {
		return false
	}

	var b strings.Builder
	for _, evt := range events {
		if evt.Response == nil {
			continue
		}
		for _, choice := range evt.Choices {
			content := strings.TrimSpace(choice.Message.Content)
			if content == "" {
				continue
			}
			b.WriteString(content)
			b.WriteByte('\n')
		}
	}

	content := b.String()
	if strings.TrimSpace(content) == "" {
		return false
	}

	tokens, _ := model.NewSimpleTokenCounter().CountTokens(
		ctx,
		model.Message{Content: content},
	)
	return tokens >= threshold
}

func summaryTextFromSession(sess *agentsession.Session, filterKey string) (string, bool) {
	if sess == nil {
		return "", false
	}

	sess.SummariesMu.RLock()
	defer sess.SummariesMu.RUnlock()

	if sess.Summaries == nil {
		return "", false
	}

	if item := sess.Summaries[filterKey]; item != nil &&
		strings.TrimSpace(item.Summary) != "" {
		return item.Summary, true
	}

	if filterKey != agentsession.SummaryFilterKeyAllContents {
		item := sess.Summaries[agentsession.SummaryFilterKeyAllContents]
		if item != nil && strings.TrimSpace(item.Summary) != "" {
			return item.Summary, true
		}
	}

	return "", false
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
