package sinjector

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestRewriteRequestRewritesBasicAuth(t *testing.T) {
	raw := "user:clawarmor:resolve:env:TOKEN"
	req := &http.Request{
		Method: http.MethodGet,
		URL:    &url.URL{Scheme: "https", Host: "example.com", Path: "/v1"},
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(raw)))

	res := &testResolver{
		values: map[string]string{"TOKEN": "secret"},
		calls:  map[string]int{},
	}
	got := rewriteRequest(req.WithContext(context.Background()), res)
	value := strings.TrimPrefix(got.Header.Get("Authorization"), "Basic ")
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("decode basic auth: %v", err)
	}
	if string(decoded) != "user:secret" {
		t.Fatalf("decoded auth = %q, want user:secret", decoded)
	}
}
