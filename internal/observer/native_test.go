package observer

import (
	"testing"

	"github.com/accuknox/agentz/internal/host"
	pb "github.com/kubearmor/KubeArmor/protobuf"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestNativeSecurityEventAttributionAndResult(t *testing.T) {
	record := &pb.Log{
		Type: "HostLog", NamespaceName: "forged", PodName: "forged",
		ParentProcessName: "/nix/store/runtime/bin/opencode",
		ProcessName:       "/usr/bin/curl",
		Operation:         "Network",
		Resource:          "remoteip=2001:db8::1 port=443 protocol=TCP",
		Result:            "Permission denied",
	}
	data, err := protojson.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	event, err := nativeSecurityEvent(
		"tenant-trusted", "agent-trusted",
		host.SecurityEvent{Kind: "log", Event: data},
	)
	if err != nil {
		t.Fatal(err)
	}
	network := event.network
	if network == nil {
		t.Fatal("missing network event")
		return
	}
	wrongAttribution := network.tenantNamespace != "tenant-trusted" ||
		network.agentName != "agent-trusted" || network.podName != ""
	wrongDestination := network.destinationIP != "2001:db8::1" || network.destinationPort != 443
	if wrongAttribution || wrongDestination || network.action != actionBlocked {
		t.Fatalf("wrong native network event: %+v", network)
	}
	record.ParentProcessName = "/bin/bash"
	data, _ = protojson.Marshal(record)
	_, err = nativeSecurityEvent("tenant", "agent", host.SecurityEvent{Kind: "log", Event: data})
	if err == nil {
		t.Fatal("accepted unrelated parent")
	}
	record.ParentProcessName = "opencode"
	record.ContainerID = "container"
	data, _ = protojson.Marshal(record)
	_, err = nativeSecurityEvent("tenant", "agent", host.SecurityEvent{Kind: "log", Event: data})
	if err == nil {
		t.Fatal("accepted container event")
	}
}

func TestRewriteNativeTracesRemovesSpanTenantOverrides(t *testing.T) {
	forged := func(key string) *commonpb.KeyValue {
		return &commonpb.KeyValue{
			Key: key,
			Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{
				StringValue: "forged",
			}},
		}
	}
	span := &tracepb.Span{TraceId: make([]byte, 16), SpanId: make([]byte, 8), Attributes: []*commonpb.KeyValue{
		forged(attrAgentZTenantNamespace),
		forged(attrAgentZTenantNamespace),
		forged(attrAgentZAgentName),
		forged(attrK8sNamespaceName),
		forged(attrServiceNamespace),
		{
			Key: attrSessionID,
			Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{
				StringValue: "session-1",
			}},
		},
	}}
	request := &tracev1.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
			forged(attrAgentZTenantNamespace), forged(attrAgentZAgentName),
		}},
		ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span}}},
	}}}
	RewriteNativeTraces("trusted-tenant", "trusted-agent", request)
	events, rejected := traceEventsFromOTLPRequest(request)
	if rejected != 0 || len(events) != 1 {
		t.Fatalf("events=%d rejected=%d", len(events), rejected)
	}
	wrongAttribution := events[0].tenantNamespace != "trusted-tenant" ||
		events[0].agentName != "trusted-agent"
	if wrongAttribution || events[0].sessionID != "session-1" {
		t.Fatalf("incorrect trace attribution: %+v", events[0])
	}
}
