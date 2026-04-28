package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/valkey-io/valkey-go"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

type runMeta struct {
	SessionID string
	RunID     string
	RequestID string
	State     runState
	Error     string
}

type runState int

const (
	runStateRunning runState = iota + 1
	runStateCompleted
	runStateInterrupted
	runStateFailed
)

type storedEvent struct {
	Sequence int64                          `json:"sequence"`
	Event    *gatewayapi.SessionStreamEvent `json:"event"`
}

type valkeyStore struct {
	client valkey.Client
	ttl    time.Duration

	mu      sync.Mutex
	waiters map[string]map[chan struct{}]struct{}
}

func newValkeyStore(addr string, ttl time.Duration) (*valkeyStore, error) {
	client, err := valkey.NewClient(valkey.ClientOption{
		InitAddress: []string{addr},
	})
	if err != nil {
		return nil, fmt.Errorf("create valkey client: %w", err)
	}
	return &valkeyStore{
		client:  client,
		ttl:     ttl,
		waiters: make(map[string]map[chan struct{}]struct{}),
	}, nil
}

func (s *valkeyStore) Close() error {
	if s == nil || s.client == nil {
		return nil
	}
	s.client.Close()
	return nil
}

func (s *valkeyStore) initRun(ctx context.Context, meta runMeta) error {
	meta.State = runStateRunning
	fields := map[string]string{
		"session_id": meta.SessionID,
		"run_id":     meta.RunID,
		"request_id": meta.RequestID,
		"state":      strconv.Itoa(int(meta.State)),
		"error":      meta.Error,
	}
	cmd := s.client.B().Hset().Key(metaKey(meta.RunID)).FieldValue()
	for k, v := range fields {
		cmd = cmd.FieldValue(k, v)
	}
	if err := s.client.Do(ctx, cmd.Build()).Error(); err != nil {
		return fmt.Errorf("init run meta: %w", err)
	}
	return nil
}

func (s *valkeyStore) appendEvent(ctx context.Context, runID string, evt *gatewayapi.SessionStreamEvent) error {
	nextSeq, err := s.client.Do(ctx, s.client.B().Incr().Key(seqKey(runID)).Build()).AsInt64()
	if err != nil {
		return fmt.Errorf("next sequence: %w", err)
	}
	seqEvt, err := eventWithSequence(evt, nextSeq)
	if err != nil {
		return fmt.Errorf("set event sequence: %w", err)
	}

	payload, err := json.Marshal(storedEvent{
		Sequence: nextSeq,
		Event:    seqEvt,
	})
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	xadd := s.client.B().Xadd().
		Key(streamKey(runID)).
		Id("*").
		FieldValue().
		FieldValue("payload", string(payload)).
		FieldValue("sequence", strconv.FormatInt(nextSeq, 10)).
		Build()
	if err := s.client.Do(ctx, xadd).Error(); err != nil {
		return fmt.Errorf("append event: %w", err)
	}

	state := eventState(seqEvt)
	if isTerminalState(state) {
		if err := s.updateRunState(ctx, runID, state, eventError(seqEvt)); err != nil {
			return err
		}
		if err := s.applyTTL(ctx, runID); err != nil {
			return err
		}
	}

	s.notify(runID)
	return nil
}

func (s *valkeyStore) updateRunState(ctx context.Context, runID string, state runState, errMsg string) error {
	cmd := s.client.B().
		Hset().
		Key(metaKey(runID)).
		FieldValue().
		FieldValue("state", strconv.Itoa(int(state))).
		FieldValue("error", errMsg).
		Build()
	if err := s.client.Do(ctx, cmd).Error(); err != nil {
		return fmt.Errorf("update run state: %w", err)
	}
	return nil
}

func (s *valkeyStore) getRun(ctx context.Context, runID string) (runMeta, error) {
	fields, err := s.client.Do(ctx, s.client.B().Hgetall().Key(metaKey(runID)).Build()).AsStrMap()
	if err != nil {
		return runMeta{}, fmt.Errorf("get run meta: %w", err)
	}
	if len(fields) == 0 {
		return runMeta{}, errRunNotFound
	}
	stateNum, _ := strconv.Atoi(fields["state"])
	return runMeta{
		SessionID: fields["session_id"],
		RunID:     fields["run_id"],
		RequestID: fields["request_id"],
		State:     runState(stateNum),
		Error:     fields["error"],
	}, nil
}

func (s *valkeyStore) replay(ctx context.Context, runID string, afterSeq int64) ([]*gatewayapi.SessionStreamEvent, error) {
	items, err := s.client.Do(ctx, s.client.B().Xrange().Key(streamKey(runID)).Start("-").End("+").Build()).AsXRange()
	if err != nil {
		return nil, fmt.Errorf("replay stream: %w", err)
	}

	evts := make([]*gatewayapi.SessionStreamEvent, 0, len(items))
	for _, item := range items {
		payload := item.FieldValues["payload"]
		if payload == "" {
			continue
		}
		var stored storedEvent
		if err := json.Unmarshal([]byte(payload), &stored); err != nil {
			return nil, fmt.Errorf("decode event payload: %w", err)
		}
		if stored.Sequence <= afterSeq || stored.Event == nil {
			continue
		}
		evts = append(evts, stored.Event)
	}
	return evts, nil
}

func (s *valkeyStore) waitForAppend(ctx context.Context, runID string, timeout time.Duration) bool {
	ch := make(chan struct{}, 1)
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	s.mu.Lock()
	waiters := s.waiters[runID]
	if waiters == nil {
		waiters = make(map[chan struct{}]struct{})
		s.waiters[runID] = waiters
	}
	waiters[ch] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.waiters[runID], ch)
		if len(s.waiters[runID]) == 0 {
			delete(s.waiters, runID)
		}
		s.mu.Unlock()
	}()

	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	case <-ch:
		return true
	}
}

func (s *valkeyStore) notify(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.waiters[runID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (s *valkeyStore) applyTTL(ctx context.Context, runID string) error {
	secs := int64(s.ttl / time.Second)
	keys := []string{metaKey(runID), seqKey(runID), streamKey(runID)}
	for _, key := range keys {
		err := s.client.Do(ctx, s.client.B().Expire().Key(key).Seconds(secs).Build()).Error()
		if err != nil {
			return fmt.Errorf("expire %s: %w", key, err)
		}
	}
	return nil
}

func metaKey(runID string) string {
	return "agw:run:" + runID + ":meta"
}

func seqKey(runID string) string {
	return "agw:run:" + runID + ":seq"
}

func streamKey(runID string) string {
	return "agw:run:" + runID + ":events"
}

func eventState(evt *gatewayapi.SessionStreamEvent) runState {
	if evt == nil {
		return runStateRunning
	}
	t, err := evt.Discriminator()
	if err != nil {
		return runStateRunning
	}
	switch gatewayapi.SessionStreamEventType(t) {
	case gatewayapi.SessionStreamEventTypeEVENTTYPERUNCOMPLETED:
		return runStateCompleted
	case gatewayapi.SessionStreamEventTypeEVENTTYPERUNINTERRUPTED:
		return runStateInterrupted
	case gatewayapi.SessionStreamEventTypeEVENTTYPERUNERROR:
		return runStateFailed
	default:
		return runStateRunning
	}
}

func eventError(evt *gatewayapi.SessionStreamEvent) string {
	if evt == nil {
		return ""
	}
	out, err := evt.AsSessionRunErrorEvent()
	if err != nil {
		return ""
	}
	return out.Error
}

func eventWithSequence(evt *gatewayapi.SessionStreamEvent, seq int64) (*gatewayapi.SessionStreamEvent, error) {
	if evt == nil {
		return nil, fmt.Errorf("event is nil")
	}
	switch v, err := evt.ValueByDiscriminator(); {
	case err != nil:
		return nil, err
	case v == nil:
		return nil, fmt.Errorf("event discriminator is empty")
	default:
		var out gatewayapi.SessionStreamEvent
		switch e := v.(type) {
		case gatewayapi.SessionStreamUnspecifiedEvent:
			e.Sequence = seq
			return &out, out.FromSessionStreamUnspecifiedEvent(e)
		case gatewayapi.SessionRunStartedEvent:
			e.Sequence = seq
			return &out, out.FromSessionRunStartedEvent(e)
		case gatewayapi.SessionAssistantDeltaEvent:
			e.Sequence = seq
			return &out, out.FromSessionAssistantDeltaEvent(e)
		case gatewayapi.SessionAssistantMessageEvent:
			e.Sequence = seq
			return &out, out.FromSessionAssistantMessageEvent(e)
		case gatewayapi.SessionToolCallEvent:
			e.Sequence = seq
			return &out, out.FromSessionToolCallEvent(e)
		case gatewayapi.SessionToolResultEvent:
			e.Sequence = seq
			return &out, out.FromSessionToolResultEvent(e)
		case gatewayapi.SessionRunCompletedEvent:
			e.Sequence = seq
			return &out, out.FromSessionRunCompletedEvent(e)
		case gatewayapi.SessionRunInterruptedEvent:
			e.Sequence = seq
			return &out, out.FromSessionRunInterruptedEvent(e)
		case gatewayapi.SessionRunErrorEvent:
			e.Sequence = seq
			return &out, out.FromSessionRunErrorEvent(e)
		default:
			return nil, fmt.Errorf("unsupported event type %T", v)
		}
	}
}

func isTerminalState(state runState) bool {
	return state == runStateCompleted ||
		state == runStateInterrupted ||
		state == runStateFailed
}
