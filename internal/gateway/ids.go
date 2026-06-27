package gateway

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"k8s.io/apimachinery/pkg/util/validation"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
)

type traceSessionPageCursor struct {
	StartedAt time.Time `json:"started_at"`
	TraceID   string    `json:"trace_id"`
	SessionID string    `json:"session_id"`
}

type spanPageCursor struct {
	StartTime time.Time `json:"start_time"`
	ID        int64     `json:"id"`
}

type eventPageCursor struct {
	EventTime time.Time `json:"event_time"`
	ID        int64     `json:"id"`
}

func requestID(r *http.Request) string {
	if r == nil {
		return ""
	}
	if id := strings.TrimSpace(r.Header.Get("X-Request-ID")); id != "" {
		return id
	}

	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return uuid.UUID(b).String()
}

func validAgentName(w http.ResponseWriter, r *http.Request, agentName string, fields ...string) (string, bool) {
	name := strings.TrimSpace(agentName)
	if name != "" && len(name) <= 32 && len(validation.IsDNS1123Label(name)) == 0 {
		return name, true
	}

	field := "agent_name"
	if len(fields) > 0 && fields[0] != "" {
		field = fields[0]
	}
	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"request validation failed",
		errBadRequest,
		gatewayapi.FieldError{
			Field:   field,
			Message: "must be a valid DNS label",
		},
	))
	return "", false
}

func validLimit(w http.ResponseWriter, r *http.Request, raw *gatewayapi.LimitQuery) (int, bool) {
	limit := 50
	if raw != nil {
		limit = int(*raw)
	}
	if limit >= 1 && limit <= 200 {
		return limit, true
	}

	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"limit must be between 1 and 200",
		errBadRequest,
	))
	return 0, false
}

func validTraceID(w http.ResponseWriter, r *http.Request, raw string) ([]byte, bool) {
	return validHexID(w, r, raw, "trace_id", 16)
}

func validSpanID(w http.ResponseWriter, r *http.Request, raw string) ([]byte, bool) {
	return validHexID(w, r, raw, "span_id", 8)
}

func validHexID(w http.ResponseWriter, r *http.Request, raw string, field string, size int) ([]byte, bool) {
	raw = strings.TrimSpace(raw)
	out, err := hex.DecodeString(raw)
	if err != nil || len(out) != size || raw != strings.ToLower(raw) {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   field,
				Message: "must be a lowercase hexadecimal identifier",
			},
		))
		return nil, false
	}
	return out, true
}

func decodeOptionalTraceCursor(w http.ResponseWriter, r *http.Request, raw string, set bool) ([]byte, bool) {
	if !set {
		return nil, true
	}
	return validTraceID(w, r, raw)
}

func traceTimeBounds(w http.ResponseWriter, r *http.Request, after *gatewayapi.StartedAfterQuery, before *gatewayapi.StartedBeforeQuery) (time.Time, time.Time, bool) {
	startedAfter := time.Unix(0, 0).UTC()
	startedBefore := maxTime()
	if after != nil {
		startedAfter = (*after).UTC()
	}
	if before != nil {
		startedBefore = (*before).UTC()
	}
	if !startedAfter.After(startedBefore) {
		return startedAfter, startedBefore, true
	}

	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"started_after must be before or equal to started_before",
		errBadRequest,
	))
	return time.Time{}, time.Time{}, false
}

func observabilityTimeBounds(w http.ResponseWriter, r *http.Request, after *gatewayapi.EventTimeAfterQuery, before *gatewayapi.EventTimeBeforeQuery) (time.Time, time.Time, bool) {
	eventAfter := time.Unix(0, 0).UTC()
	eventBefore := maxTime()
	if after != nil {
		eventAfter = (*after).UTC()
	}
	if before != nil {
		eventBefore = (*before).UTC()
	}
	if !eventAfter.After(eventBefore) {
		return eventAfter, eventBefore, true
	}

	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"event_time_after must be before or equal to event_time_before",
		errBadRequest,
	))
	return time.Time{}, time.Time{}, false
}

func maxTime() time.Time {
	return time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
}

func observabilityListParams(w http.ResponseWriter, r *http.Request, after *gatewayapi.EventTimeAfterQuery, before *gatewayapi.EventTimeBeforeQuery, action *gatewayapi.ActionQuery, token *gatewayapi.PageTokenQuery) (time.Time, time.Time, string, eventPageCursor, bool, bool) {
	eventAfter, eventBefore, actionValue, ok := observabilityFilters(w, r, after, before, action)
	if !ok {
		return time.Time{}, time.Time{}, "", eventPageCursor{}, false, false
	}

	cursor, cursorSet, ok := decodeEventPageToken(w, r, token)
	if !ok {
		return time.Time{}, time.Time{}, "", eventPageCursor{}, false, false
	}
	return eventAfter, eventBefore, actionValue, cursor, cursorSet, true
}

func observabilityFilters(w http.ResponseWriter, r *http.Request, after *gatewayapi.EventTimeAfterQuery, before *gatewayapi.EventTimeBeforeQuery, action *gatewayapi.ActionQuery) (time.Time, time.Time, string, bool) {
	eventAfter, eventBefore, ok := observabilityTimeBounds(w, r, after, before)
	if !ok {
		return time.Time{}, time.Time{}, "", false
	}

	var actionValue string
	if action != nil {
		actionValue = string(*action)
		if actionValue != "Allowed" && actionValue != "Blocked" {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"action must be Allowed or Blocked",
				errBadRequest,
			))
			return time.Time{}, time.Time{}, "", false
		}
	}

	return eventAfter, eventBefore, actionValue, true
}

func decodeOffsetPageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (int, bool) {
	if token == nil || strings.TrimSpace(*token) == "" {
		return 0, true
	}

	raw := strings.TrimSpace(*token)
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		writeInvalidPageToken(w, r, err)
		return 0, false
	}

	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 {
		writeInvalidPageToken(w, r, errBadRequest)
		return 0, false
	}
	return offset, true
}

func decodeTraceSessionPageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (traceSessionPageCursor, bool, bool) {
	cursor, set, ok := decodeCursorPageToken[traceSessionPageCursor](w, r, token)
	if !ok || !set {
		return cursor, set, ok
	}
	if cursor.StartedAt.IsZero() || cursor.TraceID == "" || cursor.SessionID == "" {
		writeInvalidPageToken(w, r, errBadRequest)
		return traceSessionPageCursor{}, false, false
	}
	return cursor, true, true
}

func decodeSpanPageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (spanPageCursor, bool, bool) {
	cursor, set, ok := decodeCursorPageToken[spanPageCursor](w, r, token)
	if !ok || !set {
		return cursor, set, ok
	}
	if cursor.StartTime.IsZero() || cursor.ID < 1 {
		writeInvalidPageToken(w, r, errBadRequest)
		return spanPageCursor{}, false, false
	}
	return cursor, true, true
}

func decodeEventPageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (eventPageCursor, bool, bool) {
	cursor, set, ok := decodeCursorPageToken[eventPageCursor](w, r, token)
	if !ok || !set {
		return cursor, set, ok
	}
	if cursor.EventTime.IsZero() || cursor.ID < 1 {
		writeInvalidPageToken(w, r, errBadRequest)
		return eventPageCursor{}, false, false
	}
	return cursor, true, true
}

type aggregatedEventPageCursor struct {
	LastSeen time.Time `json:"last_seen"`
}

func decodeAggregatedEventPageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (aggregatedEventPageCursor, bool, bool) {
	cursor, set, ok := decodeCursorPageToken[aggregatedEventPageCursor](w, r, token)
	if !ok || !set {
		return cursor, set, ok
	}
	if cursor.LastSeen.IsZero() {
		writeInvalidPageToken(w, r, errBadRequest)
		return aggregatedEventPageCursor{}, false, false
	}
	return cursor, true, true
}

func decodeCursorPageToken[T any](w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (T, bool, bool) {
	var cursor T
	if token == nil || strings.TrimSpace(*token) == "" {
		return cursor, false, true
	}

	raw := strings.TrimSpace(*token)
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		writeInvalidPageToken(w, r, err)
		return cursor, false, false
	}
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		writeInvalidPageToken(w, r, err)
		return cursor, false, false
	}
	return cursor, true, true
}

func writeInvalidPageToken(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"page_token is invalid",
		err,
	))
}

func encodeOffsetToken(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func encodeCursorPageToken(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
