package secret

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/accuknox/clawarmor/internal/oauth"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// Record is one supported OpenBao runtime record.
type Record interface {
	record()
}

// StaticRecord stores one static agent secret runtime record in OpenBao.
type StaticRecord struct {
	Type       clawarmorv1alpha1.SecretType `json:"type"`
	SecretName string                       `json:"secretName"`
	Hosts      []string                     `json:"hosts"`
	Value      string                       `json:"value"`
	UpdatedAt  time.Time                    `json:"updatedAt"`
}

// OAuthConfig stores the non-sensitive OAuth metadata needed at runtime.
type OAuthConfig struct {
	Provider              string   `json:"provider,omitempty"`
	Issuer                string   `json:"issuer,omitempty"`
	AuthorizationEndpoint string   `json:"authorizationEndpoint,omitempty"`
	TokenEndpoint         string   `json:"tokenEndpoint,omitempty"`
	RegistrationEndpoint  string   `json:"registrationEndpoint,omitempty"`
	Resource              string   `json:"resource,omitempty"`
	Scopes                []string `json:"scopes,omitempty"`
}

// OAuthRecord stores one OAuth-backed agent secret runtime record in OpenBao.
type OAuthRecord struct {
	Type       clawarmorv1alpha1.SecretType `json:"type"`
	SecretName string                       `json:"secretName"`
	Hosts      []string                     `json:"hosts"`
	Config     OAuthConfig                  `json:"config"`
	oauth.Record
}

func (StaticRecord) record() {}

func (OAuthRecord) record() {}

// SecretPath returns the tenant-scoped OpenBao path for one agent secret key.
func SecretPath(tenantNamespace, agentName, key string) string {
	return tenantNamespace + "/" + agentName + "/" + key
}

// RecordType reads the generated Secret type enum from raw OpenBao data.
func RecordType(raw map[string]any) (clawarmorv1alpha1.SecretType, error) {
	payload, err := json.Marshal(raw)
	if err != nil {
		return "", fmt.Errorf("marshal runtime record header: %w", err)
	}

	var header struct {
		Type clawarmorv1alpha1.SecretType `json:"type"`
	}
	if err := json.Unmarshal(payload, &header); err != nil {
		return "", fmt.Errorf("decode runtime record header: %w", err)
	}
	return header.Type, nil
}

// DecodeRecord decodes a controlled OpenBao runtime record into a generated type.
func DecodeRecord[T Record](raw map[string]any) (T, error) {
	var out T
	if err := decode(raw, &out); err != nil {
		return out, err
	}
	return out, nil
}

// RecordData encodes one controlled runtime record for OpenBao KV storage.
func RecordData(record Record) (map[string]any, error) {
	payload, err := json.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("marshal secret runtime: %w", err)
	}
	out := map[string]any{}
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, fmt.Errorf("decode secret runtime: %w", err)
	}
	return out, nil
}

func decode(raw map[string]any, out any) error {
	payload, err := json.Marshal(raw)
	if err != nil {
		return fmt.Errorf("marshal runtime record: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("decode runtime record: %w", err)
	}
	return nil
}
