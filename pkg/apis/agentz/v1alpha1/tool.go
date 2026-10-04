package v1alpha1

// ToolLanguage selects the interpreter without allowing arbitrary commands.
// +kubebuilder:validation:Enum=bash;python;node
type ToolLanguage string

const (
	// ToolLanguageBash executes a shell script with Bash.
	ToolLanguageBash ToolLanguage = "bash"
	// ToolLanguagePython executes a script with Python 3.
	ToolLanguagePython ToolLanguage = "python"
	// ToolLanguageNode executes a JavaScript script with Node.js.
	ToolLanguageNode ToolLanguage = "node"
)

// ToolInputType defines the argument schema exposed to the model.
// +kubebuilder:validation:Enum=string;number;integer;boolean;json
type ToolInputType string

const (
	// ToolInputString accepts text without interpreting it as source code.
	ToolInputString ToolInputType = "string"
	// ToolInputNumber accepts finite numeric values.
	ToolInputNumber ToolInputType = "number"
	// ToolInputInteger accepts whole numeric values.
	ToolInputInteger ToolInputType = "integer"
	// ToolInputBoolean accepts true or false.
	ToolInputBoolean ToolInputType = "boolean"
	// ToolInputJSON accepts nested JSON values for complex arguments.
	ToolInputJSON ToolInputType = "json"
)

// ToolInput describes one named argument passed to the script through JSON stdin.
type ToolInput struct {
	// Name identifies the property in the input JSON object.
	// +kubebuilder:validation:Pattern=`^[a-z][a-z0-9_]*$`
	// +kubebuilder:validation:MaxLength=64
	Name string `json:"name"`
	// Description explains how the model should choose this argument.
	// +kubebuilder:validation:MaxLength=1024
	Description string `json:"description"`
	// Type defines the values accepted before the script starts.
	Type ToolInputType `json:"type"`
	// Required rejects invocations that omit this argument.
	Required bool `json:"required"`
}

// AgentTool stores trusted script source separately from the runtime plugin.
type AgentTool struct {
	// Name is the immutable identifier exposed to the model.
	// +kubebuilder:validation:Pattern=`^[a-z][a-z0-9_]*$`
	// +kubebuilder:validation:MaxLength=64
	Name string `json:"name"`
	// Description explains when the agent should invoke this tool.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=4096
	Description string `json:"description"`
	// Language selects the interpreter for Script.
	Language ToolLanguage `json:"language"`
	// Filename records the original upload name, never an execution path.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=255
	Filename string `json:"filename"`
	// Script preserves the uploaded source exactly, including its newlines.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=65536
	Script string `json:"script"`
	// Inputs define the model's arguments; no inputs produces an empty JSON object.
	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=32
	Inputs []ToolInput `json:"inputs"`
}
