package agent

import (
	_ "embed"
	"text/template"
)

//go:embed prompts/philosophy.md
var agentPhilosophy string

var philosophyTemplate = template.Must(template.New("philosophy").Parse(agentPhilosophy))

type philosophyData struct {
	AgentName string
}
