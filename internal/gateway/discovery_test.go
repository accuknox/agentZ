package gateway

import (
	"net/http"
	"testing"
)

func TestGuardrailDiscoveryRejectsUnsafeCredentialConfigurations(t *testing.T) {
	payloads := []string{
		`{"type":"external_account","credential_source":{"url":"http://169.254.169.254/"}}`,
		`{"type":"impersonated_service_account","source_credentials":{}}`,
		`{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","token_uri":"http://127.0.0.1/steal"}`,
		`{"type":"service_account","client_email":"test@example.com","private_key":"secret","token_uri":"https://oauth2.googleapis.com/token?redirect=evil"}`,
		`{"type":"authorized_user","web":{"auth_uri":"https://evil.example/"}}`,
		`{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","universe_domain":"evil.example"}`,
	}
	for _, payload := range payloads {
		if _, err := guardrailGoogleCredentials(t.Context(), payload, &http.Client{}); err == nil {
			t.Fatal("unsafe credentials accepted")
		}
	}
}
