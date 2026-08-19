package agent

import (
	_ "embed"
	"text/template"
)

//go:embed prompts/philosophy.md
var agentPhilosophy string

// Credits: https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md
//
//go:embed prompts/unslop.md
var agentUnslop string

var philosophyTemplate = template.Must(template.New("philosophy").Parse(agentPhilosophy))

type philosophyData struct {
	AgentName string
}
