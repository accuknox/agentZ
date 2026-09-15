package observer

import (
	"testing"

	pb "github.com/kubearmor/KubeArmor/protobuf"
)

func TestKubeArmorAlertBlockedProcess(t *testing.T) {
	t.Parallel()

	ev, ok := kubeArmorAlertEvent(&pb.Alert{
		UpdatedTime:   "2026-04-20T15:05:43.692697Z",
		NamespaceName: "default",
		Operation:     "Process",
		PodName:       "agent-sample",
		ProcessName:   "/usr/bin/whoami",
		Resource:      "/usr/bin/whoami",
		Action:        "Block",
	}, "agent-sample")
	if !ok {
		t.Fatal("kubeArmorAlertEvent() filtered blocked process event")
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

func TestKubeArmorLogFile(t *testing.T) {
	t.Parallel()

	ev, ok := kubeArmorLogEvent(&pb.Log{
		UpdatedTime:   "2026-04-20T15:04:59.170356Z",
		NamespaceName: "default",
		Type:          "ContainerLog",
		Operation:     "File",
		PodName:       "agent-sample",
		ProcessName:   "/usr/bin/curl",
		Source:        "/usr/bin/curl -I https://example.com",
		Resource:      "/etc/hosts extra=data",
	}, "agent-sample")
	if !ok {
		t.Fatal("kubeArmorLogEvent() filtered file event")
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

func TestKubeArmorLogTenantNamespace(t *testing.T) {
	t.Parallel()

	ev, ok := kubeArmorLogEvent(&pb.Log{
		NamespaceName: "kube-system",
		Type:          "ContainerLog",
		Operation:     "Process",
		ProcessName:   "/usr/bin/id",
	}, "agent-sample")
	if !ok {
		t.Fatal("kubeArmorLogEvent() filtered event from another namespace")
	}
	if ev.process.tenantNamespace != "kube-system" {
		t.Fatalf("tenantNamespace = %q, want %q", ev.process.tenantNamespace, "kube-system")
	}
}
