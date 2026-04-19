package sessionstore

import (
	"context"
	"strings"
	"testing"

	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
)

func TestTruncateEventToolResultsTruncatesOversizedToolResults(t *testing.T) {
	t.Parallel()

	content := "HEAD-" + strings.Repeat("middle-", 400) + "-TAIL"
	evt := &event.Event{
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

	stored, err := truncateEventToolResults(context.Background(), evt, 32)
	if err != nil {
		t.Fatalf("truncate event: %v", err)
	}
	if stored == evt {
		t.Fatal("expected cloned event when truncation happens")
	}

	got := stored.Choices[0].Message.Content
	if got == content {
		t.Fatal("expected truncated tool content")
	}
	if !strings.Contains(got, "[... ") {
		t.Fatalf("expected truncation marker, got %q", got)
	}
	if evt.Choices[0].Message.Content != content {
		t.Fatal("expected original event to remain unchanged")
	}
}

func TestTruncateEventToolResultsLeavesNonToolMessages(t *testing.T) {
	t.Parallel()

	evt := &event.Event{
		Response: &model.Response{
			Choices: []model.Choice{{
				Message: model.Message{
					Role:    model.RoleAssistant,
					Content: strings.Repeat("plain-text-", 400),
				},
			}},
		},
	}

	stored, err := truncateEventToolResults(context.Background(), evt, 32)
	if err != nil {
		t.Fatalf("truncate event: %v", err)
	}
	if stored != evt {
		t.Fatal("expected non-tool event to pass through unchanged")
	}
}
