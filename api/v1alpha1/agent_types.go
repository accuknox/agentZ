/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConditionType identifies a high-level Agent condition.
type ConditionType string

// String returns the Kubernetes condition type string.
func (c ConditionType) String() string {
	return string(c)
}

const (
	// ConditionTypeReady indicates that the Agent service is ready.
	ConditionTypeReady ConditionType = "Ready"
	// ConditionTypeProgressing indicates that the Agent is being reconciled.
	ConditionTypeProgressing ConditionType = "Progressing"
	// ConditionTypeDegraded indicates that Agent reconciliation failed.
	ConditionTypeDegraded ConditionType = "Degraded"
)

const (
	// ReasonConfigInvalid indicates the Agent spec cannot produce a runtime.
	ReasonConfigInvalid = "ConfigInvalid"
	// ReasonDeploymentCreating indicates the deployment is being created.
	ReasonDeploymentCreating = "DeploymentCreating"
	// ReasonDeploymentUpdating indicates the deployment is rolling out.
	ReasonDeploymentUpdating = "DeploymentUpdating"
	// ReasonDeploymentReady indicates the deployment has ready replicas.
	ReasonDeploymentReady = "DeploymentReady"
	// ReasonDeploymentNotReady indicates the deployment is not ready yet.
	ReasonDeploymentNotReady = "DeploymentNotReady"
	// ReasonReconcileFailed indicates an unexpected reconcile failure.
	ReasonReconcileFailed = "ReconcileFailed"
)

// AgentSpec defines the desired state of Agent.
type AgentSpec struct {
	// Image is the container image used for the Agent runtime.
	// +optional
	Image string `json:"image,omitempty"`

	// ImagePullPolicy defines when Kubernetes pulls the Agent image.
	// +kubebuilder:default=IfNotPresent
	// +optional
	ImagePullPolicy corev1.PullPolicy `json:"imagePullPolicy,omitempty"`

	// Resources defines compute resources allocated to the Agent pod.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// Env defines environment variables injected into the Agent pod.
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// Server defines the agent gRPC server settings.
	// +required
	Server ServerConfig `json:"server"`

	// Agent defines identity and prompt settings for the runtime.
	// +optional
	Agent AgentConfig `json:"agent,omitempty"`

	// Model defines the primary chat model.
	// +required
	Model ModelConfig `json:"model"`

	// SummaryModel defines the model used for session summarization.
	// +optional
	SummaryModel SummaryModelConfig `json:"summaryModel,omitempty"`

	// Memory configures in-process memory and memory tools.
	// +optional
	Memory MemoryConfig `json:"memory,omitempty"`

	// Session configures persisted session behavior.
	// +required
	Session SessionConfig `json:"session"`

	// Telemetry configures agent observability export.
	// +optional
	Telemetry TelemetryConfig `json:"telemetry,omitempty"`

	// Tools configures optional runtime tools.
	// +optional
	Tools ToolsConfig `json:"tools,omitempty"`
}

// ServerConfig defines the agent gRPC server settings.
type ServerConfig struct {
	// Address is the TCP listen address for the agent server.
	// +required
	Address string `json:"address"`

	// GracefulShutdownTimeout is the maximum graceful shutdown period.
	// +optional
	GracefulShutdownTimeout metav1.Duration `json:"gracefulShutdownTimeout"`
}

// AgentConfig defines agent identity and prompt settings.
type AgentConfig struct {
	// Instruction is high-level task guidance appended to the prompt.
	// +optional
	Instruction string `json:"instruction,omitempty"`

	// SystemPrompt is global instruction applied to every turn.
	// +optional
	SystemPrompt string `json:"systemPrompt,omitempty"`

	// AddSessionSummary injects the latest persisted summary into context.
	// +optional
	AddSessionSummary *bool `json:"addSessionSummary,omitempty"`

	// EnableContextCompaction enables summary-backed context compaction.
	// +optional
	EnableContextCompaction *bool `json:"enableContextCompaction,omitempty"`

	// ContextCompactionThresholdRatio triggers compaction by context ratio.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1
	// +optional
	ContextCompactionThresholdRatio float64 `json:"contextCompactionThresholdRatio,omitempty"`

	// ContextCompactionToolResultMaxRatio compacts old tool results.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1
	// +optional
	ContextCompactionToolResultMaxRatio float64 `json:"contextCompactionToolResultMaxRatio,omitempty"`

	// ContextCompactionKeepRecentRequests preserves recent requests in full.
	// +kubebuilder:validation:Minimum=0
	// +optional
	ContextCompactionKeepRecentRequests int `json:"contextCompactionKeepRecentRequests,omitempty"`

	// ContextCompactionOversizedToolResultMaxRatio truncates large results.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1
	// +optional
	ContextCompactionOversizedToolResultMaxRatio float64 `json:"contextCompactionOversizedToolResultMaxRatio,omitempty"`

	// MaxHistoryRuns caps raw history when summaries are not used.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxHistoryRuns int `json:"maxHistoryRuns,omitempty"`
}

// ModelConfig defines LLM backend and generation settings.
type ModelConfig struct {
	// Name is the primary model identifier.
	// +required
	Name string `json:"name"`

	// BaseURL is an optional OpenAI-compatible provider URL.
	// +optional
	BaseURL string `json:"baseURL,omitempty"`

	// ContextWindow is an explicit model context window.
	// +kubebuilder:validation:Minimum=0
	// +optional
	ContextWindow int `json:"contextWindow,omitempty"`

	// Temperature configures model sampling.
	// +optional
	Temperature float64 `json:"temperature,omitempty"`

	// MaxTokens caps model output tokens.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxTokens int `json:"maxTokens,omitempty"`

	// Stream enables streamed model responses.
	// +optional
	Stream bool `json:"stream,omitempty"`

	// ThinkingEnabled requests native thinking mode for providers that expose
	// it through OpenAI-compatible APIs.
	// +optional
	ThinkingEnabled *bool `json:"thinkingEnabled,omitempty"`

	// ThinkingTokens requests the provider's thinking token budget when
	// thinking mode is enabled.
	// +kubebuilder:validation:Minimum=0
	// +optional
	ThinkingTokens int `json:"thinkingTokens,omitempty"`
}

// SummaryModelConfig defines summarization model settings.
type SummaryModelConfig struct {
	// Name is the summarization model identifier.
	// +optional
	Name string `json:"name,omitempty"`

	// BaseURL is an optional OpenAI-compatible provider URL.
	// +optional
	BaseURL string `json:"baseURL,omitempty"`

	// ContextWindow is an explicit summarizer model context window.
	// +kubebuilder:validation:Minimum=0
	// +optional
	ContextWindow int `json:"contextWindow,omitempty"`

	// Temperature configures summarization sampling.
	// +optional
	Temperature float64 `json:"temperature,omitempty"`

	// MaxTokens caps summarization output tokens.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxTokens int `json:"maxTokens,omitempty"`
}

// MemoryConfig configures in-process memory and memory tool exposure.
type MemoryConfig struct {
	// Enabled turns on in-process memory.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// Limit caps retained memory entries.
	// +kubebuilder:validation:Minimum=0
	// +optional
	Limit int `json:"limit,omitempty"`

	// Tools controls memory tool exposure.
	// +optional
	Tools MemoryToolsConfig `json:"tools,omitempty"`
}

// MemoryToolsConfig controls which memory tools are exposed.
type MemoryToolsConfig struct {
	// Search exposes memory search.
	// +optional
	Search bool `json:"search,omitempty"`
	// Load exposes memory loading.
	// +optional
	Load bool `json:"load,omitempty"`
	// Add exposes memory creation.
	// +optional
	Add bool `json:"add,omitempty"`
	// Update exposes memory updates.
	// +optional
	Update bool `json:"update,omitempty"`
	// Delete exposes memory deletion.
	// +optional
	Delete bool `json:"delete,omitempty"`
	// Clear exposes memory clearing.
	// +optional
	Clear bool `json:"clear,omitempty"`
}

// SessionConfig defines external session service connection settings.
type SessionConfig struct {
	// ID is the immutable UUIDv4 session identifier.
	// +required
	ID string `json:"id"`

	// Enabled uses the external gRPC session service when true.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// Target is the external session service gRPC target.
	// +optional
	Target string `json:"target,omitempty"`

	// Insecure uses insecure gRPC transport.
	// +optional
	Insecure bool `json:"insecure,omitempty"`

	// TimeoutMs is the external session RPC timeout in milliseconds.
	// +kubebuilder:validation:Minimum=0
	// +optional
	TimeoutMs int `json:"timeoutMs,omitempty"`

	// Summary defines session summarization behavior.
	// +optional
	Summary SessionSummaryConfig `json:"summary,omitempty"`
}

// SessionSummaryConfig defines how session summaries are produced.
type SessionSummaryConfig struct {
	// Enabled turns session summary generation on or off.
	// +optional
	Enabled *bool `json:"enabled,omitempty"`

	// Mode selects auto or manual summary thresholds.
	// +kubebuilder:validation:Enum=auto;manual
	// +optional
	Mode string `json:"mode,omitempty"`

	// EventThreshold summarizes after this many events in manual mode.
	// +kubebuilder:validation:Minimum=0
	// +optional
	EventThreshold int `json:"eventThreshold,omitempty"`

	// TokenThreshold summarizes after this many tokens in manual mode.
	// +kubebuilder:validation:Minimum=0
	// +optional
	TokenThreshold int `json:"tokenThreshold,omitempty"`

	// IdleThreshold summarizes after this idle duration in manual mode.
	// +optional
	IdleThreshold string `json:"idleThreshold,omitempty"`

	// MaxWords is best-effort guidance for summary length.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxWords int `json:"maxWords,omitempty"`

	// ApproxRunesPerToken hints token estimation.
	// +kubebuilder:validation:Minimum=0
	// +optional
	ApproxRunesPerToken float64 `json:"approxRunesPerToken,omitempty"`
}

// TelemetryConfig defines agent telemetry export settings.
type TelemetryConfig struct {
	// Enabled turns on OpenTelemetry trace export.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// TraceEndpoint is the OTLP/gRPC trace endpoint in host:port form.
	// +optional
	TraceEndpoint string `json:"traceEndpoint,omitempty"`
}

// ToolsConfig defines tool and toolset configuration.
type ToolsConfig struct {
	// HostExec configures host command execution tools.
	// +optional
	HostExec HostExecConfig `json:"hostExec,omitempty"`

	// WebFetch configures HTTP fetch tools.
	// +optional
	WebFetch WebFetchConfig `json:"webFetch,omitempty"`

	// File configures filesystem tools.
	// +optional
	File FileConfig `json:"file,omitempty"`

	// Arxiv configures arXiv search tools.
	// +optional
	Arxiv ArxivConfig `json:"arxiv,omitempty"`

	// OpenAPI configures OpenAPI-backed toolsets.
	// +optional
	OpenAPI []OpenAPIConfig `json:"openAPI,omitempty"`

	// MCP configures MCP toolsets.
	// +optional
	MCP []MCPConfig `json:"mcp,omitempty"`
}

// HostExecConfig defines host command execution limits.
type HostExecConfig struct {
	// Enabled turns host execution tools on.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// BaseDir is the working-directory root for commands.
	// +optional
	BaseDir string `json:"baseDir,omitempty"`

	// BaseEnv is extra environment for commands.
	// +optional
	BaseEnv map[string]string `json:"baseEnv,omitempty"`
}

// WebFetchConfig defines fetch policy and response size limits.
type WebFetchConfig struct {
	// Enabled turns web fetch tools on.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// TimeoutMs is the per-request fetch timeout.
	// +kubebuilder:validation:Minimum=0
	// +optional
	TimeoutMs int `json:"timeoutMs,omitempty"`

	// MaxContentLength caps one fetched response.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxContentLength int `json:"maxContentLength,omitempty"`

	// MaxTotalContentLength caps all fetched responses per tool call.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxTotalContentLength int `json:"maxTotalContentLength,omitempty"`
}

// FileConfig defines file tool access boundaries.
type FileConfig struct {
	// Enabled turns file tools on.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// BaseDir is the filesystem root exposed to file tools.
	// +optional
	BaseDir string `json:"baseDir,omitempty"`
}

// ArxivConfig defines arXiv client behavior.
type ArxivConfig struct {
	// Enabled turns arXiv search on.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// BaseURL is the arXiv API base URL.
	// +optional
	BaseURL string `json:"baseURL,omitempty"`

	// PageSize controls arXiv result page size.
	// +kubebuilder:validation:Minimum=0
	// +optional
	PageSize int `json:"pageSize,omitempty"`

	// DelayMS delays arXiv retry/page requests.
	// +kubebuilder:validation:Minimum=0
	// +optional
	DelayMS int `json:"delayMs,omitempty"`

	// NumRetries caps arXiv retries.
	// +kubebuilder:validation:Minimum=0
	// +optional
	NumRetries int `json:"numRetries,omitempty"`
}

// OpenAPIConfig defines one OpenAPI-backed toolset entry.
type OpenAPIConfig struct {
	// Enabled turns this OpenAPI toolset on.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// Name is the toolset name.
	// +optional
	Name string `json:"name,omitempty"`

	// SpecFile is a local OpenAPI specification path.
	// +optional
	SpecFile string `json:"specFile,omitempty"`

	// SpecURL is a remote OpenAPI specification URL.
	// +optional
	SpecURL string `json:"specUrl,omitempty"`
}

// MCPConfig defines one MCP toolset connection.
type MCPConfig struct {
	// Enabled turns this MCP connection on.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// Name is the MCP toolset name.
	// +optional
	Name string `json:"name,omitempty"`

	// Transport selects the MCP transport.
	// +optional
	Transport string `json:"transport,omitempty"`

	// ServerURL is the remote MCP server URL.
	// +optional
	ServerURL string `json:"serverUrl,omitempty"`

	// Command is the local MCP server command.
	// +optional
	Command string `json:"command,omitempty"`

	// Args are local MCP server command arguments.
	// +optional
	Args []string `json:"args,omitempty"`

	// Headers are remote MCP request headers.
	// +optional
	Headers map[string]string `json:"headers,omitempty"`

	// TimeoutMs is the MCP request timeout.
	// +kubebuilder:validation:Minimum=0
	// +optional
	TimeoutMs int `json:"timeoutMs,omitempty"`

	// Reconnect enables MCP reconnect attempts.
	// +optional
	Reconnect bool `json:"reconnect,omitempty"`

	// ReconnectMaxAttempt caps MCP reconnect attempts.
	// +kubebuilder:validation:Minimum=0
	// +optional
	ReconnectMaxAttempt int `json:"reconnectMaxAttempts,omitempty"`
}

// AgentStatus defines the observed state of Agent.
type AgentStatus struct {
	// Conditions represent the current state of the Agent resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// ServiceName is the service exposing the Agent API.
	// +optional
	ServiceName string `json:"serviceName,omitempty"`

	// URL is the in-cluster URL of the Agent API service.
	// +optional
	URL string `json:"url,omitempty"`

	// ConfigMapName is the ConfigMap mounted into the Agent pod.
	// +optional
	ConfigMapName string `json:"configMapName,omitempty"`

	// ObservedSessionID is the session id applied by the controller.
	// +optional
	ObservedSessionID string `json:"observedSessionID,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// SetCondition adds or updates a condition in the status.
func (s *AgentStatus) SetCondition(cond metav1.Condition) {
	cond.LastTransitionTime = metav1.Now()
	for i, cur := range s.Conditions {
		if cur.Type != cond.Type {
			continue
		}
		if cur.Status == cond.Status && cur.Reason == cond.Reason &&
			cur.Message == cond.Message &&
			cur.ObservedGeneration == cond.ObservedGeneration {
			cond.LastTransitionTime = cur.LastTransitionTime
		}
		s.Conditions[i] = cond
		return
	}
	s.Conditions = append(s.Conditions, cond)
}

// +genclient
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=agent
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`,description="Whether the Agent is ready"
// +kubebuilder:printcolumn:name="Session",type=string,JSONPath=`.spec.session.id`,description="Agent session identifier"
// +kubebuilder:printcolumn:name="Service",type=string,JSONPath=`.status.serviceName`,description="Service exposing the Agent API"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Agent"

// Agent is the Schema for the agents API.
type Agent struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Agent.
	// +required
	Spec AgentSpec `json:"spec"`

	// status defines the observed state of Agent.
	// +optional
	Status AgentStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AgentList contains a list of Agent.
type AgentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Agent `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Agent{}, &AgentList{})
}
