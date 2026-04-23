package repl

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"trpc.group/trpc-go/trpc-agent-go/model"

	sessionstore "github.com/accuknox/clawarmor/internal/session"
	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
)

const defaultHistoryLimit = 25

type historyConfig struct {
	Target    string
	Insecure  bool
	SessionID string
	Limit     int
}

func printChatHistory(ctx context.Context, w io.Writer, cfg historyConfig) error {
	if strings.TrimSpace(cfg.SessionID) == "" {
		return fmt.Errorf("session id is required")
	}
	if !cfg.Insecure {
		return fmt.Errorf("tls is not implemented for the session client yet")
	}

	target := strings.TrimSpace(cfg.Target)
	if target == "" {
		target = sessionstore.DefaultTarget
	}

	limit := cfg.Limit
	if limit <= 0 {
		limit = defaultHistoryLimit
	}

	conn, err := grpc.NewClient(
		target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return fmt.Errorf("dial session service: %w", err)
	}
	defer conn.Close()

	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	resp, err := sessionpb.NewSessionServiceClient(conn).GetChatHistory(
		callCtx,
		&sessionpb.GetChatHistoryRequest{
			SessionId: cfg.SessionID,
			PageSize:  int32(limit),
		},
	)
	if err != nil {
		return err
	}

	if len(resp.GetItems()) == 0 {
		return nil
	}

	fmt.Fprintln(w, "\n[history]")
	items := resp.GetItems()
	for i := len(items) - 1; i >= 0; i-- {
		item := items[i]
		renderHistoryItem(w, item)
	}

	return nil
}

func renderHistoryItem(w io.Writer, item *sessionpb.ChatHistoryItem) {
	if item == nil {
		return
	}
	if item.GetError() != "" {
		fmt.Fprintf(w, "[error] %s\n", item.GetError())
		return
	}
	for _, tc := range item.GetToolCalls() {
		printToolCall(w, "tool_call", model.ToolCall{
			ID: tc.GetId(),
			Function: model.FunctionDefinitionParam{
				Name:      tc.GetName(),
				Arguments: []byte(tc.GetArguments()),
			},
		})
	}
	if item.GetRole() == string(model.RoleTool) {
		printToolResult(w, model.Message{
			Role:     model.RoleTool,
			ToolID:   item.GetToolCallId(),
			ToolName: item.GetToolName(),
			Content:  item.GetContent(),
		})
		return
	}

	content := strings.TrimSpace(item.GetContent())
	if content == "" {
		content = strings.TrimSpace(item.GetReasoningContent())
	}
	if content == "" {
		return
	}
	role := strings.TrimSpace(item.GetRole())
	if role == "" {
		role = "message"
	}
	fmt.Fprintf(w, "[%s] %s\n", role, content)
}
