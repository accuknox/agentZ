package extauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"strconv"
	"testing"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	statuspb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type ownerAuthority struct {
	t *testing.T
}

func (a ownerAuthority) Check(_ context.Context, request *authv3.CheckRequest, _ ...grpc.CallOption) (*authv3.CheckResponse, error) {
	http := request.GetAttributes().GetRequest().GetHttp()
	if http.GetBody() != "" || len(http.GetRawBody()) != 0 {
		a.t.Fatal("inference content sent to the decision service")
	}
	return &authv3.CheckResponse{Status: &statuspb.Status{Code: int32(codes.OK)}}, nil
}

type ownerRevisionCase struct {
	name, uid, generation string
	want                  codes.Code
}

func TestDelegationCredentialsRequireProjectedResourceRevision(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	metadata := metav1.ObjectMeta{Name: "selected", Namespace: "owner", UID: "original", Generation: 2}
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metadata,
		Spec:       agentzv1alpha1.InferenceProviderSpec{Kind: agentzv1alpha1.InferenceProviderKindOpenAI},
	}
	connection := &agentzv1alpha1.MCPConnection{ObjectMeta: metadata}
	service := &Service{
		namespace:           "owner",
		kube:                fake.NewClientBuilder().WithScheme(scheme).WithObjects(provider, connection).Build(),
		delegationAuthority: ownerAuthority{t: t},
	}
	certificate := &x509.Certificate{DNSNames: []string{"inference.owner.svc"}}
	ctx := peer.NewContext(t.Context(), &peer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate}, VerifiedChains: [][]*x509.Certificate{{certificate}},
	}}})
	for _, operation := range []string{"inference", "mcp"} {
		t.Run(operation, func(t *testing.T) {
			for _, test := range []ownerRevisionCase{
				{name: "current", uid: "original", generation: strconv.FormatInt(metadata.Generation, 10), want: codes.OK},
				{name: "stale spec", uid: "original", generation: "1", want: codes.Unavailable},
				{name: "missing revision", uid: "original", want: codes.Unavailable},
				{name: "replaced resource", uid: "replacement", generation: "2", want: codes.Unavailable},
			} {
				t.Run(test.name, func(t *testing.T) {
					request := &authv3.CheckRequest{Attributes: &authv3.AttributeContext{
						ContextExtensions: map[string]string{
							"agentz.operation": operation, "agentz.namespace": "owner", "agentz.name": "selected",
							"agentz.uid": test.uid, "agentz.generation": test.generation, "agentz.target": "model",
						},
						Request: &authv3.AttributeContext_Request{Http: &authv3.AttributeContext_HttpRequest{
							Method: "POST", Path: "/v1/chat/completions", Body: `{"model":"model","messages":[]}`,
						}},
					}}
					response, err := service.checkDelegation(ctx, request)
					if err != nil {
						t.Fatal(err)
					}
					if response.GetStatus().GetCode() != int32(test.want) {
						t.Fatalf("status %v, want %v", response.GetStatus(), test.want)
					}
					if test.want != codes.OK && response.GetOkResponse() != nil {
						t.Fatal("stale resource returned credential injection")
					}
				})
			}
		})
	}
}
