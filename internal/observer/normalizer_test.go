package observer

import (
	"testing"
	"time"

	pb "github.com/kubearmor/KubeArmor/protobuf"
)

func TestNormalizeLogProcess(t *testing.T) {
	t.Parallel()

	const agentName = "agent-sample"
	ev, ok := normalizeLog(&pb.Log{
		UpdatedTime:       "2026-04-20T15:04:59.058553Z",
		NamespaceName:     "default",
		Type:              "ContainerLog",
		Operation:         "Process",
		PodName:           "agent-sample",
		ProcessName:       "/usr/bin/id",
		ParentProcessName: "/usr/bin/dash",
		Resource:          "/usr/bin/id -u",
	}, "default", agentName)
	if !ok {
		t.Fatal("normalizeLog() filtered process event")
	}
	if ev.process == nil {
		t.Fatal("process event is nil")
	}
	if ev.process.agentName != agentName {
		t.Fatalf("agentName = %s, want %s", ev.process.agentName, agentName)
	}
	if ev.process.commandInvocation != "/usr/bin/id -u" {
		t.Fatalf("commandInvocation = %q", ev.process.commandInvocation)
	}
	if ev.process.action != actionAllowed {
		t.Fatalf("action = %q, want %q", ev.process.action, actionAllowed)
	}

	want := time.Date(2026, 4, 20, 15, 4, 59, 58553000, time.UTC)
	if !ev.process.eventTime.Equal(want) {
		t.Fatalf("eventTime = %s, want %s", ev.process.eventTime, want)
	}
}

func TestNormalizeAlertBlockedProcess(t *testing.T) {
	t.Parallel()

	ev, ok := normalizeAlert(&pb.Alert{
		UpdatedTime:   "2026-04-20T15:05:43.692697Z",
		NamespaceName: "default",
		Operation:     "Process",
		PodName:       "agent-sample",
		ProcessName:   "/usr/bin/whoami",
		Resource:      "/usr/bin/whoami",
		Action:        "Block",
	}, "default", "agent-sample")
	if !ok {
		t.Fatal("normalizeAlert() filtered blocked process event")
	}
	if ev.process == nil {
		t.Fatal("process event is nil")
	}
	if ev.process.action != actionBlocked {
		t.Fatalf("action = %q, want %q", ev.process.action, actionBlocked)
	}
	if ev.process.source != sourceKubeArmorAlert {
		t.Fatalf("source = %q, want %q", ev.process.source, sourceKubeArmorAlert)
	}
}

func TestNormalizeLogFile(t *testing.T) {
	t.Parallel()

	ev, ok := normalizeLog(&pb.Log{
		UpdatedTime:   "2026-04-20T15:04:59.170356Z",
		NamespaceName: "default",
		Type:          "ContainerLog",
		Operation:     "File",
		PodName:       "agent-sample",
		ProcessName:   "/usr/bin/curl",
		Source:        "/usr/bin/curl -I https://example.com",
		Resource:      "/etc/hosts extra=data",
	}, "default", "agent-sample")
	if !ok {
		t.Fatal("normalizeLog() filtered file event")
	}
	if ev.file == nil {
		t.Fatal("file event is nil")
	}
	if ev.file.filePathAccessed != "/etc/hosts" {
		t.Fatalf("filePathAccessed = %q", ev.file.filePathAccessed)
	}
	if ev.file.process != "/usr/bin/curl" {
		t.Fatalf("process = %q", ev.file.process)
	}
}

func TestNormalizeLogFiltersOtherNamespace(t *testing.T) {
	t.Parallel()

	_, ok := normalizeLog(&pb.Log{
		NamespaceName: "kube-system",
		Type:          "ContainerLog",
		Operation:     "Process",
		ProcessName:   "/usr/bin/id",
	}, "default", "agent-sample")
	if ok {
		t.Fatal("normalizeLog() accepted event from another namespace")
	}
}
