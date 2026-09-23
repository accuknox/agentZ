package host

import (
	"crypto/tls"
	"errors"
	"fmt"

	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
)

// ClientTLS authenticates to one SPIFFE identity using a projected certificate
// and trust bundle. It reloads both on each handshake, so Secret rotation requires
// no watcher or process restart. A mismatched pair during projection fails closed;
// the next connection retries against the current files.
func ClientTLS(certFile, keyFile, bundleFile, trustDomain, serverPath string) (*tls.Config, error) {
	domain, err := spiffeid.TrustDomainFromString(trustDomain)
	if err != nil {
		return nil, fmt.Errorf("TLS trust domain: %w", err)
	}
	serverID, err := spiffeid.FromPath(domain, serverPath)
	if err != nil {
		return nil, fmt.Errorf("TLS server identity: %w", err)
	}
	bundle := fileBundle{domain: domain, path: bundleFile}
	if _, err := bundle.GetX509BundleForTrustDomain(domain); err != nil {
		return nil, err
	}
	if _, err := tls.LoadX509KeyPair(certFile, keyFile); err != nil {
		return nil, fmt.Errorf("TLS client identity: %w", err)
	}
	config := tlsconfig.TLSClientConfig(bundle, tlsconfig.AuthorizeID(serverID))
	config.MinVersion = tls.VersionTLS13
	config.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
		certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			return nil, fmt.Errorf("reload TLS client identity: %w", err)
		}
		return &certificate, nil
	}
	return config, nil
}

// fileBundle implements go-spiffe's trust source with the current projected file.
type fileBundle struct {
	domain spiffeid.TrustDomain
	path   string
}

// GetX509BundleForTrustDomain reloads the configured domain's public roots.
func (b fileBundle) GetX509BundleForTrustDomain(domain spiffeid.TrustDomain) (*x509bundle.Bundle, error) {
	if domain != b.domain {
		return nil, errors.New("TLS peer belongs to an untrusted domain")
	}
	bundle, err := x509bundle.Load(domain, b.path)
	if err != nil {
		return nil, fmt.Errorf("load TLS trust bundle: %w", err)
	}
	if len(bundle.X509Authorities()) == 0 {
		return nil, errors.New("TLS trust bundle is empty")
	}
	return bundle, nil
}
