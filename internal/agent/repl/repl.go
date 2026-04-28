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

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

const (
	replPrompt            = "> "
	defaultHistoryLimit   = 25
	interruptedRunMessage = "Run interrupted by user."
)

// Options configures the remote agent REPL.
type Options struct {
	Target       string
	SessionID    string
	HistoryLimit int
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
	err = cl.printChatHistory(ctx, out, opts.HistoryLimit)
	if err != nil {
		fmt.Fprintf(out, "history warning: %v\n", err)
	}
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

func (c *gatewayClient) renderSessionEvent(w io.Writer, evt *gatewayapi.SessionStreamEvent) {
	if c == nil {
		return
	}
	c.sawMu.Lock()
	sawContentDelta := c.sawContentDelta
	c.sawMu.Unlock()
	next := renderGatewayEvent(w, evt, sawContentDelta)
	c.sawMu.Lock()
	c.sawContentDelta = next
	if isGatewayTerminal(evt) {
		c.sawContentDelta = false
	}
	c.sawMu.Unlock()
}

func renderGatewayEvent(w io.Writer, evt *gatewayapi.SessionStreamEvent, sawContentDelta bool) bool {
	if evt == nil {
		return sawContentDelta
	}
	item, err := evt.ValueByDiscriminator()
	if err != nil || item == nil {
		return sawContentDelta
	}
	switch e := item.(type) {
	case gatewayapi.SessionRunStartedEvent:
		setREPLStreaming(w, true)
		if e.Content != "" {
			fmt.Fprintf(w, "\n[user] %s\n", e.Content)
		}
	case gatewayapi.SessionToolCallEvent:
		printToolCall(w, "tool_call", model.ToolCall{
			Function: model.FunctionDefinitionParam{
				Name:      e.ToolName,
				Arguments: []byte(e.ToolPayload),
			},
		})
	case gatewayapi.SessionToolResultEvent:
		printToolResult(w, model.Message{
			Role:     model.RoleTool,
			ToolName: e.ToolName,
			Content:  e.ToolPayload,
		})
	case gatewayapi.SessionAssistantDeltaEvent:
		if e.ReasoningContent != nil && *e.ReasoningContent != "" {
			fmt.Fprintf(w, "\x1b[2m%s\x1b[0m", *e.ReasoningContent)
			return sawContentDelta
		}
		if e.Content != nil && *e.Content != "" {
			fmt.Fprint(w, *e.Content)
			return true
		}
		return sawContentDelta
	case gatewayapi.SessionAssistantMessageEvent:
		if e.Content != "" && !sawContentDelta {
			fmt.Fprint(w, e.Content)
		}
	case gatewayapi.SessionRunInterruptedEvent:
		fmt.Fprintln(w, interruptedRunMessage)
		setREPLStreaming(w, false)
	case gatewayapi.SessionRunErrorEvent:
		if e.Error != "" {
			fmt.Fprintf(w, "error: %s\n", e.Error)
		}
		setREPLStreaming(w, false)
	case gatewayapi.SessionRunCompletedEvent:
		fmt.Fprintln(w)
		setREPLStreaming(w, false)
	}
	return sawContentDelta
}

func renderHistoryEvent(w io.Writer, item gatewayapi.StoredSessionEvent) {
	payload := item.Payload
	if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
		fmt.Fprintf(w, "[error] %s\n", payload.Error.Message)
		return
	}
	if payload.Choices == nil {
		return
	}
	for _, choice := range *payload.Choices {
		msg := choice.Message
		if msg == nil {
			msg = choice.Delta
		}
		if msg == nil {
			continue
		}
		if msg.ToolCalls != nil {
			for _, tc := range *msg.ToolCalls {
				call := model.ToolCall{}
				if tc.Id != nil {
					call.ID = *tc.Id
				}
				if tc.Function != nil {
					call.Function.Name = tc.Function.Name
					if tc.Function.Arguments != nil {
						call.Function.Arguments = []byte(*tc.Function.Arguments)
					}
				}
				printToolCall(w, "tool_call", call)
			}
		}
		if msg.Role == gatewayapi.Tool {
			out := model.Message{Role: model.RoleTool}
			if msg.ToolId != nil {
				out.ToolID = *msg.ToolId
			}
			if msg.ToolName != nil {
				out.ToolName = *msg.ToolName
			}
			if msg.Content != nil {
				out.Content = *msg.Content
			}
			printToolResult(w, out)
			continue
		}

		content := ""
		if msg.Content != nil {
			content = strings.TrimSpace(*msg.Content)
		}
		if content == "" && msg.ReasoningContent != nil {
			content = strings.TrimSpace(*msg.ReasoningContent)
		}
		if content == "" {
			continue
		}
		role := strings.TrimSpace(string(msg.Role))
		if role == "" {
			role = "message"
		}
		fmt.Fprintf(w, "[%s] %s\n", role, content)
	}
}

func isGatewayTerminal(evt *gatewayapi.SessionStreamEvent) bool {
	if evt == nil {
		return false
	}
	t, err := evt.Discriminator()
	if err != nil {
		return false
	}
	switch gatewayapi.SessionStreamEventType(t) {
	case gatewayapi.SessionStreamEventTypeEVENTTYPERUNCOMPLETED,
		gatewayapi.SessionStreamEventTypeEVENTTYPERUNINTERRUPTED,
		gatewayapi.SessionStreamEventTypeEVENTTYPERUNERROR:
		return true
	default:
		return false
	}
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
	last   map[gatewayapi.SessionID]gatewayapi.Agent
	output io.Writer
}

func newStatusPrinter(w io.Writer) *statusPrinter {
	return &statusPrinter{
		last:   make(map[gatewayapi.SessionID]gatewayapi.Agent),
		output: w,
	}
}

func (p *statusPrinter) print(items []gatewayapi.Agent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, item := range items {
		prev := p.last[item.SessionId]
		if sameGatewayStatus(prev, item) {
			continue
		}
		p.last[item.SessionId] = item
		fmt.Fprintf(
			p.output,
			"\n[status] session=%s agent=%s phase=%s\n",
			item.SessionId,
			item.Name,
			item.Status,
		)
	}
}

func sameGatewayStatus(a, b gatewayapi.Agent) bool {
	return a.SessionId == b.SessionId &&
		a.Name == b.Name &&
		a.Status == b.Status &&
		a.LastActivity.Equal(b.LastActivity) &&
		a.ModifiedAt.Equal(b.ModifiedAt)
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
