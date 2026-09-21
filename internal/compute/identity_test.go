package compute

import (
	"context"
	"testing"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	agentv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/agent/v1"
	authorityv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/localauthority/v1"
	"github.com/spiffe/spire-api-sdk/proto/spire/api/types"
	"google.golang.org/grpc"
)

type rotationCase struct {
	name                   string
	remaining, newLifetime time.Duration
	upstream               string
	wantRotate, wantError  bool
}
type validityCase struct {
	name              string
	remaining         time.Duration
	banned, wantError bool
}
type enrollmentCase struct {
	identity   string
	uid        uint32
	executable string
}

type testAuthorityClient struct {
	authorityv1.LocalAuthorityClient
	state               *authorityv1.GetX509AuthorityStateResponse
	prepares, activates int
	lifetime            time.Duration
}

func (c *testAuthorityClient) GetX509AuthorityState(context.Context, *authorityv1.GetX509AuthorityStateRequest, ...grpc.CallOption) (*authorityv1.GetX509AuthorityStateResponse, error) {
	return c.state, nil
}
func (c *testAuthorityClient) PrepareX509Authority(context.Context, *authorityv1.PrepareX509AuthorityRequest, ...grpc.CallOption) (*authorityv1.PrepareX509AuthorityResponse, error) {
	c.prepares++
	return &authorityv1.PrepareX509AuthorityResponse{PreparedAuthority: &authorityv1.AuthorityState{AuthorityId: "next", ExpiresAt: time.Now().Add(c.lifetime).Unix()}}, nil
}
func (c *testAuthorityClient) ActivateX509Authority(context.Context, *authorityv1.ActivateX509AuthorityRequest, ...grpc.CallOption) (*authorityv1.ActivateX509AuthorityResponse, error) {
	c.activates++
	return &authorityv1.ActivateX509AuthorityResponse{}, nil
}

func TestEarlyAuthorityRotation(t *testing.T) {
	for _, tc := range []rotationCase{
		{"healthy", 300 * 24 * time.Hour, 365 * 24 * time.Hour, "root", false, false},
		{"advance before node truncation", 274 * 24 * time.Hour, 365 * 24 * time.Hour, "root", true, false},
		{"reject short upstream", 274 * 24 * time.Hour, 180 * 24 * time.Hour, "root", false, true},
		{"reject changing self signed roots", 300 * 24 * time.Hour, 365 * 24 * time.Hour, "", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &testAuthorityClient{
				state: &authorityv1.GetX509AuthorityStateResponse{Active: &authorityv1.AuthorityState{
					AuthorityId: "current", ExpiresAt: time.Now().Add(tc.remaining).Unix(),
					UpstreamAuthoritySubjectKeyId: tc.upstream,
				}},
				lifetime: tc.newLifetime,
			}
			admin := &IdentityAdmin{authorities: client}
			err := admin.RotateAuthority(t.Context())
			if (err != nil) != tc.wantError {
				t.Fatalf("error=%v, wantError=%v", err, tc.wantError)
			}
			if (client.activates > 0) != tc.wantRotate {
				t.Fatalf("activated=%d, wantRotate=%v", client.activates, tc.wantRotate)
			}
		})
	}
}

type testIdentityAgentClient struct {
	agentv1.AgentClient
	node *types.Agent
}

func (c testIdentityAgentClient) GetAgent(context.Context, *agentv1.GetAgentRequest, ...grpc.CallOption) (*types.Agent, error) {
	return c.node, nil
}

func TestNodeValidityUsesActualCertificate(t *testing.T) {
	for _, tc := range []validityCase{
		{"renewed", 210 * 24 * time.Hour, false, false},
		{"CA truncated", 3 * 24 * time.Hour, false, true},
		{"revoked long lived certificate", 210 * 24 * time.Hour, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			admin := &IdentityAdmin{
				domain: spiffeid.RequireTrustDomainFromString("example.org"),
				agents: testIdentityAgentClient{node: &types.Agent{
					X509SvidExpiresAt: time.Now().Add(tc.remaining).Unix(), Banned: tc.banned,
				}},
			}
			_, err := admin.Validate(t.Context(), "spiffe://example.org/spire/agent/join_token/test")
			if (err != nil) != tc.wantError {
				t.Fatalf("error=%v, wantError=%v", err, tc.wantError)
			}
		})
	}
}

func TestEnrollmentRejectsUntrustedExecutionIdentity(t *testing.T) {
	admin := &IdentityAdmin{}
	for _, tc := range []enrollmentCase{
		{"not-a-uuid", 0, DaemonExecutable},
		{"f81d4fae-7dec-11d0-a765-00a0c91e6bf6", 1000, DaemonExecutable},
		{"f81d4fae-7dec-11d0-a765-00a0c91e6bf6", 0, "/tmp/agentz"},
	} {
		if _, err := admin.Enroll(t.Context(), tc.identity, tc.uid, tc.executable); err == nil {
			t.Fatal("accepted untrusted execution identity")
		}
	}
}
