package gateway

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/host"
	hostv1 "github.com/accuknox/agentz/internal/host/proto"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listersv1alpha1 "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
)

type computeQueries struct {
	gatewaydb.Querier
	calls int
}

// GatewayConsumeComputeEnrollment represents an expired or already used token.
func (q *computeQueries) GatewayConsumeComputeEnrollment(_ context.Context, _ gatewaydb.GatewayConsumeComputeEnrollmentParams) (gatewaydb.ComputeHost, error) {
	q.calls++
	return gatewaydb.ComputeHost{}, pgx.ErrNoRows
}

// GatewayListAgentsByName supplies legacy and not-yet-enrolled resources.
func (q *computeQueries) GatewayListAgentsByName(_ context.Context, _ gatewaydb.GatewayListAgentsByNameParams) ([]gatewaydb.Agent, error) {
	return []gatewaydb.Agent{{AgentName: "legacy"}, {AgentName: "native"}}, nil
}

// GatewayListUsersByID leaves optional actor metadata absent.
func (q *computeQueries) GatewayListUsersByID(_ context.Context, _ []string) ([]gatewaydb.GatewayListUsersByIDRow, error) {
	return nil, nil
}

func TestRedeemComputeRejectsConsumedCode(t *testing.T) {
	t.Parallel()
	q := &computeQueries{}
	s := &Service{queries: q, relay: &host.RelayClient{}}
	body, err := json.Marshal(gatewayapi.RedeemComputeEnrollmentRequest{
		Code: strings.Repeat("a", 43), Hostname: "laptop", WorkDirectory: "/home/alice/agentz",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/compute/enroll", bytes.NewReader(body))
	response := httptest.NewRecorder()
	s.RedeemComputeEnrollment(response, request)
	if response.Code != http.StatusUnauthorized || q.calls != 1 {
		t.Fatalf("consumed token returned %d with %d lookups: %s", response.Code, q.calls, response.Body.String())
	}
}

func TestNativeTransportOfflineNeverDials(t *testing.T) {
	t.Parallel()
	client, fixture := newGatewayRelay(t, "")
	transport := &hostHTTPTransport{relay: client}
	hostnames := []string{
		"agent.workspace.native.agentz",
		"agent.workspace.stale.native.agentz",
	}
	for _, hostname := range hostnames {
		request := httptest.NewRequest(http.MethodPost, "http://"+hostname+":4096/session", nil)
		request.Header.Set("X-Agentz-Compute-Connection", "old-connection")
		if _, err := transport.RoundTrip(request); err == nil {
			t.Fatal("offline or pre-fenced hostname was accepted")
		}
		if request.Header.Get("X-Agentz-Compute-Connection") != "old-connection" {
			t.Fatal("transport mutated caller request")
		}
	}
	if fixture.dials.Load() != 0 {
		t.Fatal("offline host received a data stream")
	}
}

func TestComputeAgentListingBeforeEnrollment(t *testing.T) {
	t.Parallel()
	index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	for _, agt := range []*agentzv1alpha1.Agent{
		{ObjectMeta: metav1.ObjectMeta{Name: "legacy", Namespace: "workspace"}},
		{
			ObjectMeta: metav1.ObjectMeta{Name: "native", Namespace: "workspace"},
			Spec: agentzv1alpha1.AgentSpec{
				Execution: agentzv1alpha1.AgentExecutionNative,
			},
		},
	} {
		if err := index.Add(agt); err != nil {
			t.Fatal(err)
		}
	}
	s := &Service{queries: &computeQueries{}, resolver: &resolver{agents: listersv1alpha1.NewAgentLister(index)}}
	connection, apiErr := s.nativeAdmission(t.Context(), "workspace", "native")
	if connection != "" || apiErr == nil || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("unenrolled native admission should be offline: connection=%q error=%v", connection, apiErr)
	}
	params := gatewaydb.GatewayListAgentsByNameParams{
		TenantNamespace: "workspace", PageSize: 3,
	}
	items, _, err := s.listAgentItems(t.Context(), params, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("agent count=%d, want2", len(items))
	}
	if items[0].Execution == nil || *items[0].Execution != gatewayapi.AgentExecutionKubernetes {
		t.Fatalf("legacy execution: %#v", items[0].Execution)
	}
	if items[1].Execution == nil || *items[1].Execution != gatewayapi.AgentExecutionNative {
		t.Fatalf("legacy/native list contract: %#v", items)
	}
}

func TestRedeemComputeRejectsInvalidRootBeforeConsumingCode(t *testing.T) {
	t.Parallel()
	invalidRoots := []string{
		"/", "relative", "/home/alice/../bob", "/home/alice/", "/home/alice\n",
	}
	for _, root := range invalidRoots {
		t.Run(root, func(t *testing.T) {
			q := &computeQueries{}
			s := &Service{queries: q, relay: &host.RelayClient{}}
			body, err := json.Marshal(gatewayapi.RedeemComputeEnrollmentRequest{
				Code: strings.Repeat("a", 43), Hostname: "laptop", WorkDirectory: root,
			})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/compute/enroll", bytes.NewReader(body))
			response := httptest.NewRecorder()
			s.RedeemComputeEnrollment(response, request)
			if response.Code != http.StatusBadRequest || q.calls != 0 {
				t.Fatalf("invalid root returned %d with %d lookups", response.Code, q.calls)
			}
		})
	}
}

func TestQueuedNativeCodingOperationNeverReplaysOffline(t *testing.T) {
	t.Parallel()
	client, _ := newGatewayRelay(t, "")
	service := &Service{relay: client}
	job := gatewaydb.CodingOperation{
		ComputeConnectionID: "previous-control-connection",
		WorkspaceID:         "workspace",
	}
	// No stores, Git clients or publish callbacks are available: rejection must
	// precede every side effect, including the branch-naming special case.
	actions := []gatewayapi.CodingAction{
		gatewayapi.CodingActionNameBranch,
		gatewayapi.CodingActionCommit,
	}
	for _, action := range actions {
		input := gatewayapi.CodingOperationRequest{AgentName: "agent", Action: action}
		err := service.executeCodingOperation(t.Context(), job, input, &gatewayapi.CodingOperation{}, nil)
		if err == nil || !strings.Contains(err.Error(), "retry the coding operation explicitly") {
			t.Fatalf("queued %s reached execution: %v", action, err)
		}
	}
}

func TestNativeTransportRejectsPreviousConnectionContext(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, "workspace")
	client, fixture := newGatewayRelay(t, "current-control-connection")
	transport := &hostHTTPTransport{relay: client}
	request := httptest.NewRequest(http.MethodPost, "http://agent."+namespace+".native.agentz:4096/session", nil)
	requestContext := context.WithValue(
		ctx, computeConnectionContextKey{}, "previous-control-connection",
	)
	request = request.WithContext(requestContext)
	_, err := transport.RoundTrip(request)
	if err == nil || !strings.Contains(err.Error(), "reconnected") {
		t.Fatalf("stale context reached newly connected host: %v", err)
	}
	service := &Service{relay: client}
	operation := gatewaydb.CodingOperation{
		WorkspaceID: "workspace", ComputeConnectionID: "previous-control-connection",
	}
	err = service.executeCodingOperation(
		ctx, operation, gatewayapi.CodingOperationRequest{AgentName: "agent"},
		&gatewayapi.CodingOperation{}, nil,
	)
	if err == nil {
		t.Fatal("queued operation replayed onto newly connected host")
	}
	if fixture.dials.Load() != 0 {
		t.Fatal("stale admission reached host data stream")
	}
}

// gatewayRelayFixture exercises the gateway against the internal RPC boundary.
type gatewayRelayFixture struct {
	hostv1.UnimplementedRelayControlServer
	session string
	dials   atomic.Int32
}

func (f *gatewayRelayFixture) GetSession(context.Context, *hostv1.SessionRequest) (*hostv1.SessionResponse, error) {
	return &hostv1.SessionResponse{SessionId: f.session, Ready: f.session != ""}, nil
}
func (f *gatewayRelayFixture) Dial(grpc.BidiStreamingServer[hostv1.RelayFrame, hostv1.RelayFrame]) error {
	f.dials.Add(1)
	return status.Error(codes.PermissionDenied, "test must reject before host dial")
}
func newGatewayRelay(t *testing.T, session string) (*host.RelayClient, *gatewayRelayFixture) {
	t.Helper()
	certificate := httptest.NewTLSServer(http.NotFoundHandler())
	certificate.Close()
	roots := x509.NewCertPool()
	roots.AddCert(certificate.Certificate())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &gatewayRelayFixture{session: session}
	tlsConfig := &tls.Config{
		Certificates: certificate.TLS.Certificates,
		MinVersion:   tls.VersionTLS13,
	}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(tlsConfig)))
	hostv1.RegisterRelayControlServer(server, fixture)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	address := listener.Addr().String()
	client, err := host.NewRelayClient(address, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return client, fixture
}
