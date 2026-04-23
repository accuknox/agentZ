package repl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/chzyer/readline"
	"trpc.group/trpc-go/trpc-agent-go/model"

	gatewaypb "github.com/accuknox/clawarmor/internal/agent/gateway/proto"
)

const (
	replPrompt            = "> "
	interruptedRunMessage = "Run interrupted by user."
)

// Options configures the remote agent REPL.
type Options struct {
	Target    string
	SessionID string
}

// Run runs an interactive remote chat session.
func Run(ctx context.Context, opts Options) error {
	cl, err := newGatewayClient(gatewayClientConfig{
		Target:    opts.Target,
		SessionID: opts.SessionID,
	})
	if err != nil {
		return err
	}
	defer cl.close()

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

	out := newREPLWriter(rl)
	fmt.Fprintln(out, "Type /help for commands.")
	cl.subscribeSession(ctx, out)
	cl.watchStatus(ctx, out)

	for {
		line, readErr := rl.Readline()
		if errors.Is(readErr, io.EOF) {
			fmt.Fprintln(out)
			return nil
		}
		if errors.Is(readErr, readline.ErrInterrupt) {
			if strings.TrimSpace(line) == "" {
				err = cl.interrupt(ctx)
				if err != nil {
					fmt.Fprintf(out, "interrupt error: %v\n", err)
				}
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
			printHelp(out)
			continue
		}
		if input == "/compact" {
			err = cl.compact(ctx, out)
			if err != nil {
				fmt.Fprintf(out, "error: %v\n", err)
			}
			continue
		}
		if input == "/status" {
			err = cl.printStatus(ctx, out)
			if err != nil {
				fmt.Fprintf(out, "error: %v\n", err)
			}
			continue
		}
		if input == "/exit" || input == "/quit" {
			return nil
		}

		err = cl.streamPrompt(ctx, input)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
		}
	}
}

type replWriter struct {
	mu        sync.Mutex
	rl        *readline.Instance
	streaming bool
}

func newREPLWriter(rl *readline.Instance) *replWriter {
	return &replWriter{rl: rl}
}

func (w *replWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.streaming {
		return w.rl.Config.Stdout.Write(p)
	}
	return w.rl.Stdout().Write(p)
}

func (w *replWriter) SetStreaming(streaming bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.streaming == streaming {
		return
	}
	w.streaming = streaming
	if streaming {
		w.rl.SetPrompt("")
	} else {
		w.rl.SetPrompt(replPrompt)
	}
	w.rl.Refresh()
}

func printHelp(w io.Writer) {
	fmt.Fprintln(w, "/help           Show this help")
	fmt.Fprintln(w, "/status         Show status for the active session")
	fmt.Fprintln(w, "/compact        Attempt session compaction now")
	fmt.Fprintln(w, "/exit, /quit    Exit REPL")
}

func renderGatewayEvent(w io.Writer, evt *gatewaypb.SessionStreamEvent, sawDelta bool) bool {
	if evt == nil {
		return sawDelta
	}
	switch evt.GetType() {
	case gatewaypb.EventType_EVENT_TYPE_RUN_STARTED:
		setREPLStreaming(w, true)
		if evt.GetContent() != "" {
			fmt.Fprintf(w, "\n[user] %s\n", evt.GetContent())
		}
	case gatewaypb.EventType_EVENT_TYPE_TOOL_CALL:
		printToolCall(w, "tool_call", model.ToolCall{
			Function: model.FunctionDefinitionParam{
				Name:      evt.GetToolName(),
				Arguments: []byte(evt.GetToolPayload()),
			},
		})
	case gatewaypb.EventType_EVENT_TYPE_TOOL_RESULT:
		printToolResult(w, model.Message{
			Role:     model.RoleTool,
			ToolName: evt.GetToolName(),
			Content:  evt.GetToolPayload(),
		})
	case gatewaypb.EventType_EVENT_TYPE_ASSISTANT_DELTA:
		fmt.Fprint(w, evt.GetContent())
		return true
	case gatewaypb.EventType_EVENT_TYPE_ASSISTANT_MESSAGE:
		if evt.GetContent() != "" && !sawDelta {
			fmt.Fprint(w, evt.GetContent())
		}
	case gatewaypb.EventType_EVENT_TYPE_RUN_INTERRUPTED:
		fmt.Fprintln(w, interruptedRunMessage)
		setREPLStreaming(w, false)
	case gatewaypb.EventType_EVENT_TYPE_RUN_ERROR:
		if evt.GetError() != "" {
			fmt.Fprintf(w, "error: %s\n", evt.GetError())
		}
		setREPLStreaming(w, false)
	case gatewaypb.EventType_EVENT_TYPE_RUN_COMPLETED:
		fmt.Fprintln(w)
		setREPLStreaming(w, false)
	}
	return sawDelta
}

type streamPromptController interface {
	SetStreaming(bool)
}

func setREPLStreaming(w io.Writer, streaming bool) {
	controller, ok := w.(streamPromptController)
	if ok {
		controller.SetStreaming(streaming)
	}
}

type statusPrinter struct {
	mu     sync.Mutex
	last   map[string]*gatewaypb.AgentStatus
	output io.Writer
}

func newStatusPrinter(w io.Writer) *statusPrinter {
	return &statusPrinter{
		last:   make(map[string]*gatewaypb.AgentStatus),
		output: w,
	}
}

func (p *statusPrinter) print(items []*gatewaypb.AgentStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, item := range items {
		if item == nil {
			continue
		}
		prev := p.last[item.GetSessionId()]
		if sameGatewayStatus(prev, item) {
			continue
		}
		p.last[item.GetSessionId()] = item
		fmt.Fprintf(
			p.output,
			"\n[status] session=%s agent=%s phase=%s reason=%s message=%s\n",
			item.GetSessionId(),
			item.GetAgentName(),
			strings.TrimPrefix(item.GetPhase().String(), "AGENT_PHASE_"),
			item.GetReason(),
			item.GetMessage(),
		)
	}
}

func sameGatewayStatus(a, b *gatewaypb.AgentStatus) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.GetSessionId() == b.GetSessionId() &&
		a.GetAgentName() == b.GetAgentName() &&
		a.GetNamespace() == b.GetNamespace() &&
		a.GetPhase() == b.GetPhase() &&
		a.GetReason() == b.GetReason() &&
		a.GetMessage() == b.GetMessage()
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
