package mcp

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

const environmentRoutePrefix = "/mcp/environments/"

// BearerSecretRecord stores one bearer credential in OpenBao.
type BearerSecretRecord struct {
	Token     string    `json:"token"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// OAuthSecretRecord stores one OAuth credential record in OpenBao.
type OAuthSecretRecord struct {
	ClientID     string         `json:"clientId,omitempty"`
	ClientSecret string         `json:"clientSecret,omitempty"`
	Token        *oauth2.Token  `json:"token,omitempty"`
	Scopes       []string       `json:"scopes,omitempty"`
	Registration map[string]any `json:"registration,omitempty"`
	Revocation   map[string]any `json:"revocation,omitempty"`
	UpdatedAt    time.Time      `json:"updatedAt"`
}

// EnvironmentNameFromPath extracts the environment name from one MCP request path.
func EnvironmentNameFromPath(rawPath string) (string, error) {
	trimmed := strings.TrimSpace(rawPath)
	if trimmed == "" {
		return "", fmt.Errorf("mcp path is empty")
	}

	parsed, err := url.ParseRequestURI(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse mcp path: %w", err)
	}

	path := parsed.EscapedPath()
	if !strings.HasPrefix(path, environmentRoutePrefix) {
		return "", fmt.Errorf("mcp path %q does not use prefix %q", path, environmentRoutePrefix)
	}

	name := strings.TrimPrefix(path, environmentRoutePrefix)
	if name == "" {
		return "", fmt.Errorf("mcp path %q is missing environment name", path)
	}
	if strings.Contains(name, "/") {
		return "", fmt.Errorf("mcp path %q must target exactly one environment", path)
	}

	return name, nil
}
