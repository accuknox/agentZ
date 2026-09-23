package host

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	hostv1 "github.com/accuknox/agentz/internal/host/proto"
	"github.com/google/uuid"
	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	agentv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/agent/v1"
	bundlev1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/bundle/v1"
	entryv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/entry/v1"
	authorityv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/localauthority/v1"
	svidv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/svid/v1"
	"github.com/spiffe/spire-api-sdk/proto/spire/api/types"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// NodeLifetime is the node certificate lifetime, independent of workload SVIDs.
const NodeLifetime = 210 * 24 * time.Hour

// DaemonExecutable is installed as an actual executable, not a version symlink.
const DaemonExecutable = "/usr/local/lib/agentz/agentz"

// IdentityAdmin uses SPIRE's administrative API; it never issues credentials itself.
// Its socket or client identity must never be exposed to a managed workload.
type IdentityAdmin struct {
	conn        *grpc.ClientConn
	domain      spiffeid.TrustDomain
	agents      agentv1.AgentClient
	entries     entryv1.EntryClient
	bundles     bundlev1.BundleClient
	authorities authorityv1.LocalAuthorityClient
	material    atomic.Pointer[serverIdentity]
}

// NewIdentityAdmin connects only to a local SPIRE administration Unix socket.
func NewIdentityAdmin(socketPath, trustDomain string) (*IdentityAdmin, error) {
	if !filepath.IsAbs(socketPath) {
		return nil, errors.New("SPIRE admin socket must be an absolute path")
	}
	return newIdentityAdmin("unix://"+socketPath, trustDomain, insecure.NewCredentials())
}

// NewRemoteIdentityAdmin requires caller-provided mutually authenticated TLS.
// Use go-spiffe's dynamically rotating client configuration and pin the server ID.
func NewRemoteIdentityAdmin(target, trustDomain string, config *tls.Config) (*IdentityAdmin, error) {
	if config == nil || config.InsecureSkipVerify && config.VerifyPeerCertificate == nil && config.VerifyConnection == nil {
		return nil, errors.New("SPIRE remote administration requires verified TLS")
	}
	if len(config.Certificates) == 0 && config.GetClientCertificate == nil {
		return nil, errors.New("SPIRE remote administration requires a client identity")
	}
	return newIdentityAdmin(target, trustDomain, credentials.NewTLS(config.Clone()))
}

func newIdentityAdmin(target, trustDomain string, creds credentials.TransportCredentials) (*IdentityAdmin, error) {
	domain, err := spiffeid.TrustDomainFromString(trustDomain)
	if err != nil {
		return nil, fmt.Errorf("SPIRE trust domain: %w", err)
	}
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(creds))
	if err != nil {
		return nil, fmt.Errorf("SPIRE admin connection: %w", err)
	}
	return &IdentityAdmin{
		conn: conn, domain: domain, agents: agentv1.NewAgentClient(conn),
		entries: entryv1.NewEntryClient(conn), bundles: bundlev1.NewBundleClient(conn),
		authorities: authorityv1.NewLocalAuthorityClient(conn),
	}, nil
}

// Close releases the administrative connection.
func (a *IdentityAdmin) Close() error { return a.conn.Close() }

// Enroll binds a one-time token to precisely one daemon workload identity.
// The identity UUID comes from the authorized backend enrollment, not the host.
func (a *IdentityAdmin) Enroll(ctx context.Context, identity string) (*hostv1.EnrollmentResponse, error) {
	if _, err := uuid.Parse(identity); err != nil {
		return nil, fmt.Errorf("invalid host identity: %w", err)
	}
	state, err := a.authorities.GetX509AuthorityState(ctx, &authorityv1.GetX509AuthorityStateRequest{})
	if err != nil {
		return nil, fmt.Errorf("get SPIRE signing authority: %w", err)
	}
	if state.Active == nil || state.Active.UpstreamAuthoritySubjectKeyId == "" {
		return nil, errors.New("host enrollment requires a stable SPIRE upstream root")
	}
	if !time.Unix(state.Active.ExpiresAt, 0).After(time.Now().Add(NodeLifetime + time.Hour)) {
		return nil, errors.New("SPIRE signing authority lacks six-month node headroom; check authority maintenance")
	}
	bundle, err := a.Bundle(ctx)
	if err != nil {
		return nil, err
	}
	token, err := a.agents.CreateJoinToken(ctx, &agentv1.CreateJoinTokenRequest{Ttl: 600})
	if err != nil {
		return nil, fmt.Errorf("create SPIRE join token: %w", err)
	}
	node := &types.SPIFFEID{TrustDomain: a.domain.String(), Path: "/spire/agent/join_token/" + token.Value}
	workload := &types.SPIFFEID{TrustDomain: a.domain.String(), Path: "/agentz/daemon/" + identity}
	result, err := a.entries.BatchCreateEntry(ctx, &entryv1.BatchCreateEntryRequest{Entries: []*types.Entry{{
		SpiffeId: workload, ParentId: node, X509SvidTtl: 3600,
		Selectors: []*types.Selector{
			{Type: "unix", Value: "uid:0"},
			{Type: "unix", Value: "path:" + DaemonExecutable},
		},
	}}})
	if err != nil {
		return nil, fmt.Errorf("register daemon workload: %w", err)
	}
	if len(result.Results) != 1 || result.Results[0].GetStatus().GetCode() != int32(codes.OK) {
		return nil, errors.New("SPIRE did not register daemon workload")
	}
	return &hostv1.EnrollmentResponse{
		JoinToken: token.Value, NodeId: "spiffe://" + node.TrustDomain + node.Path,
		WorkloadId:  "spiffe://" + workload.TrustDomain + workload.Path,
		TrustBundle: bundle, TrustDomain: a.domain.String(),
	}, nil
}

// Bundle returns non-tainted root certificates for authenticated bootstrap delivery.
func (a *IdentityAdmin) Bundle(ctx context.Context) ([]byte, error) {
	bundle, err := a.bundles.GetBundle(ctx, &bundlev1.GetBundleRequest{})
	if err != nil {
		return nil, fmt.Errorf("fetch SPIRE trust bundle: %w", err)
	}
	state, err := a.authorities.GetX509AuthorityState(ctx, &authorityv1.GetX509AuthorityStateRequest{})
	if err != nil {
		return nil, fmt.Errorf("get active SPIRE root identity: %w", err)
	}
	if state.Active == nil {
		return nil, errors.New("SPIRE has no active signing authority")
	}
	var result []byte
	longLived := false
	for _, authority := range bundle.X509Authorities {
		if authority.Tainted {
			continue
		}
		cert, err := x509.ParseCertificate(authority.Asn1)
		if err != nil {
			return nil, fmt.Errorf("parse SPIRE root: %w", err)
		}
		activeRoot := hex.EncodeToString(cert.SubjectKeyId) == state.Active.UpstreamAuthoritySubjectKeyId
		if activeRoot && cert.NotAfter.After(time.Now().Add(365*24*time.Hour)) {
			longLived = true
		}
		result = append(result, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: authority.Asn1})...)
	}
	if !longLived {
		return nil, errors.New("SPIRE upstream root has less than one year validity; rotate with offline trust overlap")
	}
	return result, nil
}

// Validate checks actual attested validity before promising another offline window.
func (a *IdentityAdmin) Validate(ctx context.Context, nodeID string) (time.Time, error) {
	id, err := spiffeid.FromString(nodeID)
	if err != nil || !id.MemberOf(a.domain) || !strings.HasPrefix(id.Path(), "/spire/agent/join_token/") {
		return time.Time{}, errors.New("invalid SPIRE host node identity")
	}
	agent, err := a.agents.GetAgent(ctx, &agentv1.GetAgentRequest{Id: &types.SPIFFEID{TrustDomain: a.domain.String(), Path: id.Path()}})
	if err != nil {
		return time.Time{}, fmt.Errorf("get SPIRE node: %w", err)
	}
	expiry := time.Unix(agent.X509SvidExpiresAt, 0)
	if agent.Banned {
		return expiry, errors.New("SPIRE node is banned")
	}
	if expiry.Before(time.Now().Add(184 * 24 * time.Hour)) {
		return expiry, errors.New("SPIRE node renewal has not restored six-month validity")
	}
	return expiry, nil
}

// Revoke bans the enrolled node and removes its workload grants. Application
// authorization must separately close sessions using already-issued workload SVIDs.
func (a *IdentityAdmin) Revoke(ctx context.Context, nodeID, workloadID string) error {
	node, err := spiffeid.FromString(nodeID)
	if err != nil || !node.MemberOf(a.domain) || !strings.HasPrefix(node.Path(), "/spire/agent/join_token/") {
		return errors.New("invalid host node identity")
	}
	workload, err := spiffeid.FromString(workloadID)
	if err != nil || !workload.MemberOf(a.domain) || !strings.HasPrefix(workload.Path(), "/agentz/daemon/") {
		return errors.New("invalid daemon workload identity")
	}
	_, banErr := a.agents.BanAgent(ctx, &agentv1.BanAgentRequest{Id: &types.SPIFFEID{TrustDomain: a.domain.String(), Path: node.Path()}})
	if status.Code(banErr) == codes.NotFound {
		banErr = nil
	}
	request := &entryv1.ListEntriesRequest{Filter: &entryv1.ListEntriesRequest_Filter{
		ByParentId: &types.SPIFFEID{TrustDomain: a.domain.String(), Path: node.Path()},
		BySpiffeId: &types.SPIFFEID{TrustDomain: a.domain.String(), Path: workload.Path()},
	}}
	var ids []string
	for {
		entries, err := a.entries.ListEntries(ctx, request)
		if err != nil {
			return errors.Join(banErr, fmt.Errorf("list daemon grants: %w", err))
		}
		for _, entry := range entries.Entries {
			ids = append(ids, entry.Id)
		}
		request.PageToken = entries.NextPageToken
		if request.PageToken == "" {
			break
		}
	}
	if len(ids) == 0 {
		return banErr
	}
	deleted, err := a.entries.BatchDeleteEntry(ctx, &entryv1.BatchDeleteEntryRequest{Ids: ids})
	if err != nil {
		return errors.Join(banErr, fmt.Errorf("delete daemon grants: %w", err))
	}
	for _, result := range deleted.Results {
		code := codes.Code(result.GetStatus().GetCode())
		if code != codes.OK && code != codes.NotFound {
			return errors.Join(banErr, status.Error(code, result.GetStatus().GetMessage()))
		}
	}
	return banErr
}

// rotateAuthority advances a signing intermediate through SPIRE's built-in APIs.
// Exactly one maintainer may call it per SPIRE server.
// Old authorities remain valid for sleeping nodes.
func (a *IdentityAdmin) rotateAuthority(ctx context.Context) error {
	state, err := a.authorities.GetX509AuthorityState(ctx, &authorityv1.GetX509AuthorityStateRequest{})
	if err != nil {
		return fmt.Errorf("get SPIRE authority: %w", err)
	}
	if state.Active == nil || state.Active.UpstreamAuthoritySubjectKeyId == "" {
		return errors.New("six-month host identity requires a stable SPIRE upstream root")
	}
	// A 365-day CA is advanced after 90 days, leaving 65 days of slack above
	// the 210-day node lifetime even if the periodic maintenance call is delayed.
	if time.Unix(state.Active.ExpiresAt, 0).After(time.Now().Add(275 * 24 * time.Hour)) {
		return nil
	}
	// SPIRE automatically prepares within 30 days and activates within seven.
	// Its API checks and slot rotation are not one atomic operation. If this
	// maintainer was absent that long, leave recovery to SPIRE's own rotator.
	if !time.Unix(state.Active.ExpiresAt, 0).After(time.Now().Add(31 * 24 * time.Hour)) {
		return errors.New("SPIRE authority reached automatic rotation window; waiting for built-in rotation")
	}
	prepared := state.Prepared
	if prepared == nil || time.Unix(prepared.ExpiresAt, 0).Before(time.Now().Add(300*24*time.Hour)) {
		response, err := a.authorities.PrepareX509Authority(ctx, &authorityv1.PrepareX509AuthorityRequest{})
		if err != nil {
			return fmt.Errorf("prepare SPIRE authority: %w", err)
		}
		prepared = response.PreparedAuthority
	}
	if prepared == nil || time.Unix(prepared.ExpiresAt, 0).Before(time.Now().Add(300*24*time.Hour)) {
		return errors.New("upstream CA cannot issue a sufficiently long signing authority")
	}
	_, err = a.authorities.ActivateX509Authority(ctx, &authorityv1.ActivateX509AuthorityRequest{AuthorityId: prepared.AuthorityId})
	if err != nil {
		return fmt.Errorf("activate SPIRE authority: %w", err)
	}
	return nil
}

// serverIdentity is immutable after publication to TLS handshake readers.
type serverIdentity struct {
	svid   *x509svid.SVID
	bundle *x509bundle.Bundle
}

// ServerTLS obtains the relay workload identity from SPIRE's built-in mint API.
// The caller must run Maintain for certificate and trust-bundle refresh.
func (a *IdentityAdmin) ServerTLS(ctx context.Context) (*tls.Config, error) {
	if err := a.refreshServerIdentity(ctx); err != nil {
		return nil, err
	}
	return tlsconfig.MTLSServerConfig(a, a, func(id spiffeid.ID, _ [][]*x509.Certificate) error {
		if !id.MemberOf(a.domain) || !strings.HasPrefix(id.Path(), "/agentz/daemon/") {
			return errors.New("peer is not an AgentZ daemon")
		}
		_, err := uuid.Parse(strings.TrimPrefix(id.Path(), "/agentz/daemon/"))
		return err
	}), nil
}

// GetX509SVID implements go-spiffe's rotating SVID source without handshake I/O.
func (a *IdentityAdmin) GetX509SVID() (*x509svid.SVID, error) {
	material := a.material.Load()
	if material == nil {
		return nil, errors.New("relay SPIFFE identity unavailable")
	}
	return material.svid, nil
}

// GetX509BundleForTrustDomain implements the go-spiffe bundle source.
func (a *IdentityAdmin) GetX509BundleForTrustDomain(domain spiffeid.TrustDomain) (*x509bundle.Bundle, error) {
	material := a.material.Load()
	if material == nil || domain != a.domain {
		return nil, errors.New("SPIFFE trust bundle unavailable")
	}
	return material.bundle, nil
}

func (a *IdentityAdmin) refreshServerIdentity(ctx context.Context) error {
	raw, err := a.Bundle(ctx)
	if err != nil {
		return err
	}
	bundle, err := x509bundle.Parse(a.domain, raw)
	if err != nil {
		return fmt.Errorf("parse relay trust bundle: %w", err)
	}
	current := a.material.Load()
	if current != nil && current.svid.Certificates[0].NotAfter.After(time.Now().Add(30*time.Minute)) {
		a.material.Store(&serverIdentity{svid: current.svid, bundle: bundle})
		return nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	id, err := spiffeid.FromPath(a.domain, "/agentz/relay")
	if err != nil {
		return err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{URIs: []*url.URL{id.URL()}}, key)
	if err != nil {
		return fmt.Errorf("create relay CSR: %w", err)
	}
	response, err := svidv1.NewSVIDClient(a.conn).MintX509SVID(ctx, &svidv1.MintX509SVIDRequest{Csr: csr, Ttl: 3600})
	if err != nil {
		return fmt.Errorf("mint relay SVID: %w", err)
	}
	var chain []byte
	for _, cert := range response.GetSvid().GetCertChain() {
		chain = append(chain, cert...)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	svid, err := x509svid.ParseRaw(chain, keyDER)
	if err != nil {
		return fmt.Errorf("parse relay SVID: %w", err)
	}
	if svid.ID != id {
		return errors.New("SPIRE returned an unexpected relay identity")
	}
	a.material.Store(&serverIdentity{svid: svid, bundle: bundle})
	return nil
}

// Maintain refreshes short-lived relay certificates and trust bundles.
// Transient failures retain the last identity and are retried; expired
// certificates still fail TLS verification rather than weakening authentication.
func (a *IdentityAdmin) Maintain(ctx context.Context) error {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := a.refreshServerIdentity(refreshCtx)
			cancel()
			if err != nil {
				slog.ErrorContext(ctx, "refresh relay SPIFFE identity", "error", err)
			}
		}
	}
}

// MaintainAuthority runs only beside the singleton SPIRE server using its local
// admin socket. Relays must never mutate shared signing authority slots.
// SPIRE prepares and activates the certificates; this loop only schedules early
// rotation to preserve the node lifetime beyond its seven-day automatic cap.
func (a *IdentityAdmin) MaintainAuthority(ctx context.Context) error {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		rotationCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := a.rotateAuthority(rotationCtx)
		cancel()
		if err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "maintain SPIRE authority", "error", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
