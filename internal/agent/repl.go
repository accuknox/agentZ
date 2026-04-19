package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
	"github.com/chzyer/readline"
	"trpc.group/trpc-go/trpc-agent-go/model"
)

const replPrompt = "> "

// REPLOptions configures the remote agent REPL.
type REPLOptions struct {
	Target string
}

// RunREPL runs an interactive remote chat session.
func RunREPL(ctx context.Context, opts REPLOptions) error {
	cl, err := NewClient(ClientConfig{Target: opts.Target})
	if err != nil {
		return err
	}
	defer cl.Close()

	historyPath := filepath.Join(os.TempDir(), "clawarmor-agent.history")
	rl, err := readline.NewEx(&readline.Config{
		Prompt:          replPrompt,
		HistoryFile:     historyPath,
		InterruptPrompt: "^C",
		EOFPrompt:       "exit",
	})
	if err != nil {
		return fmt.Errorf("create readline failed: %w", err)
	}
	defer rl.Close()

	fmt.Fprintln(rl.Stdout(), "Type /help for commands.")

	for {
		line, readErr := rl.Readline()
		if errors.Is(readErr, io.EOF) {
			fmt.Fprintln(rl.Stdout())
			return nil
		}
		if errors.Is(readErr, readline.ErrInterrupt) {
			if strings.TrimSpace(line) == "" {
				continue
			}
			continue
		}
		if readErr != nil {
			return fmt.Errorf("read line failed: %w", readErr)
		}

		input := strings.TrimSpace(line)
		if input == "" {
			continue
		}
		if input == "/help" {
			printHelp(rl.Stdout())
			continue
		}
		if input == "/compact" {
			err = cl.Compact(ctx, rl.Stdout())
			if err != nil {
				fmt.Fprintf(rl.Stdout(), "error: %v\n", err)
			}
			continue
		}
		if input == "/exit" || input == "/quit" {
			return nil
		}

		err = cl.StreamPrompt(ctx, input, rl.Stdout())
		if err != nil {
			fmt.Fprintf(rl.Stdout(), "error: %v\n", err)
		}
	}
}

func printHelp(w io.Writer) {
	fmt.Fprintln(w, "/help           Show this help")
	fmt.Fprintln(w, "/compact        Attempt session compaction now")
	fmt.Fprintln(w, "/exit, /quit    Exit REPL")
}

func renderAgentEvent(w io.Writer, evt *agentpb.AgentEvent, sawDelta bool) bool {
	if evt == nil {
		return sawDelta
	}
	switch evt.GetType() {
	case agentpb.EventType_EVENT_TYPE_TOOL_CALL:
		printToolCall(w, "tool_call", model.ToolCall{
			Function: model.FunctionDefinitionParam{
				Name:      evt.GetToolName(),
				Arguments: []byte(evt.GetToolPayload()),
			},
		})
	case agentpb.EventType_EVENT_TYPE_TOOL_RESULT:
		printToolResult(w, model.Message{
			Role:     model.RoleTool,
			ToolName: evt.GetToolName(),
			Content:  evt.GetToolPayload(),
		})
	case agentpb.EventType_EVENT_TYPE_ASSISTANT_DELTA:
		fmt.Fprint(w, evt.GetContent())
		return true
	case agentpb.EventType_EVENT_TYPE_ASSISTANT_MESSAGE:
		if evt.GetContent() != "" && !sawDelta {
			fmt.Fprint(w, evt.GetContent())
		}
	case agentpb.EventType_EVENT_TYPE_RUN_INTERRUPTED:
		fmt.Fprintln(w, interruptedRunMessage)
	case agentpb.EventType_EVENT_TYPE_RUN_ERROR:
		if evt.GetError() != "" {
			fmt.Fprintf(w, "error: %s\n", evt.GetError())
		}
	}
	return sawDelta
}

func printToolCall(w io.Writer, kind string, tc model.ToolCall) {
	args := strings.TrimSpace(string(tc.Function.Arguments))
	if args == "" {
		args = "{}"
	}
	id := strings.TrimSpace(tc.ID)
	if id == "" {
		id = "-"
	}
	name := strings.TrimSpace(tc.Function.Name)
	if name == "" {
		name = "-"
	}
	fmt.Fprintf(w, "\n[%s] id=%s name=%s args=%s\n", kind, id, name, args)
}

func printToolResult(w io.Writer, msg model.Message) {
	name := strings.TrimSpace(msg.ToolName)
	if name == "" {
		name = "-"
	}
	id := strings.TrimSpace(msg.ToolID)
	if id == "" {
		id = "-"
	}
	content := strings.TrimSpace(msg.Content)
	if content == "" {
		content = "(empty)"
	}
	fmt.Fprintf(w, "\n[tool_result] id=%s name=%s output=%s\n", id, name, content)
}
