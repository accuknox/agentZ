package sinjector

import (
	"crypto/tls"
	"net/http"
)

// proxy is an HTTP CONNECT proxy that optionally performs TLS MITM to inspect
// HTTP/1.1 traffic for secret injection. Non-HTTP protocols and HTTP/2 are
// passed through without inspection.
type proxy struct {
	ca        *tls.Certificate
	certCache *certStore
	resolver  secretResolver
}

// ServeHTTP implements http.Handler. Only CONNECT is accepted; everything else
// receives 400 Bad Request.
func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "CONNECT required", http.StatusBadRequest)
		return
	}

	p.handleConnect(w, r)
}
