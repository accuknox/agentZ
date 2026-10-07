package authorization

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// DelegationLabel identifies controller-owned OAuth resource routes.
const DelegationLabel = "agentz.accuknox.com/delegation"

// DelegationClaims binds an OAuth access token to its immutable AgentZ grant.
type DelegationClaims struct {
	jwt.RegisteredClaims
	ClientID  string `json:"azp"`
	GrantID   string `json:"agentz_grant_id"`
	Scope     string `json:"scope"`
	SessionID string `json:"sid"`
}

// VerifyDelegationToken checks the access-token contract before live authorization.
func VerifyDelegationToken(bearer, issuer, audience string, key jwt.Keyfunc) (DelegationClaims, error) {
	claims := DelegationClaims{}
	token, err := jwt.ParseWithClaims(bearer, &claims, key,
		jwt.WithValidMethods([]string{"ES256", "RS256"}), jwt.WithIssuer(issuer),
		jwt.WithAudience(audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithStrictDecoding(),
	)
	if err != nil {
		return claims, err
	}
	missingIdentity := claims.GrantID == "" || claims.ClientID == "" || claims.Subject == ""
	if token.Header["typ"] != "at+jwt" || missingIdentity || claims.IssuedAt == nil {
		return claims, errors.New("invalid delegated access token")
	}
	return claims, nil
}

// DelegationTLS loads the controller-issued workload identity and private CA.
// Leaf certificates reload at each handshake so mounted cert-manager rotations
// take effect without restarting streams. CA changes require a controlled rollout.
func DelegationTLS(directory string) (*tls.Config, error) {
	ca, err := os.ReadFile(filepath.Join(directory, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("read delegation CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid delegation CA")
	}
	certificate := func() (*tls.Certificate, error) {
		pair, err := tls.LoadX509KeyPair(filepath.Join(directory, "tls.crt"), filepath.Join(directory, "tls.key"))
		if err != nil {
			return nil, fmt.Errorf("load delegation workload certificate: %w", err)
		}
		return &pair, nil
	}
	if _, err := certificate(); err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13, RootCAs: roots, ClientCAs: roots,
		GetCertificate:       func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return certificate() },
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return certificate() },
	}, nil
}

// DelegationOwner identifies an authenticated extAuth workload by its exact DNS
// identity. It cannot obtain another namespace's authority through request fields.
func DelegationOwner(state tls.ConnectionState) (string, error) {
	if len(state.VerifiedChains) == 0 {
		return "", errors.New("unverified delegation peer")
	}
	for _, name := range state.PeerCertificates[0].DNSNames {
		namespace, ok := strings.CutPrefix(name, "extauth.")
		if !ok {
			continue
		}
		namespace, ok = strings.CutSuffix(namespace, ".svc")
		if ok && namespace != "" && !strings.ContainsAny(namespace, ".*") {
			return namespace, nil
		}
	}
	return "", errors.New("peer is not an owner extAuth workload")
}
