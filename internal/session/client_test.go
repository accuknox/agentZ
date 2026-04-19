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

	getSessionResp           *sessionpb.GetSessionResponse
	listSessionsResp         *sessionpb.ListSessionsResponse
	listSessionSummariesResp *sessionpb.ListSessionSummariesResponse

	updateSessionReq *sessionpb.UpdateSessionStateRequest
}

func (s *testSessionServer) GetSession(_ context.Context, req *sessionpb.GetSessionRequest) (*sessionpb.GetSessionResponse, error) {
	return s.getSessionResp, nil
}

func (s *testSessionServer) ListSessions(context.Context, *sessionpb.ListSessionsRequest) (*sessionpb.ListSessionsResponse, error) {
	return s.listSessionsResp, nil
}

func (s *testSessionServer) UpdateSessionState(_ context.Context, req *sessionpb.UpdateSessionStateRequest) (*emptypb.Empty, error) {
	s.updateSessionReq = req
	return &emptypb.Empty{}, nil
}

func (s *testSessionServer) ListSessionSummaries(context.Context, *sessionpb.ListSessionSummariesRequest) (*sessionpb.ListSessionSummariesResponse, error) {
	return s.listSessionSummariesResp, nil
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
			Summaries: []*sessionpb.SessionSummary{
				{
					FilterKey: "github.com/accuknox/clawarmor",
					Summary:   "summary text",
					UpdatedAt: timestamppb.New(time.Unix(1700000200, 0).UTC()),
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
	sum := sess.Summaries["github.com/accuknox/clawarmor"]
	if sum == nil || sum.Summary != "summary text" {
		t.Fatalf("unexpected summary %#v", sum)
	}
}

func TestRemoteServiceGetSessionSummaryTextLoadsRemoteSummaries(t *testing.T) {
	t.Parallel()

	const sessionID = "11111111-1111-4111-8111-111111111111"

	client := newTestRemoteService(t, &testSessionServer{
		listSessionSummariesResp: &sessionpb.ListSessionSummariesResponse{
			Summaries: []*sessionpb.SessionSummary{
				{
					FilterKey: "",
					Summary:   "remote summary",
					UpdatedAt: timestamppb.New(time.Unix(1700000200, 0).UTC()),
				},
			},
		},
	})
	defer client.Close()

	sess := agentsession.NewSession(
		DefaultAppName,
		DefaultUserID,
		sessionID,
	)
	text, ok := client.GetSessionSummaryText(context.Background(), sess)
	if !ok {
		t.Fatal("expected summary text")
	}
	if text != "remote summary" {
		t.Fatalf("unexpected summary %q", text)
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
