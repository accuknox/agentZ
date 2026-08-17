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

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
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

type observabilityQuery struct {
	after  *gatewayapi.EventTimeAfterQuery
	before *gatewayapi.EventTimeBeforeQuery
	action *gatewayapi.ActionQuery
}

type observabilityFilter struct {
	after  time.Time
	before time.Time
	action string
}

type workspacePageCursor struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

type agentSharePageCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
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

func validAgentName(w http.ResponseWriter, r *http.Request, name string, fields ...string) (string, bool) {
	if name != "" && name != agentzv1alpha1.AgentNameMCPConnection && len(name) <= 32 && len(validation.IsDNS1123Label(name)) == 0 {
		return name, true
	}

	field := "agent_name"
	if len(fields) > 0 && fields[0] != "" {
		field = fields[0]
	}
	writeError(
		w,
		r,
		newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   field,
				Message: "must be a valid agent name",
			},
		),
	)
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

	writeError(
		w,
		r,
		newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		),
	)
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   field,
					Message: "must be a lowercase hexadecimal identifier",
				},
			),
		)
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

func maxTime() time.Time {
	return time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
}

func decodeObservabilityQuery(w http.ResponseWriter, r *http.Request, query observabilityQuery) (observabilityFilter, bool) {
	filter := observabilityFilter{
		after:  time.Unix(0, 0).UTC(),
		before: maxTime(),
	}
	if query.after != nil {
		filter.after = (*query.after).UTC()
	}
	if query.before != nil {
		filter.before = (*query.before).UTC()
	}
	if filter.after.After(filter.before) {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"event_time_after must be before or equal to event_time_before",
				errBadRequest,
			),
		)
		return observabilityFilter{}, false
	}
	if query.action != nil {
		filter.action = string(*query.action)
		if filter.action != "Allowed" && filter.action != "Blocked" {
			writeError(
				w,
				r,
				newAPIError(
					http.StatusBadRequest,
					"invalid_request",
					"action must be Allowed or Blocked",
					errBadRequest,
				),
			)
			return observabilityFilter{}, false
		}
	}
	return filter, true
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

func decodeWorkspacePageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (workspacePageCursor, bool, bool) {
	cursor, set, ok := decodeCursorPageToken[workspacePageCursor](w, r, token)
	if !ok || !set {
		return cursor, set, ok
	}
	if cursor.Name == "" || cursor.ID == "" {
		writeInvalidPageToken(w, r, errBadRequest)
		return workspacePageCursor{}, false, false
	}
	return cursor, true, true
}

func decodeAgentSharePageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (agentSharePageCursor, bool, bool) {
	cursor, set, ok := decodeCursorPageToken[agentSharePageCursor](w, r, token)
	if !ok || !set {
		return cursor, set, ok
	}
	if cursor.CreatedAt.IsZero() || cursor.ID == "" {
		writeInvalidPageToken(w, r, errBadRequest)
		return agentSharePageCursor{}, false, false
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
	writeError(
		w,
		r,
		newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"page_token is invalid",
			err,
		),
	)
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
