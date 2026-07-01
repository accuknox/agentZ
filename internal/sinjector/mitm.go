package sinjector

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"time"
)

// mitmServerConfig returns a TLS config that presents a dynamically-generated
// leaf certificate for host, signed by the CA. The ALPN is forced to http/1.1
// so the client cannot negotiate HTTP/2, which we do not inspect.
func mitmServerConfig(host string, ca *tls.Certificate, cache *certStore) (*tls.Config, error) {
	cert, err := cache.Get(host, func() (*tls.Certificate, error) {
		return signHost(*ca, []string{host})
	})
	if err != nil {
		return nil, err
	}

	return &tls.Config{
		Certificates: []tls.Certificate{*cert},
		NextProtos:   []string{"http/1.1"},
	}, nil
}

// upstreamTLSConfig returns a TLS config for connecting to the real upstream.
// ALPN is forced to http/1.1 so the upstream speaks HTTP/1.1 plaintext that
// we can parse and inject.
func upstreamTLSConfig(host string) *tls.Config {
	return &tls.Config{
		ServerName: host,
		NextProtos: []string{"http/1.1"},
	}
}

// signHost creates a leaf certificate signed by the CA, valid for the given
// hosts (DNS names or IPs).
func signHost(ca tls.Certificate, hosts []string) (*tls.Certificate, error) {
	caCert, err := x509.ParseCertificate(ca.Certificate[0])
	if err != nil {
		return nil, err
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(
		rand.Reader,
		new(big.Int).Lsh(big.NewInt(1), 128),
	)
	if err != nil {
		return nil, err
	}

	template := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"clawarmor"},
		},
		NotBefore:   time.Now().Add(-24 * time.Hour),
		NotAfter:    time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
			continue
		}
		template.DNSNames = append(template.DNSNames, h)
	}

	certDER, err := x509.CreateCertificate(
		rand.Reader,
		&template,
		caCert,
		&priv.PublicKey,
		ca.PrivateKey,
	)
	if err != nil {
		return nil, err
	}

	return &tls.Certificate{
		Certificate: [][]byte{certDER, ca.Certificate[0]},
		PrivateKey:  priv,
	}, nil
}

// stripPort returns the hostname without the port.
func stripPort(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}
