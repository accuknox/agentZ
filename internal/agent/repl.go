package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/chzyer/readline"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
)

const replPrompt = "> "

// RunREPL runs an interactive local chat session.
func RunREPL(ctx context.Context, opts Options) error {
	rt, err := NewRuntime(ctx, opts)
	if err != nil {
		return err
	}
	defer func() {
		_ = rt.Close()
	}()

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

	_, _ = fmt.Fprintln(rl.Stdout(), "Type /help for commands.")

	for {
		line, readErr := rl.Readline()
		if errors.Is(readErr, io.EOF) {
			_, _ = fmt.Fprintln(rl.Stdout())
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
		if input == "/exit" || input == "/quit" {
			return nil
		}

		err = rt.streamPrompt(ctx, input, rl.Stdout())
		if err != nil {
			_, _ = fmt.Fprintf(rl.Stdout(), "error: %v\n", err)
		}
	}
}

func printHelp(w io.Writer) {
	_, _ = fmt.Fprintln(w, "/help           Show this help")
	_, _ = fmt.Fprintln(w, "/exit, /quit    Exit REPL")
}

func (r *Runtime) streamPrompt(ctx context.Context, prompt string, w io.Writer) error {
	eventCh, err := r.runner.Run(
		ctx,
		userID,
		sessionID,
		model.NewUserMessage(prompt),
	)
	if err != nil {
		return fmt.Errorf("run prompt failed: %w", err)
	}
	return writeEvents(w, eventCh, r.stream)
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
			_, _ = fmt.Fprint(w, choice.Delta.Content)
			wroteOutput = true
			wroteDelta = true
		}
		if choice.Message.Role != model.RoleTool &&
			!wroteDelta &&
			choice.Message.Content != "" {
			_, _ = fmt.Fprint(w, choice.Message.Content)
			wroteOutput = true
		}
	}

	if wroteOutput {
		_, _ = fmt.Fprintln(w)
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
	_, _ = fmt.Fprintf(
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
	_, _ = fmt.Fprintf(
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
