package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	sessionstore "github.com/accuknox/clawarmor/internal/session"
	"github.com/chzyer/readline"
	"github.com/google/uuid"
	"trpc.group/trpc-go/trpc-agent-go/agent"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
)

const replPrompt = "> "

var (
	notifySignal = signal.Notify
	stopSignal   = signal.Stop
)

// RunREPL runs an interactive local chat session.
func RunREPL(ctx context.Context, opts Options) error {
	rt, err := NewRuntime(ctx, opts)
	if err != nil {
		return err
	}
	defer rt.Close()

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
			err = rt.compactCurrentSession(ctx, rl.Stdout())
			if err != nil {
				fmt.Fprintf(rl.Stdout(), "error: %v\n", err)
			}
			continue
		}
		if input == "/exit" || input == "/quit" {
			return nil
		}

		err = rt.streamPrompt(ctx, input, rl.Stdout())
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

func (r *Runtime) compactCurrentSession(ctx context.Context, w io.Writer) error {
	if r != nil && r.blockedMsg != "" {
		return fmt.Errorf("%s", r.blockedMsg)
	}
	if r == nil || r.sessionSvc == nil {
		return fmt.Errorf("session service is not available")
	}

	sess, err := r.sessionSvc.GetSession(ctx, agentsession.Key{
		AppName:   sessionstore.DefaultAppName,
		UserID:    sessionstore.DefaultUserID,
		SessionID: r.sessionID,
	})
	if err != nil {
		return fmt.Errorf("load session: %w", err)
	}

	err = r.sessionSvc.CreateSessionSummary(ctx, sess, sessionstore.DefaultAppName, false)
	if err != nil {
		return fmt.Errorf("compact session: %w", err)
	}

	fmt.Fprintln(w, "compaction checked")
	return nil
}

func (r *Runtime) streamPrompt(ctx context.Context, prompt string, w io.Writer) error {
	if r != nil && r.blockedMsg != "" {
		return fmt.Errorf("%s", r.blockedMsg)
	}
	mr, err := r.managedRunner()
	if err != nil {
		return err
	}
	requestID := uuid.NewString()
	runCtx, runCancel := context.WithCancel(ctx)
	defer runCancel()

	sigCh := make(chan os.Signal, 1)
	notifySignal(sigCh, syscall.SIGINT)
	defer stopSignal(sigCh)

	interruptedCh := make(chan struct{}, 1)
	go func() {
		select {
		case <-runCtx.Done():
			return
		case <-sigCh:
		}
		if mr.Cancel(requestID) {
			select {
			case interruptedCh <- struct{}{}:
			default:
			}
		}
	}()

	eventCh, err := r.runner.Run(
		runCtx,
		sessionstore.DefaultUserID,
		r.sessionID,
		model.NewUserMessage(prompt),
		agent.WithRequestID(requestID),
	)
	if err != nil {
		return fmt.Errorf("run prompt failed: %w", err)
	}
	err = writeEvents(w, eventCh, r.stream)
	interrupted := false
	select {
	case <-interruptedCh:
		interrupted = true
	default:
	}
	if !interrupted {
		return err
	}

	appendCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	appendErr := r.appendInterruptEvent(appendCtx, requestID)
	if appendErr != nil {
		return fmt.Errorf("interrupt run: %w", appendErr)
	}

	if err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	fmt.Fprintln(w, interruptedRunMessage)
	return nil
}

func writeEvents(w io.Writer, eventCh <-chan *event.Event, stream bool) error {
	wroteOutput := false
	wroteDelta := false
	seenToolCalls := map[string]struct{}{}

	for evt := range eventCh {
		if evt == nil {
			continue
		}
		if evt.Error != nil {
			return errors.New(strings.TrimSpace(evt.Error.Message))
		}
		if evt.Response == nil || len(evt.Choices) == 0 {
			continue
		}
		choice := evt.Choices[0]
		if stream {
			for _, tc := range choice.Delta.ToolCalls {
				printToolCall(w, "tool_call_delta", tc)
				wroteOutput = true
			}
		}
		for _, tc := range choice.Message.ToolCalls {
			key := toolCallKey(tc)
			if _, ok := seenToolCalls[key]; ok {
				continue
			}
			seenToolCalls[key] = struct{}{}
			printToolCall(w, "tool_call", tc)
			wroteOutput = true
		}
		if choice.Message.Role == model.RoleTool {
			printToolResult(w, choice.Message)
			wroteOutput = true
		}
		if stream && choice.Delta.Content != "" {
			fmt.Fprint(w, choice.Delta.Content)
			wroteOutput = true
			wroteDelta = true
		}
		if choice.Message.Role != model.RoleTool &&
			!wroteDelta &&
			choice.Message.Content != "" {
			fmt.Fprint(w, choice.Message.Content)
			wroteOutput = true
		}
	}

	if wroteOutput {
		fmt.Fprintln(w)
	}
	return nil
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
	fmt.Fprintf(
		w,
		"\n[%s] id=%s name=%s args=%s\n",
		kind,
		id,
		name,
		args,
	)
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
	fmt.Fprintf(
		w,
		"\n[tool_result] id=%s name=%s output=%s\n",
		id,
		name,
		content,
	)
}

func toolCallKey(tc model.ToolCall) string {
	return strings.Join(
		[]string{
			strings.TrimSpace(tc.ID),
			strings.TrimSpace(tc.Function.Name),
			strings.TrimSpace(string(tc.Function.Arguments)),
		},
		"|",
	)
}
