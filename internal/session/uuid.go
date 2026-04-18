package sessionstore

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func parseUUIDv4(raw string) (uuid.UUID, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return uuid.Nil, fmt.Errorf("session_id is required")
	}

	id, err := uuid.Parse(raw)
	if err != nil || id.Version() != 4 {
		return uuid.Nil, fmt.Errorf("session_id must be a valid UUIDv4")
	}
	return id, nil
}

func parseSessionID(raw string) (uuid.UUID, error) {
	id, err := parseUUIDv4(raw)
	if err != nil {
		return uuid.Nil, status.Error(codes.InvalidArgument, err.Error())
	}
	return id, nil
}

func normalizeSessionID(raw string) (string, error) {
	id, err := parseUUIDv4(raw)
	if err != nil {
		return "", fmt.Errorf("%w", err)
	}
	return id.String(), nil
}
