package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/cache"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/accuknox/agentz/internal/compute"
	computev1 "github.com/accuknox/agentz/internal/compute/proto"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/mcp"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listersv1alpha1 "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
)

type computeQueries struct {
	gatewaydb.Querier
	host        gatewaydb.ComputeHost
	identity    string
	identityErr error
	calls       int
}

// GatewayComputeIdentity simulates assignment lookup after TLS authentication.
func (q *computeQueries) GatewayComputeIdentity(_ context.Context, id string) (gatewaydb.ComputeHost, error) {
	q.calls++
	q.identity = id
	return q.host, q.identityErr
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

type computeAuthorizationCase struct {
	name      string
	peer      *peer.Peer
	execution agentzv1alpha1.AgentExecution
	deleted   bool
	lookupErr error
	want      codes.Code
}

func TestComputeAuthorization(t *testing.T) {
	t.Parallel()
	identity, _ := url.Parse("spiffe://agentz.example/compute/host/daemon")
	invalid, _ := url.Parse("https://agentz.example/compute/host/daemon")
	cert := &x509.Certificate{URIs: []*url.URL{identity}}
	authenticated := &peer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{cert},
	}}}
	tests := []computeAuthorizationCase{
		{name: "missing peer", want: codes.Unauthenticated},
		{name: "missing TLS identity", peer: &peer.Peer{}, want: codes.Unauthenticated},
		{name: "missing certificate", peer: &peer.Peer{AuthInfo: credentials.TLSInfo{}}, want: codes.Unauthenticated},
		{
			name: "ambiguous identity", want: codes.Unauthenticated,
			peer: &peer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
				PeerCertificates: []*x509.Certificate{{URIs: []*url.URL{identity, identity}}},
			}}},
		},
		{
			name: "non SPIFFE URI", want: codes.Unauthenticated,
			peer: &peer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
				PeerCertificates: []*x509.Certificate{{URIs: []*url.URL{invalid}}},
			}}},
		},
		{name: "revoked assignment", peer: authenticated, lookupErr: pgx.ErrNoRows, want: codes.PermissionDenied},
		{name: "managed Agent", peer: authenticated, want: codes.PermissionDenied},
		{name: "deleted Agent", peer: authenticated, execution: agentzv1alpha1.AgentExecutionNative, deleted: true, want: codes.PermissionDenied},
		// go-spiffe authenticates in VerifyPeerCertificate; crypto/tls VerifiedChains is empty.
		{name: "SPIFFE callback verified native", peer: authenticated, execution: agentzv1alpha1.AgentExecutionNative, want: codes.OK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			agt := &agentzv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
				Spec:       agentzv1alpha1.AgentSpec{Execution: tc.execution},
			}
			if tc.deleted {
				stamp := metav1.Now()
				agt.DeletionTimestamp = &stamp
				agt.Finalizers = []string{"test"}
			}
			q := &computeQueries{host: gatewaydb.ComputeHost{ID: uuid.New(), TenantNamespace: "workspace", AgentName: "agent"}, identityErr: tc.lookupErr}
			s := &Service{queries: q, k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(agt).Build()}
			ctx := t.Context()
			if tc.peer != nil {
				ctx = peer.NewContext(ctx, tc.peer)
			}
			binding, err := s.authorizeCompute(ctx)
			if status.Code(err) != tc.want {
				t.Fatalf("authorization=%v, want %s", err, tc.want)
			}
			if tc.want == codes.Unauthenticated && q.calls != 0 {
				t.Fatal("unverified identity reached assignment lookup")
			}
			if tc.want == codes.OK && (binding.Namespace != "workspace" || binding.Agent != "agent" || binding.Epoch != q.host.ID.String() || q.identity != identity.String()) {
				t.Fatalf("wrong assignment binding: %#v", binding)
			}
		})
	}
}

func TestComputeForwardRejectsRouteEscapes(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, agentzv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
		Spec: agentzv1alpha1.AgentSpec{
			Execution: agentzv1alpha1.AgentExecutionNative,
			SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeWorkspace, Name: "sandbox",
			},
		},
	}
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name:   "workspace",
		Labels: map[string]string{agentzv1alpha1.WorkspaceNameLabel: "workspace"},
	}}
	s := &Service{k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(agt, ns).Build()}
	prefix := mcp.AgentRoutePath("sandbox", "workspace", "agent")
	for _, target := range []string{prefix + "/../foreign", prefix + "/%2e%2e/foreign", prefix + "//foreign", prefix + "/a/./b", prefix + "/%5cforeign", prefix + "-other", "/"} {
		t.Run(target, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			conn, err := s.computeUpstream(ctx, compute.Binding{Namespace: "workspace", Agent: "agent"}, computev1.Service_SERVICE_MCP)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequest(http.MethodGet, "http://bridge"+target, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := request.Write(conn); err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("escape returned %d, want403", response.StatusCode)
			}
		})
	}
}

func TestRedeemComputeRejectsConsumedCode(t *testing.T) {
	t.Parallel()
	q := &computeQueries{}
	s := &Service{queries: q, computeIdentity: &compute.IdentityAdmin{}}
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
	transport := &computeHTTPTransport{server: compute.NewServer(compute.Callbacks{})}
	for _, hostname := range []string{"agent.workspace.native.agentz", "agent.workspace.stale.native.agentz"} {
		request := httptest.NewRequest(http.MethodPost, "http://"+hostname+":4096/session", nil)
		request.Header.Set("X-Agentz-Compute-Connection", "old-connection")
		if _, err := transport.RoundTrip(request); err == nil {
			t.Fatal("offline or pre-fenced hostname was accepted")
		}
		if request.Header.Get("X-Agentz-Compute-Connection") != "old-connection" {
			t.Fatal("transport mutated caller request")
		}
	}
}

func TestComputeAgentListingBeforeEnrollment(t *testing.T) {
	t.Parallel()
	index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	for _, agt := range []*agentzv1alpha1.Agent{
		{ObjectMeta: metav1.ObjectMeta{Name: "legacy", Namespace: "workspace"}},
		{ObjectMeta: metav1.ObjectMeta{Name: "native", Namespace: "workspace"}, Spec: agentzv1alpha1.AgentSpec{Execution: agentzv1alpha1.AgentExecutionNative}},
	} {
		if err := index.Add(agt); err != nil {
			t.Fatal(err)
		}
	}
	s := &Service{queries: &computeQueries{}, resolver: &resolver{agents: listersv1alpha1.NewAgentLister(index)}}
	if connection, apiErr := s.nativeAdmission(t.Context(), "workspace", "native"); connection != "" || apiErr == nil || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("unenrolled native admission should be offline: connection=%q error=%v", connection, apiErr)
	}
	items, _, err := s.listAgentItems(t.Context(), gatewaydb.GatewayListAgentsByNameParams{TenantNamespace: "workspace", PageSize: 3}, nil, 0)
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
	for _, root := range []string{"/", "relative", "/home/alice/../bob", "/home/alice/", "/home/alice\n"} {
		t.Run(root, func(t *testing.T) {
			q := &computeQueries{}
			s := &Service{queries: q, computeIdentity: &compute.IdentityAdmin{}}
			body, err := json.Marshal(gatewayapi.RedeemComputeEnrollmentRequest{Code: strings.Repeat("a", 43), Hostname: "laptop", WorkDirectory: root})
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
	service := &Service{computeServer: compute.NewServer(compute.Callbacks{})}
	job := gatewaydb.CodingOperation{ComputeConnectionID: "previous-control-connection", WorkspaceID: "workspace"}
	// No stores, Git clients or publish callbacks are available: rejection must
	// precede every side effect, including the branch-naming special case.
	for _, action := range []gatewayapi.CodingAction{gatewayapi.CodingActionNameBranch, gatewayapi.CodingActionCommit} {
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
	ready := make(chan struct{}, 1)
	namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, "workspace")
	server := compute.NewServer(compute.Callbacks{
		Authorize: func(context.Context) (compute.Binding, error) {
			return compute.Binding{Namespace: namespace, Agent: "agent", Epoch: "assignment"}, nil
		},
		Desired: func(context.Context, compute.Binding) (*computev1.Runtime, error) {
			return &computev1.Runtime{Generation: "one"}, nil
		},
		Observe: func(_ context.Context, _ compute.Binding, state compute.Status) error {
			if state.Ready {
				select {
				case ready <- struct{}{}:
				default:
				}
			}
			return nil
		},
	})
	listener := bufconn.Listen(1 << 20)
	defer listener.Close()
	rpcServer := grpc.NewServer()
	computev1.RegisterComputeServer(rpcServer, server)
	go func() { _ = rpcServer.Serve(listener) }()
	defer rpcServer.Stop()
	connection, err := grpc.NewClient("passthrough:///compute-test", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return listener.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	stream, err := computev1.NewComputeClient(connection).Control(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&computev1.Heartbeat{Generation: "one", Ready: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("control did not become ready")
	}
	if _, online := server.Connection(namespace, "agent"); !online {
		t.Fatal("host is not live")
	}
	transport := &computeHTTPTransport{server: server}
	request := httptest.NewRequest(http.MethodPost, "http://agent."+namespace+".native.agentz:4096/session", nil)
	request = request.WithContext(context.WithValue(ctx, computeConnectionContextKey{}, "previous-control-connection"))
	if _, err := transport.RoundTrip(request); err == nil || !strings.Contains(err.Error(), "reconnected") {
		t.Fatalf("stale context reached newly connected host: %v", err)
	}
	service := &Service{computeServer: server}
	err = service.executeCodingOperation(ctx, gatewaydb.CodingOperation{WorkspaceID: "workspace", ComputeConnectionID: "previous-control-connection"}, gatewayapi.CodingOperationRequest{AgentName: "agent"}, &gatewayapi.CodingOperation{}, nil)
	if err == nil {
		t.Fatal("queued operation replayed onto newly connected host")
	}
}
