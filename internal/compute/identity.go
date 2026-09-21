package compute

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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

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

// OfflineTarget maintains headroom beyond six calendar months of inactivity.
const OfflineTarget = 200 * 24 * time.Hour

// DaemonExecutable is installed as an actual executable, not a version symlink.
const DaemonExecutable = "/usr/local/lib/agentz/agentz"

// Enrollment contains a single-use bootstrap credential and its public identities.
type Enrollment struct {
	JoinToken   string    `json:"joinToken"`
	NodeID      string    `json:"nodeID"`
	WorkloadID  string    `json:"workloadID"`
	ExpiresAt   time.Time `json:"expiresAt"`
	TrustBundle string    `json:"trustBundle"`
}

// IdentityAdmin uses SPIRE's administrative API; it never issues credentials itself.
// Its socket or client identity must never be exposed to a managed workload.
type IdentityAdmin struct {
	conn        *grpc.ClientConn
	domain      spiffeid.TrustDomain
	agents      agentv1.AgentClient
	entries     entryv1.EntryClient
	bundles     bundlev1.BundleClient
	authorities authorityv1.LocalAuthorityClient
	rotation    sync.Mutex
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
func (a *IdentityAdmin) Enroll(ctx context.Context, identity string, uid uint32, executable string) (Enrollment, error) {
	if _, err := uuid.Parse(identity); err != nil {
		return Enrollment{}, fmt.Errorf("invalid compute identity: %w", err)
	}
	if uid != 0 || executable != DaemonExecutable {
		return Enrollment{}, errors.New("daemon requires fixed root UID and installed executable")
	}
	if err := a.RotateAuthority(ctx); err != nil {
		return Enrollment{}, err
	}
	bundle, err := a.Bundle(ctx)
	if err != nil {
		return Enrollment{}, err
	}
	token, err := a.agents.CreateJoinToken(ctx, &agentv1.CreateJoinTokenRequest{Ttl: 600})
	if err != nil {
		return Enrollment{}, fmt.Errorf("create SPIRE join token: %w", err)
	}
	node := &types.SPIFFEID{TrustDomain: a.domain.String(), Path: "/spire/agent/join_token/" + token.Value}
	workload := &types.SPIFFEID{TrustDomain: a.domain.String(), Path: "/agentz/daemon/" + identity}
	result, err := a.entries.BatchCreateEntry(ctx, &entryv1.BatchCreateEntryRequest{Entries: []*types.Entry{{
		SpiffeId: workload, ParentId: node, X509SvidTtl: 3600,
		Selectors: []*types.Selector{{Type: "unix", Value: "uid:" + strconv.FormatUint(uint64(uid), 10)}, {Type: "unix", Value: "path:" + executable}},
	}}})
	if err != nil {
		return Enrollment{}, fmt.Errorf("register daemon workload: %w", err)
	}
	if len(result.Results) != 1 || result.Results[0].GetStatus().GetCode() != int32(codes.OK) {
		return Enrollment{}, errors.New("SPIRE did not register daemon workload")
	}
	return Enrollment{
		JoinToken: token.Value, NodeID: "spiffe://" + node.TrustDomain + node.Path,
		WorkloadID: "spiffe://" + workload.TrustDomain + workload.Path,
		ExpiresAt:  time.Unix(token.ExpiresAt, 0), TrustBundle: string(bundle),
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
		if hex.EncodeToString(cert.SubjectKeyId) == state.Active.UpstreamAuthoritySubjectKeyId && cert.NotAfter.After(time.Now().Add(365*24*time.Hour)) {
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
		return time.Time{}, errors.New("invalid SPIRE compute node identity")
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
		return errors.New("invalid compute node identity")
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

// RotateAuthority advances only this server's signing intermediate through SPIRE's
// built-in APIs. Run on every server periodically; never revoke the old authority
// during ordinary rotation, since sleeping nodes still depend on its signatures.
func (a *IdentityAdmin) RotateAuthority(ctx context.Context) error {
	a.rotation.Lock()
	defer a.rotation.Unlock()
	state, err := a.authorities.GetX509AuthorityState(ctx, &authorityv1.GetX509AuthorityStateRequest{})
	if err != nil {
		return fmt.Errorf("get SPIRE authority: %w", err)
	}
	if state.Active == nil || state.Active.UpstreamAuthoritySubjectKeyId == "" {
		return errors.New("six-month compute identity requires a stable SPIRE upstream root")
	}
	// A 365-day CA is advanced after 90 days, leaving 65 days of slack above
	// the 210-day node lifetime even if the periodic maintenance call is delayed.
	if time.Unix(state.Active.ExpiresAt, 0).After(time.Now().Add(275 * 24 * time.Hour)) {
		return nil
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

// ServerTLS obtains the backend workload identity from SPIRE's built-in mint API.
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
		return nil, errors.New("backend SPIFFE identity unavailable")
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
	if err := a.RotateAuthority(ctx); err != nil {
		return err
	}
	raw, err := a.Bundle(ctx)
	if err != nil {
		return err
	}
	bundle, err := x509bundle.Parse(a.domain, raw)
	if err != nil {
		return fmt.Errorf("parse backend trust bundle: %w", err)
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
	id, err := spiffeid.FromPath(a.domain, "/agentz/backend")
	if err != nil {
		return err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{URIs: []*url.URL{id.URL()}}, key)
	if err != nil {
		return fmt.Errorf("create backend CSR: %w", err)
	}
	response, err := svidv1.NewSVIDClient(a.conn).MintX509SVID(ctx, &svidv1.MintX509SVIDRequest{Csr: csr, Ttl: 3600})
	if err != nil {
		return fmt.Errorf("mint backend SVID: %w", err)
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
		return fmt.Errorf("parse backend SVID: %w", err)
	}
	if svid.ID != id {
		return errors.New("SPIRE returned an unexpected backend identity")
	}
	a.material.Store(&serverIdentity{svid: svid, bundle: bundle})
	return nil
}

// Maintain refreshes short-lived backend certificates and advances local CA
// rotation. Transient failures retain the last identity and are retried; expired
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
				slog.ErrorContext(ctx, "refresh compute SPIFFE identity", "error", err)
			}
		}
	}
}
