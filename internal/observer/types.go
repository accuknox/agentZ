package observer

import (
	"time"

	observerdb "github.com/accuknox/agentz/internal/observer/db"
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
	process   *processEvent
	file      *fileEvent
	network   *networkEvent
	trace     *traceSpanEvent
	app       *observerdb.InsertAppOperationParams
	guardrail *guardrailEvent
}

type processEvent struct {
	tenantNamespace   string
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
	tenantNamespace   string
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
	tenantNamespace   string
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
	tenantNamespace    string
	agentName          string
	sessionID          string
	traceID            []byte
	spanID             []byte
	parentSpanID       []byte
	startTime          time.Time
	endTime            time.Time
	durationNS         int64
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
	mcpToolCall        *mcpToolCallEvent
}

type traceSpanPayload struct {
	inputMessages  []byte
	outputMessages []byte
	toolArguments  []byte
	toolResult     []byte
	toolError      []byte
}

type mcpToolCallEvent struct {
	agentName         string
	traceID           []byte
	spanID            []byte
	startTime         time.Time
	endTime           time.Time
	durationNS        int64
	mcpConnectionName string
	toolName          string
	sessionID         string
	failed            bool
}

type batch struct {
	processes  []processEvent
	files      []fileEvent
	networks   []networkEvent
	traces     []traceSpanEvent
	apps       []observerdb.InsertAppOperationParams
	guardrails []guardrailEvent
}

func (b *batch) add(ev event) {
	if ev.process != nil {
		b.processes = append(b.processes, *ev.process)
	}
	if ev.file != nil {
		b.files = append(b.files, *ev.file)
	}
	if ev.network != nil {
		b.networks = append(b.networks, *ev.network)
	}
	if ev.trace != nil {
		b.traces = append(b.traces, *ev.trace)
	}
	if ev.app != nil {
		b.apps = append(b.apps, *ev.app)
	}
	if ev.guardrail != nil {
		b.guardrails = append(b.guardrails, *ev.guardrail)
	}
}

func (b *batch) count() int {
	return len(b.processes) + len(b.files) + len(b.networks) + len(b.traces) + len(b.apps) + len(b.guardrails)
}

// split partitions slice headers without copying captured payloads.
func (b batch) split(n int) (batch, batch) {
	var left batch
	k := min(n, len(b.processes))
	left.processes = b.processes[:k:k]
	b.processes = b.processes[k:]
	n -= k
	k = min(n, len(b.files))
	left.files = b.files[:k:k]
	b.files = b.files[k:]
	n -= k
	k = min(n, len(b.networks))
	left.networks = b.networks[:k:k]
	b.networks = b.networks[k:]
	n -= k
	k = min(n, len(b.traces))
	left.traces = b.traces[:k:k]
	b.traces = b.traces[k:]
	n -= k
	k = min(n, len(b.apps))
	left.apps = b.apps[:k:k]
	b.apps = b.apps[k:]
	n -= k
	k = min(n, len(b.guardrails))
	left.guardrails = b.guardrails[:k:k]
	b.guardrails = b.guardrails[k:]
	return left, b
}

// release drops payload references in a completed partition while its siblings
// may still retain the shared backing arrays.
func (b batch) release() {
	clear(b.processes)
	clear(b.files)
	clear(b.networks)
	clear(b.traces)
	clear(b.apps)
	clear(b.guardrails)
}
