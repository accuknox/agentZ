package observer

import (
	"time"
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
	trace   *traceSpanEvent
}

type processEvent struct {
	agentName         string
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
	agentName         string
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
	agentName         string
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

type traceSpanEvent struct {
	agentName          string
	sessionID          string
	traceID            []byte
	spanID             []byte
	parentSpanID       []byte
	startTime          time.Time
	endTime            time.Time
	durationNS         int64
	durationMS         float64
	name               string
	spanClass          string
	operationName      string
	kind               string
	statusCode         string
	errorType          string
	errorMessage       string
	model              string
	toolName           string
	inputTokens        int64
	outputTokens       int64
	cachedInputTokens  int64
	cachedWriteTokens  int64
	costUSD            float64
	llmFinishReason    string
	resourceAttributes []byte
	spanAttributes     []byte
	payload            traceSpanPayload
}

type traceSpanPayload struct {
	inputMessages  []byte
	outputMessages []byte
	toolArguments  []byte
	toolResult     []byte
}

type batch struct {
	processes []processEvent
	files     []fileEvent
	networks  []networkEvent
	traces    []traceSpanEvent
}

func (b batch) empty() bool {
	return len(b.processes) == 0 &&
		len(b.files) == 0 &&
		len(b.networks) == 0 &&
		len(b.traces) == 0
}
