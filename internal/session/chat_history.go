package sessionstore

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
	"trpc.group/trpc-go/trpc-agent-go/model"

	sessiondb "github.com/accuknox/clawarmor/internal/session/db"
	sessionpb "github.com/accuknox/clawarmor/internal/session/proto"
)

const (
	defaultChatHistoryPageSize = 25
	maxChatHistoryPageSize     = 100
)

type chatHistoryRow struct {
	Seq          int64
	EventID      string
	EventTs      time.Time
	EventPayload []byte
}

func chatHistoryLimit(size int32) (int32, error) {
	if size == 0 {
		return defaultChatHistoryPageSize, nil
	}
	if size < 0 || size > maxChatHistoryPageSize {
		return 0, status.Error(codes.InvalidArgument, "invalid page_size")
	}
	return size, nil
}

func (s *Service) listChatHistoryRows(ctx context.Context, sessionID uuid.UUID, beforeSeq int64, limit int32) ([]chatHistoryRow, error) {
	if beforeSeq < 0 {
		return nil, status.Error(codes.InvalidArgument, "before_seq must be >= 0")
	}
	if beforeSeq > 0 {
		rows, err := s.queries.ListChatHistoryBefore(ctx, sessiondb.ListChatHistoryBeforeParams{
			SessionID: sessionID,
			Seq:       beforeSeq,
			Limit:     limit,
		})
		if err != nil {
			return nil, mapStoreError("list chat history", err)
		}
		return chatHistoryRowsFromBeforeRows(rows), nil
	}

	rows, err := s.queries.ListChatHistory(ctx, sessiondb.ListChatHistoryParams{
		SessionID: sessionID,
		Limit:     limit,
	})
	if err != nil {
		return nil, mapStoreError("list chat history", err)
	}
	return chatHistoryRowsFromRows(rows), nil
}

func chatHistoryRowsFromBeforeRows(rows []sessiondb.ListChatHistoryBeforeRow) []chatHistoryRow {
	items := make([]chatHistoryRow, 0, len(rows))
	for _, row := range rows {
		items = append(items, chatHistoryRow{
			Seq:          row.Seq,
			EventID:      row.EventID,
			EventTs:      row.EventTs,
			EventPayload: row.EventPayload,
		})
	}
	return items
}

func chatHistoryRowsFromRows(rows []sessiondb.ListChatHistoryRow) []chatHistoryRow {
	items := make([]chatHistoryRow, 0, len(rows))
	for _, row := range rows {
		items = append(items, chatHistoryRow{
			Seq:          row.Seq,
			EventID:      row.EventID,
			EventTs:      row.EventTs,
			EventPayload: row.EventPayload,
		})
	}
	return items
}

func chatHistoryItemsFromJSON(seq int64, eventID string, eventTS time.Time, raw []byte) ([]*sessionpb.ChatHistoryItem, error) {
	evt, err := unmarshalEvent(raw)
	if err != nil {
		return nil, err
	}

	base := &sessionpb.ChatHistoryItem{
		Seq:          seq,
		EventId:      eventID,
		EventTs:      timestamppb.New(eventTS),
		RequestId:    evt.RequestID,
		InvocationId: evt.InvocationID,
		Author:       evt.Author,
	}

	var items []*sessionpb.ChatHistoryItem
	if evt.Response != nil && evt.Error != nil {
		item := cloneChatHistoryBase(base)
		item.Error = strings.TrimSpace(evt.Error.Message)
		items = appendIfValuable(items, item)
	}
	if evt.Response == nil {
		return items, nil
	}

	for _, choice := range evt.Choices {
		items = append(items, chatHistoryItemFromMessage(base, choice.Message))
		if !messageHasFinalValue(choice.Message) {
			items = append(items, chatHistoryItemFromMessage(base, choice.Delta))
		}
	}
	return compactChatHistoryItems(items), nil
}

func chatHistoryItemFromMessage(base *sessionpb.ChatHistoryItem, msg model.Message) *sessionpb.ChatHistoryItem {
	item := cloneChatHistoryBase(base)
	item.Role = string(msg.Role)
	item.Content = strings.TrimSpace(msg.Content)
	item.ReasoningContent = strings.TrimSpace(msg.ReasoningContent)
	item.ToolCallId = strings.TrimSpace(msg.ToolID)
	item.ToolName = strings.TrimSpace(msg.ToolName)
	item.ToolCalls = toolCallsFromMessage(msg)
	return item
}

func toolCallsFromMessage(msg model.Message) []*sessionpb.ChatToolCall {
	items := make([]*sessionpb.ChatToolCall, 0, len(msg.ToolCalls))
	for _, tc := range msg.ToolCalls {
		name := strings.TrimSpace(tc.Function.Name)
		args := strings.TrimSpace(string(tc.Function.Arguments))
		id := strings.TrimSpace(tc.ID)
		if id == "" && name == "" && args == "" {
			continue
		}
		items = append(items, &sessionpb.ChatToolCall{
			Id:        id,
			Name:      name,
			Arguments: args,
		})
	}
	return items
}

func cloneChatHistoryBase(base *sessionpb.ChatHistoryItem) *sessionpb.ChatHistoryItem {
	if base == nil {
		return &sessionpb.ChatHistoryItem{}
	}
	return &sessionpb.ChatHistoryItem{
		Seq:          base.GetSeq(),
		EventId:      base.GetEventId(),
		EventTs:      base.GetEventTs(),
		RequestId:    base.GetRequestId(),
		InvocationId: base.GetInvocationId(),
		Author:       base.GetAuthor(),
	}
}

func compactChatHistoryItems(items []*sessionpb.ChatHistoryItem) []*sessionpb.ChatHistoryItem {
	out := make([]*sessionpb.ChatHistoryItem, 0, len(items))
	for _, item := range items {
		out = appendIfValuable(out, item)
	}
	return out
}

func appendIfValuable(items []*sessionpb.ChatHistoryItem, item *sessionpb.ChatHistoryItem) []*sessionpb.ChatHistoryItem {
	if !chatHistoryItemValuable(item) {
		return items
	}
	return append(items, item)
}

func chatHistoryItemValuable(item *sessionpb.ChatHistoryItem) bool {
	if item == nil {
		return false
	}
	return item.GetRole() != "" ||
		item.GetContent() != "" ||
		item.GetReasoningContent() != "" ||
		len(item.GetToolCalls()) > 0 ||
		item.GetToolCallId() != "" ||
		item.GetToolName() != "" ||
		item.GetError() != ""
}

func messageHasFinalValue(msg model.Message) bool {
	return msg.Role != "" ||
		strings.TrimSpace(msg.Content) != "" ||
		strings.TrimSpace(msg.ReasoningContent) != "" ||
		len(msg.ToolCalls) > 0 ||
		strings.TrimSpace(msg.ToolID) != "" ||
		strings.TrimSpace(msg.ToolName) != ""
}
