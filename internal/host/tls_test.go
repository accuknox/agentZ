package host

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
)

type tlsTestCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}
type tlsTestIdentity struct {
	svid            *x509svid.SVID
	certPEM, keyPEM []byte
}
type tlsPeerTest struct {
	name, serverPath, clientPath          string
	wrongCA, expiredServer, expiredClient bool
}

func TestClientTLSAuthenticatesBothPeers(t *testing.T) {
	ca := newTLSCA(t)
	foreign := newTLSCA(t)
	for _, test := range []tlsPeerTest{
		{name: "valid", serverPath: "/spire/server", clientPath: "/agentz/relay-admin"},
		{name: "wrong server URI", serverPath: "/other", clientPath: "/agentz/relay-admin"},
		{name: "wrong client URI", serverPath: "/spire/server", clientPath: "/other"},
		{name: "wrong CA", serverPath: "/spire/server", clientPath: "/agentz/relay-admin", wrongCA: true},
		{name: "expired server", serverPath: "/spire/server", clientPath: "/agentz/relay-admin", expiredServer: true},
		{name: "expired client", serverPath: "/spire/server", clientPath: "/agentz/relay-admin", expiredClient: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			serverCA := ca
			if test.wrongCA {
				serverCA = foreign
			}
			server := tlsIdentity(t, serverCA, test.serverPath, test.expiredServer)
			client := tlsIdentity(t, ca, test.clientPath, test.expiredClient)
			dir := t.TempDir()
			writeTLSFiles(t, dir, ca, client)
			config, err := ClientTLS(dir+"/tls.crt", dir+"/tls.key", dir+"/root.pem", "tls.example", "/spire/server")
			if err != nil {
				t.Fatal(err)
			}
			endpoint := tlsEndpoint(t, server, ca)
			transport := &http.Transport{TLSClientConfig: config, DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			response, err := (&http.Client{Transport: transport, Timeout: 3 * time.Second}).Get(endpoint.URL)
			if response != nil {
				response.Body.Close()
			}
			if test.name == "valid" && err != nil {
				t.Fatal(err)
			}
			if test.name != "valid" && err == nil {
				t.Fatal("untrusted peer accepted")
			}
		})
	}
}

func TestClientTLSReloadsProjectedIdentityAndRoots(t *testing.T) {
	firstCA, secondCA := newTLSCA(t), newTLSCA(t)
	first := tlsIdentity(t, firstCA, "/agentz/relay-admin", false)
	second := tlsIdentity(t, secondCA, "/agentz/relay-admin", false)
	dir := t.TempDir()
	for _, name := range []string{"first", "second"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	writeTLSFiles(t, dir+"/first", firstCA, first)
	writeTLSFiles(t, dir+"/second", secondCA, second)
	if err := os.Symlink("first", dir+"/..data"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tls.crt", "tls.key", "root.pem"} {
		if err := os.Symlink("..data/"+name, dir+"/"+name); err != nil {
			t.Fatal(err)
		}
	}
	config, err := ClientTLS(dir+"/tls.crt", dir+"/tls.key", dir+"/root.pem", "tls.example", "/spire/server")
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{TLSClientConfig: config, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	firstEndpoint := tlsEndpoint(t, tlsIdentity(t, firstCA, "/spire/server", false), firstCA)
	response, err := client.Get(firstEndpoint.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if err := os.Symlink("second", dir+"/..next"); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(dir+"/..next", dir+"/..data"); err != nil {
		t.Fatal(err)
	}
	secondEndpoint := tlsEndpoint(t, tlsIdentity(t, secondCA, "/spire/server", false), secondCA)
	response, err = client.Get(secondEndpoint.URL)
	if err != nil {
		t.Fatalf("rotated credential or root not loaded: %v", err)
	}
	response.Body.Close()
	response, err = client.Get(firstEndpoint.URL)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("removed root still trusted")
	}
	// A partially replaced pair must not retain an older usable identity.
	if err := os.WriteFile(dir+"/second/tls.key", first.keyPEM, 0600); err != nil {
		t.Fatal(err)
	}
	response, err = client.Get(secondEndpoint.URL)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("mismatched projected pair accepted")
	}
	if err := os.WriteFile(dir+"/second/tls.key", second.keyPEM, 0600); err != nil {
		t.Fatal(err)
	}
	response, err = client.Get(secondEndpoint.URL)
	if err != nil {
		t.Fatalf("next handshake did not recover: %v", err)
	}
	response.Body.Close()
	if err := os.WriteFile(dir+"/second/root.pem", nil, 0600); err != nil {
		t.Fatal(err)
	}
	response, err = client.Get(secondEndpoint.URL)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("empty projected root accepted")
	}
}

func newTLSCA(t *testing.T) tlsTestCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: serial, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tlsTestCA{cert: cert, key: key}
}

func tlsIdentity(t *testing.T, ca tlsTestCA, path string, expired bool) tlsTestIdentity {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := spiffeid.RequireFromPath(spiffeid.RequireTrustDomainFromString("tls.example"), path)
	end := time.Now().Add(time.Hour)
	if expired {
		end = time.Now().Add(-time.Minute)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		NotBefore:    time.Now().Add(-time.Hour), NotAfter: end,
		URIs: []*url.URL{id.URL()}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, key.Public(), ca.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return tlsTestIdentity{
		svid:    &x509svid.SVID{ID: id, Certificates: []*x509.Certificate{cert}, PrivateKey: key},
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		keyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}),
	}
}

func writeTLSFiles(t *testing.T, dir string, ca tlsTestCA, identity tlsTestIdentity) {
	t.Helper()
	files := map[string][]byte{
		"tls.crt": identity.certPEM, "tls.key": identity.keyPEM,
		"root.pem": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.cert.Raw}),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func tlsEndpoint(t *testing.T, identity tlsTestIdentity, ca tlsTestCA) *httptest.Server {
	t.Helper()
	domain := spiffeid.RequireTrustDomainFromString("tls.example")
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = tlsconfig.MTLSServerConfig(
		identity.svid, x509bundle.FromX509Authorities(domain, []*x509.Certificate{ca.cert}),
		tlsconfig.AuthorizeID(spiffeid.RequireFromPath(domain, "/agentz/relay-admin")),
	)
	// Prevent httptest from injecting its unrelated localhost certificate.
	server.TLS.Certificates = []tls.Certificate{{
		Certificate: [][]byte{identity.svid.Certificates[0].Raw},
		PrivateKey:  identity.svid.PrivateKey,
	}}
	server.TLS.MinVersion = tls.VersionTLS13
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}
