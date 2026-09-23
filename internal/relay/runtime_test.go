package relay

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/host"
	hostv1 "github.com/accuknox/agentz/internal/host/proto"
	"github.com/accuknox/agentz/internal/mcp"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type hostQueries struct {
	gatewaydb.Querier
	host        gatewaydb.ComputeHost
	identity    string
	identityErr error
	calls       int
}

func (q *hostQueries) GatewayComputeIdentity(_ context.Context, id string) (gatewaydb.ComputeHost, error) {
	q.calls++
	q.identity = id
	return q.host, q.identityErr
}

type rpcMethod string

func (m rpcMethod) Method() string             { return string(m) }
func (rpcMethod) SetHeader(metadata.MD) error  { return nil }
func (rpcMethod) SendHeader(metadata.MD) error { return nil }
func (rpcMethod) SetTrailer(metadata.MD) error { return nil }

type hostAuthorizationCase struct {
	name      string
	peer      *peer.Peer
	execution agentzv1alpha1.AgentExecution
	deleted   bool
	lookupErr error
	method    string
	want      codes.Code
}

func TestHostAuthorization(t *testing.T) {
	t.Parallel()
	identity, _ := url.Parse("spiffe://agentz.example/agentz/daemon/48ad5708-d759-44a4-8ae4-9007939a4761")
	invalid, _ := url.Parse("https://agentz.example/agentz/daemon/48ad5708-d759-44a4-8ae4-9007939a4761")
	cert := &x509.Certificate{URIs: []*url.URL{identity}}
	authenticated := &peer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{cert},
	}}}
	tests := []hostAuthorizationCase{
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
		{
			name: "data without live session", peer: authenticated,
			execution: agentzv1alpha1.AgentExecutionNative,
			method:    hostv1.HostRelay_Data_FullMethodName, want: codes.PermissionDenied,
		},
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
			q := &hostQueries{
				host: gatewaydb.ComputeHost{
					ID: uuid.New(), TenantNamespace: "workspace", AgentName: "agent",
				},
				identityErr: tc.lookupErr,
			}
			s := &Service{
				queries: q, hosts: host.NewRelay(host.Callbacks{}),
				k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(agt).Build(),
			}
			method := tc.method
			if method == "" {
				method = hostv1.HostRelay_Control_FullMethodName
			}
			ctx := grpc.NewContextWithServerTransportStream(t.Context(), rpcMethod(method))
			if tc.peer != nil {
				ctx = peer.NewContext(ctx, tc.peer)
			}
			binding, err := s.authorizeHost(ctx)
			if status.Code(err) != tc.want {
				t.Fatalf("authorization=%v, want %s", err, tc.want)
			}
			if tc.want == codes.Unauthenticated && q.calls != 0 {
				t.Fatal("unverified identity reached assignment lookup")
			}
			wrongBinding := binding.Namespace != "workspace" || binding.Agent != "agent" ||
				binding.Epoch != q.host.ID.String() || q.identity != identity.String()
			if tc.want == codes.OK && wrongBinding {
				t.Fatalf("wrong assignment binding: %#v", binding)
			}
		})
	}
}

func TestHostForwardRejectsRouteEscapes(t *testing.T) {
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
	for _, target := range []string{
		prefix + "/../foreign", prefix + "/%2e%2e/foreign", prefix + "//foreign",
		prefix + "/a/./b", prefix + "/%5cforeign", prefix + "-other", "/",
	} {
		t.Run(target, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			conn, err := s.dialUpstream(ctx, host.Binding{Namespace: "workspace", Agent: "agent"}, hostv1.Service_SERVICE_MCP)
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
