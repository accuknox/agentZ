package observer

import (
	"time"

	"github.com/google/uuid"
)

const (
	actionAllowed = "Allowed"
	actionBlocked = "Blocked"
)

const (
	sourceKubeArmorLog   = "kubearmor-log"
	sourceKubeArmorAlert = "kubearmor-alert"
	sourceHubble         = "hubble"
)

type event struct {
	process *processEvent
	file    *fileEvent
	network *networkEvent
}

type processEvent struct {
	sessionID         uuid.UUID
	eventTime         time.Time
	podNamespace      string
	podName           string
	process           string
	parentProcess     string
	commandInvocation string
	action            string
	source            string
}

type fileEvent struct {
	sessionID         uuid.UUID
	eventTime         time.Time
	podNamespace      string
	podName           string
	filePathAccessed  string
	process           string
	commandInvocation string
	action            string
	source            string
}

type networkEvent struct {
	sessionID         uuid.UUID
	eventTime         time.Time
	podNamespace      string
	podName           string
	destinationDomain string
	destinationIP     string
	destinationPort   int64
	protocol          string
	action            string
	source            string
}

type batch struct {
	processes []processEvent
	files     []fileEvent
	networks  []networkEvent
}

func (b batch) empty() bool {
	return len(b.processes) == 0 && len(b.files) == 0 && len(b.networks) == 0
}
