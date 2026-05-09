package observer

import (
	"strings"
	"time"

	pb "github.com/kubearmor/KubeArmor/protobuf"
)

func normalizeLog(item *pb.Log, namespace, agentName string) (event, bool) {
	if item == nil {
		return event{}, false
	}
	if item.GetNamespaceName() != namespace || item.GetType() != "ContainerLog" {
		return event{}, false
	}

	ts := eventTime(item.GetUpdatedTime(), item.GetTimestamp())
	switch item.GetOperation() {
	case "Process":
		process := normalizeProcessName(item.GetProcessName(), item.GetResource())
		if process == "" {
			return event{}, false
		}
		return event{process: &processEvent{
			agentName:         agentName,
			eventTime:         ts,
			podNamespace:      item.GetNamespaceName(),
			podName:           item.GetPodName(),
			process:           process,
			parentProcess:     item.GetParentProcessName(),
			commandInvocation: normalizeCommand(item.GetResource(), process),
			action:            actionAllowed,
			source:            sourceKubeArmorLog,
		}}, true
	case "File":
		path := firstToken(item.GetResource())
		process := normalizeCommand(item.GetProcessName(), firstToken(item.GetSource()))
		if path == "" || process == "" {
			return event{}, false
		}
		return event{file: &fileEvent{
			agentName:         agentName,
			eventTime:         ts,
			podNamespace:      item.GetNamespaceName(),
			podName:           item.GetPodName(),
			filePathAccessed:  path,
			process:           process,
			commandInvocation: normalizeCommand(item.GetSource(), process),
			action:            actionAllowed,
			source:            sourceKubeArmorLog,
		}}, true
	default:
		return event{}, false
	}
}

func normalizeAlert(item *pb.Alert, namespace, agentName string) (event, bool) {
	if item == nil || item.GetNamespaceName() != namespace {
		return event{}, false
	}

	ts := eventTime(item.GetUpdatedTime(), item.GetTimestamp())
	action := normalizeAction(item.GetAction())
	switch item.GetOperation() {
	case "Process":
		process := normalizeProcessName(item.GetProcessName(), item.GetResource())
		if process == "" {
			return event{}, false
		}
		return event{process: &processEvent{
			agentName:         agentName,
			eventTime:         ts,
			podNamespace:      item.GetNamespaceName(),
			podName:           item.GetPodName(),
			process:           process,
			parentProcess:     item.GetParentProcessName(),
			commandInvocation: normalizeCommand(item.GetResource(), process),
			action:            action,
			source:            sourceKubeArmorAlert,
		}}, true
	case "File":
		path := firstToken(item.GetResource())
		process := normalizeCommand(item.GetProcessName(), firstToken(item.GetSource()))
		if path == "" || process == "" {
			return event{}, false
		}
		return event{file: &fileEvent{
			agentName:         agentName,
			eventTime:         ts,
			podNamespace:      item.GetNamespaceName(),
			podName:           item.GetPodName(),
			filePathAccessed:  path,
			process:           process,
			commandInvocation: normalizeCommand(item.GetSource(), process),
			action:            action,
			source:            sourceKubeArmorAlert,
		}}, true
	default:
		return event{}, false
	}
}

func normalizeAction(action string) string {
	if strings.Contains(action, "Block") {
		return actionBlocked
	}
	return actionAllowed
}

func parseLabels(raw string) map[string]string {
	labels := map[string]string{}
	for item := range strings.SplitSeq(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" {
			continue
		}
		labels[key] = value
	}
	return labels
}

func eventTime(updated string, unix int64) time.Time {
	ts, err := time.Parse(time.RFC3339Nano, updated)
	if err == nil {
		return ts.UTC()
	}
	if unix > 0 {
		return time.Unix(unix, 0).UTC()
	}
	return time.Now().UTC()
}

func normalizeProcessName(processName, resource string) string {
	if processName != "" {
		return processName
	}
	return firstToken(resource)
}

func normalizeCommand(primary, fallback string) string {
	primary = strings.TrimSpace(primary)
	if primary != "" {
		return primary
	}
	return fallback
}

func firstToken(raw string) string {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
