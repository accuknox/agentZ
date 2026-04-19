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

	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
)

const bufSize = 1024 * 1024

type testSessionServer struct {
	sessionpb.UnimplementedSessionServiceServer

	appendEventReq *sessionpb.AppendEventRequest
}

func (s *testSessionServer) AppendEvent(_ context.Context, req *sessionpb.AppendEventRequest) (*sessionpb.AppendEventResponse, error) {
	s.appendEventReq = req
	return &sessionpb.AppendEventResponse{Event: req.GetEvent()}, nil
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

func TestRemoteServiceAppendEventStoresTruncatedToolResult(t *testing.T) {
	t.Parallel()

	srv := &testSessionServer{}
	client := newTestRemoteService(t, srv)
	client.toolResultMaxTokens = 32
	defer client.Close()

	sess := agentsession.NewSession(
		DefaultAppName,
		DefaultUserID,
		"11111111-1111-4111-8111-111111111111",
	)
	content := "HEAD-" + strings.Repeat("middle-", 400) + "-TAIL"
	evt := &event.Event{
		ID:        "evt-1",
		Author:    "tool",
		Timestamp: time.Unix(1700000000, 0).UTC(),
		Response: &model.Response{
			Choices: []model.Choice{{
				Message: model.Message{
					Role:     model.RoleTool,
					ToolID:   "tool-1",
					ToolName: "worker",
					Content:  content,
				},
			}},
		},
	}

	err := client.AppendEvent(context.Background(), sess, evt)
	if err != nil {
		t.Fatalf("append event: %v", err)
	}
	if srv.appendEventReq == nil || srv.appendEventReq.GetEvent() == nil {
		t.Fatal("expected append event request")
	}

	raw, err := jsonFromPayload(srv.appendEventReq.GetEvent().GetPayload())
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	stored, err := unmarshalEvent(raw)
	if err != nil {
		t.Fatalf("unmarshal event: %v", err)
	}

	got := stored.Choices[0].Message.Content
	if got == content {
		t.Fatal("expected stored payload to be truncated")
	}
	if !strings.Contains(got, "[... ") {
		t.Fatalf("expected truncation marker, got %q", got)
	}
	if evt.Choices[0].Message.Content != content {
		t.Fatal("expected original event content to remain unchanged")
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
