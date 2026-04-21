package observer

import (
	"context"
	"testing"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func TestNormalizeFlowAllowed(t *testing.T) {
	t.Parallel()

	sessionID := uuid.MustParse("51047bae-702a-4115-bcde-95fff10593bb")
	res := &resolver{
		cache: map[string]uuid.UUID{
			"default/agent-sample": sessionID,
		},
	}

	ev, ok := normalizeFlow(context.Background(), managedFlow(flowpb.Verdict_FORWARDED), "default", res, newDNSCache())
	if !ok {
		t.Fatal("normalizeFlow() filtered allowed flow")
	}
	if ev.network == nil {
		t.Fatal("network event is nil")
	}
	if ev.network.sessionID != sessionID {
		t.Fatalf("sessionID = %s, want %s", ev.network.sessionID, sessionID)
	}
	if ev.network.destinationIP != "104.20.23.154" {
		t.Fatalf("destinationIP = %q", ev.network.destinationIP)
	}
	if ev.network.destinationPort != 443 {
		t.Fatalf("destinationPort = %d", ev.network.destinationPort)
	}
	if ev.network.action != actionAllowed {
		t.Fatalf("action = %q, want %q", ev.network.action, actionAllowed)
	}
}

func TestNormalizeFlowBlocked(t *testing.T) {
	t.Parallel()

	sessionID := uuid.MustParse("51047bae-702a-4115-bcde-95fff10593bb")
	res := &resolver{
		cache: map[string]uuid.UUID{
			"default/agent-sample": sessionID,
		},
	}

	ev, ok := normalizeFlow(context.Background(), managedFlow(flowpb.Verdict_DROPPED), "default", res, newDNSCache())
	if !ok {
		t.Fatal("normalizeFlow() filtered blocked flow")
	}
	if ev.network.action != actionBlocked {
		t.Fatalf("action = %q, want %q", ev.network.action, actionBlocked)
	}
}

func TestNormalizeFlowFiltersReplies(t *testing.T) {
	t.Parallel()

	sessionID := uuid.MustParse("51047bae-702a-4115-bcde-95fff10593bb")
	res := &resolver{
		cache: map[string]uuid.UUID{
			"default/agent-sample": sessionID,
		},
	}
	flow := managedFlow(flowpb.Verdict_FORWARDED)
	flow.IsReply = wrapperspb.Bool(true)

	_, ok := normalizeFlow(context.Background(), flow, "default", res, newDNSCache())
	if ok {
		t.Fatal("normalizeFlow() accepted reply flow")
	}
}

func TestDNSCacheUsesTTL(t *testing.T) {
	t.Parallel()

	cache := newDNSCache()
	now := time.Date(2026, 4, 20, 15, 0, 0, 0, time.UTC)
	sessionID := uuid.MustParse("51047bae-702a-4115-bcde-95fff10593bb")

	cache.put(sessionID, "agent-sample", "1.1.1.1", "example.com", now, 1)
	if got := cache.get(sessionID, "agent-sample", "1.1.1.1", now); got != "example.com" {
		t.Fatalf("cache before expiry = %q", got)
	}
	if got := cache.get(sessionID, "agent-sample", "1.1.1.1", now.Add(2*time.Second)); got != "" {
		t.Fatalf("cache after expiry = %q", got)
	}
}

func managedFlow(verdict flowpb.Verdict) *flowpb.Flow {
	return &flowpb.Flow{
		Time:    timestamppb.New(time.Date(2026, 4, 20, 15, 0, 0, 0, time.UTC)),
		Verdict: verdict,
		IP: &flowpb.IP{
			Source:      "10.244.0.1",
			Destination: "104.20.23.154",
		},
		L4: &flowpb.Layer4{
			Protocol: &flowpb.Layer4_TCP{
				TCP: &flowpb.TCP{
					DestinationPort: 443,
				},
			},
		},
		Source: &flowpb.Endpoint{
			Namespace: "default",
			PodName:   "agent-sample",
			Labels: []string{
				"k8s:app.kubernetes.io/name=clawarmor-agent",
				"k8s:clawarmor.accuknox.com/agent=agent-sample",
				"k8s:clawarmor.accuknox.com/managed=true",
			},
		},
		TrafficDirection: flowpb.TrafficDirection_EGRESS,
		IsReply:          wrapperspb.Bool(false),
	}
}
