package sessionstore

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
	"trpc.group/trpc-go/trpc-agent-go/event"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
)

const bufSize = 1024 * 1024

type testSessionServer struct {
	sessionpb.UnimplementedSessionServiceServer

	getSessionResp   *sessionpb.GetSessionResponse
	getSessionReq    *sessionpb.GetSessionRequest
	listSessionsResp *sessionpb.ListSessionsResponse

	updateSessionReq *sessionpb.UpdateSessionStateRequest
}

func (s *testSessionServer) GetSession(_ context.Context, req *sessionpb.GetSessionRequest) (*sessionpb.GetSessionResponse, error) {
	s.getSessionReq = req
	return s.getSessionResp, nil
}

func (s *testSessionServer) ListSessions(context.Context, *sessionpb.ListSessionsRequest) (*sessionpb.ListSessionsResponse, error) {
	return s.listSessionsResp, nil
}

func (s *testSessionServer) UpdateSessionState(_ context.Context, req *sessionpb.UpdateSessionStateRequest) (*emptypb.Empty, error) {
	s.updateSessionReq = req
	return &emptypb.Empty{}, nil
}

func TestRemoteServiceGetSessionLoadsStateAndEvents(t *testing.T) {
	t.Parallel()

	payload, err := payloadFromEvent(&event.Event{
		ID:        "evt-1",
		Author:    "user",
		Timestamp: time.Unix(1700000000, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("build payload: %v", err)
	}

	const sessionID = "11111111-1111-4111-8111-111111111111"

	srv := &testSessionServer{
		getSessionResp: &sessionpb.GetSessionResponse{
			Session: &sessionpb.SessionMeta{
				SessionId: sessionID,
				CreatedAt: timestamppb.New(time.Unix(1700000000, 0).UTC()),
				UpdatedAt: timestamppb.New(time.Unix(1700000100, 0).UTC()),
			},
			SessionStates: []*sessionpb.StateEntry{
				{Key: "cursor", Value: []byte("42")},
			},
			Events: []*sessionpb.SessionEvent{
				{
					Seq:     1,
					EventId: "evt-1",
					EventTs: timestamppb.New(time.Unix(1700000000, 0).UTC()),
					Payload: payload,
				},
			},
		},
	}

	client := newTestRemoteService(t, srv)
	defer client.Close()

	sess, err := client.GetSession(context.Background(), agentsession.Key{
		AppName:   DefaultAppName,
		UserID:    DefaultUserID,
		SessionID: sessionID,
	})
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sess.ID != sessionID {
		t.Fatalf("unexpected session id %q", sess.ID)
	}
	if sess.AppName != DefaultAppName {
		t.Fatalf("unexpected app name %q", sess.AppName)
	}
	if sess.UserID != DefaultUserID {
		t.Fatalf("unexpected user id %q", sess.UserID)
	}
	if got := string(sess.State["cursor"]); got != "42" {
		t.Fatalf("unexpected session state %q", got)
	}
	if len(sess.Events) != 1 {
		t.Fatalf("unexpected event count %d", len(sess.Events))
	}
	if sess.Events[0].ID != "evt-1" {
		t.Fatalf("unexpected event id %q", sess.Events[0].ID)
	}
}

func TestRemoteServiceUpdateSessionStateRejectsScopedKeys(t *testing.T) {
	t.Parallel()

	client := &Client{}

	err := client.UpdateSessionState(
		context.Background(),
		agentsession.Key{
			AppName:   DefaultAppName,
			UserID:    DefaultUserID,
			SessionID: "11111111-1111-4111-8111-111111111111",
		},
		agentsession.StateMap{
			"app:policy": []byte("strict"),
		},
	)
	if err == nil {
		t.Fatal("expected validation error")
	}
	if got := err.Error(); got == "" || !strings.Contains(got, "scoped state keys are not supported") {
		t.Fatalf("unexpected error %q", got)
	}
}

func TestRemoteServiceListSessionsOnlyMetaReturnsNoState(t *testing.T) {
	t.Parallel()

	const sessionID = "11111111-1111-4111-8111-111111111111"

	srv := &testSessionServer{
		listSessionsResp: &sessionpb.ListSessionsResponse{
			Sessions: []*sessionpb.SessionMeta{
				{
					SessionId: sessionID,
					CreatedAt: timestamppb.New(time.Unix(1700000000, 0).UTC()),
					UpdatedAt: timestamppb.New(time.Unix(1700000100, 0).UTC()),
				},
			},
		},
	}

	client := newTestRemoteService(t, srv)
	defer client.Close()

	items, err := client.ListSessions(
		context.Background(),
		agentsession.UserKey{
			AppName: DefaultAppName,
			UserID:  DefaultUserID,
		},
		agentsession.WithListSessionOnlyMeta(),
	)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("unexpected session count %d", len(items))
	}
	if len(items[0].State) != 0 {
		t.Fatalf("expected no state, got %d keys", len(items[0].State))
	}
	if len(items[0].Events) != 0 {
		t.Fatalf("expected no events, got %d", len(items[0].Events))
	}
}

func TestRemoteServiceGetSessionMapsCursorPagination(t *testing.T) {
	t.Parallel()

	const sessionID = "11111111-1111-4111-8111-111111111111"

	srv := &testSessionServer{
		getSessionResp: &sessionpb.GetSessionResponse{
			Session: &sessionpb.SessionMeta{
				SessionId: sessionID,
				CreatedAt: timestamppb.New(time.Unix(1700000000, 0).UTC()),
				UpdatedAt: timestamppb.New(time.Unix(1700000100, 0).UTC()),
			},
		},
	}

	client := newTestRemoteService(t, srv)
	defer client.Close()

	_, err := client.GetSession(
		context.Background(),
		agentsession.Key{
			AppName:   DefaultAppName,
			UserID:    DefaultUserID,
			SessionID: sessionID,
		},
		agentsession.WithGetSessionEventPage(42, 10),
	)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if srv.getSessionReq == nil {
		t.Fatal("expected get session request")
	}
	if got := srv.getSessionReq.GetEventPageBeforeSeq(); got != 42 {
		t.Fatalf("unexpected page cursor %d", got)
	}
	if got := srv.getSessionReq.GetEventPageLimit(); got != 10 {
		t.Fatalf("unexpected page limit %d", got)
	}
}

func newTestRemoteService(t *testing.T, srv sessionpb.SessionServiceServer) *Client {
	t.Helper()

	listener := bufconn.Listen(bufSize)
	server := grpc.NewServer()
	sessionpb.RegisterSessionServiceServer(server, srv)

	go func() {
		server.Serve(listener)
	}()

	t.Cleanup(func() {
		server.Stop()
		listener.Close()
	})

	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) {
			return listener.Dial()
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial bufconn: %v", err)
	}

	t.Cleanup(func() {
		conn.Close()
	})

	return &Client{
		conn:    conn,
		client:  sessionpb.NewSessionServiceClient(conn),
		timeout: time.Second,
	}
}
