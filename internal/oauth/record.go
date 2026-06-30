package oauth

import (
	"time"

	"golang.org/x/oauth2"
)

// Record stores the shared OAuth credential material kept in OpenBao.
type Record struct {
	ClientID     string         `json:"clientId,omitempty"`
	ClientSecret string         `json:"clientSecret,omitempty"`
	Token        *oauth2.Token  `json:"token,omitempty"`
	Scopes       []string       `json:"scopes,omitempty"`
	Registration map[string]any `json:"registration,omitempty"`
	Revocation   map[string]any `json:"revocation,omitempty"`
	UpdatedAt    time.Time      `json:"updatedAt"`
}
