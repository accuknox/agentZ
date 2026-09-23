package observer

import (
	"context"
	"fmt"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/accuknox/agentz/internal/host"
	"github.com/jackc/pgx/v5/pgxpool"
	pb "github.com/kubearmor/KubeArmor/protobuf"
	"google.golang.org/protobuf/encoding/protojson"
)

// NativeSecurityEvent stores a host event under its authenticated assignment.
// Payload namespace, pod, labels and owner fields never determine attribution.
func NativeSecurityEvent(ctx context.Context, pool *pgxpool.Pool, namespace, agent string, payload host.SecurityEvent) error {
	if namespace == "" || agent == "" {
		return fmt.Errorf("native event requires an agent assignment")
	}
	ev, err := nativeSecurityEvent(namespace, agent, payload)
	if err != nil {
		return err
	}
	var collected collector
	collected.add(ev)
	return (&dbStore{pool: pool}).insertBatch(ctx, collected.flush())
}

func nativeSecurityEvent(namespace, agent string, payload host.SecurityEvent) (event, error) {
	if len(payload.Event) > 64*1024 {
		return event{}, fmt.Errorf("native event exceeds size limit")
	}
	var log pb.Log
	source := sourceKubeArmorLog
	action := actionAllowed
	switch payload.Kind {
	case "log":
		if err := protojson.Unmarshal(payload.Event, &log); err != nil {
			return event{}, err
		}
		if log.Type != "HostLog" || log.ContainerID != "" {
			return event{}, fmt.Errorf("native log must be a host event")
		}
		if log.Result != "Passed" {
			action = actionBlocked
		}
	case "alert":
		var alert pb.Alert
		if err := protojson.Unmarshal(payload.Event, &alert); err != nil {
			return event{}, err
		}
		if alert.Type != "MatchedHostPolicy" || alert.ContainerID != "" {
			return event{}, fmt.Errorf("native alert must be a host policy event")
		}
		log = pb.Log{
			Timestamp: alert.Timestamp, UpdatedTime: alert.UpdatedTime,
			ParentProcessName: alert.ParentProcessName, ProcessName: alert.ProcessName,
			Source: alert.Source, Operation: alert.Operation, Resource: alert.Resource, Result: alert.Result,
		}
		source = sourceKubeArmorAlert
		action = kubeArmorAction(alert.Action)
		if alert.Result != "Passed" {
			action = actionBlocked
		}
	default:
		return event{}, fmt.Errorf("unknown native event kind")
	}
	if filepath.Base(log.ParentProcessName) != "opencode" {
		return event{}, fmt.Errorf("event parent is not OpenCode")
	}
	// Reuse the existing process/file conversion after binding trusted tenancy.
	log.Type = "ContainerLog"
	log.NamespaceName = namespace
	log.PodName = ""
	ev, ok := kubeArmorLogEvent(&log, agent)
	if ev.process != nil {
		ev.process.action = action
		ev.process.source = source
	}
	if ev.file != nil {
		ev.file.action = action
		ev.file.source = source
	}
	if ok {
		return ev, nil
	}
	if log.Operation != "Network" {
		return event{}, fmt.Errorf("unsupported native operation %q", log.Operation)
	}
	network := &networkEvent{
		tenantNamespace: namespace, agentName: agent,
		eventTime:    eventTime(log.UpdatedTime, log.Timestamp),
		podNamespace: namespace, action: action, source: source,
	}
	for _, field := range strings.Fields(log.Resource) {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		switch key {
		case "remoteip", "sin_addr", "sin6_addr":
			address, err := netip.ParseAddr(value)
			if err != nil {
				return event{}, fmt.Errorf("invalid sensor destination IP")
			}
			network.destinationIP = address.String()
		case "port", "sin_port", "sin6_port":
			port, err := strconv.ParseUint(value, 10, 16)
			if err != nil {
				return event{}, fmt.Errorf("invalid sensor destination port")
			}
			network.destinationPort = int64(port)
		case "protocol":
			network.protocol = strings.ToUpper(value)
		}
	}
	return event{network: network}, nil
}
