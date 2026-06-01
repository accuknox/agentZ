package mcp

import (
	"time"

	"golang.org/x/oauth2"
)

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
