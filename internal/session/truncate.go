package sessionstore

import (
	"context"
	"fmt"
	"unicode/utf8"

	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
)

// truncateEventToolResults clones one event and truncates oversized tool
// results using the same head+tail policy as trpc-agent-go projection.
func truncateEventToolResults(ctx context.Context, evt *event.Event, maxTokens int) (*event.Event, error) {
	if evt == nil {
		return nil, fmt.Errorf("event is nil")
	}
	if maxTokens <= 0 || evt.Response == nil {
		return evt, nil
	}

	cloned := evt.Clone()
	if cloned.Response == nil {
		return cloned, nil
	}

	changed := false
	for i := range cloned.Choices {
		msg, ok, err := truncateOversizedToolResultMessage(
			ctx,
			cloned.Response.Choices[i].Message,
			maxTokens,
		)
		if err != nil {
			return nil, err
		}
		if ok {
			cloned.Response.Choices[i].Message = msg
			changed = true
		}

		delta, ok, err := truncateOversizedToolResultMessage(
			ctx,
			cloned.Response.Choices[i].Delta,
			maxTokens,
		)
		if err != nil {
			return nil, err
		}
		if ok {
			cloned.Response.Choices[i].Delta = delta
			changed = true
		}
	}
	if !changed {
		return evt, nil
	}
	return cloned, nil
}

// truncateOversizedToolResultMessage matches the upstream oversized tool-result
// truncation policy used by trpc-agent-go.
func truncateOversizedToolResultMessage(ctx context.Context, msg model.Message, maxTokens int) (model.Message, bool, error) {
	if msg.Role != model.RoleTool || msg.ToolID == "" || maxTokens <= 0 {
		return msg, false, nil
	}
	if msg.Content == "" && len(msg.ContentParts) == 0 {
		return msg, false, nil
	}

	counter := model.NewSimpleTokenCounter()
	originalTokens, err := counter.CountTokens(ctx, msg)
	if err != nil {
		return msg, false, fmt.Errorf("count tool result tokens: %w", err)
	}
	if originalTokens <= maxTokens {
		return msg, false, nil
	}

	truncated := truncateMiddle(msg.Content, maxTokens*4)
	result := msg
	result.Content = truncated
	if len(msg.ContentParts) > 0 {
		result.ContentParts = append([]model.ContentPart(nil), msg.ContentParts...)
	}
	if len(msg.ToolCalls) > 0 {
		result.ToolCalls = append([]model.ToolCall(nil), msg.ToolCalls...)
	}

	resultTokens, err := counter.CountTokens(ctx, result)
	if err != nil {
		return msg, false, fmt.Errorf("count truncated tool result tokens: %w", err)
	}
	if resultTokens >= originalTokens {
		return msg, false, nil
	}

	return result, true, nil
}

// truncateMiddle keeps the first half and last half of the content and inserts
// a marker showing how many characters were removed.
func truncateMiddle(s string, maxChars int) string {
	runeCount := utf8.RuneCountInString(s)
	if runeCount <= maxChars {
		return s
	}

	removed := runeCount - maxChars
	marker := fmt.Sprintf("\n\n[... %d characters truncated ...]\n\n", removed)
	markerLen := utf8.RuneCountInString(marker)

	available := maxChars - markerLen
	if available < 2 {
		runes := []rune(s)
		return string(runes[:maxChars])
	}
	halfBudget := available / 2

	runes := []rune(s)
	head := string(runes[:halfBudget])
	tail := string(runes[runeCount-halfBudget:])
	return head + marker + tail
}
