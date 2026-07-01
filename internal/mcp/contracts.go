package mcp

import (
	"time"

	"github.com/accuknox/clawarmor/internal/oauth"
)

// SecretRecordKey is the OpenBao field key for stored MCP credentials.
const SecretRecordKey = "credentials"

// BearerSecretRecord stores one bearer credential in OpenBao.
type BearerSecretRecord struct {
	Token     string    `json:"token"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// OAuthSecretRecord stores one OAuth credential record in OpenBao.
type OAuthSecretRecord struct {
	oauth.Record
}
