package observer

import (
	"context"
	"slices"
	"time"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type nativeTraceServer struct {
	tracev1.UnimplementedTraceServiceServer
	namespace string
	agent     string
	client    tracev1.TraceServiceClient
}

// NativeTraceServer forwards OTLP under the authenticated compute assignment.
// The caller must bound gRPC receive sizes and close the connection on revocation.
func NativeTraceServer(namespace, agent string, client tracev1.TraceServiceClient) tracev1.TraceServiceServer {
	return &nativeTraceServer{namespace: namespace, agent: agent, client: client}
}

func (s *nativeTraceServer) Export(ctx context.Context, request *tracev1.ExportTraceServiceRequest) (*tracev1.ExportTraceServiceResponse, error) {
	if s.namespace == "" || s.agent == "" || s.client == nil {
		return nil, status.Error(codes.FailedPrecondition, "native trace assignment unavailable")
	}
	RewriteNativeTraces(s.namespace, s.agent, request)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return s.client.Export(ctx, request)
}

// RewriteNativeTraces replaces every attribute that can determine observer
// tenancy, including span overrides and duplicate keys. Other trace data remains.
func RewriteNativeTraces(namespace, agent string, request *tracev1.ExportTraceServiceRequest) {
	identityKey := func(attribute *commonpb.KeyValue) bool {
		if attribute == nil {
			return true
		}
		switch attribute.Key {
		case attrAgentZTenantNamespace, attrAgentZAgentName, attrK8sNamespaceName, attrServiceNamespace:
			return true
		}
		return false
	}
	for _, resource := range request.GetResourceSpans() {
		if resource == nil {
			continue
		}
		if resource.Resource == nil {
			resource.Resource = &resourcepb.Resource{}
		}
		resource.Resource.Attributes = slices.DeleteFunc(resource.Resource.Attributes, identityKey)
		resource.Resource.Attributes = append(resource.Resource.Attributes,
			&commonpb.KeyValue{Key: attrAgentZTenantNamespace, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: namespace}}},
			&commonpb.KeyValue{Key: attrAgentZAgentName, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: agent}}},
		)
		for _, scope := range resource.GetScopeSpans() {
			for _, span := range scope.GetSpans() {
				if span != nil {
					span.Attributes = slices.DeleteFunc(span.Attributes, identityKey)
				}
			}
		}
	}
}
