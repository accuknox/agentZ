package tool

import (
	"strconv"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/util/validation/field"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type invalidToolCase struct {
	name string
	edit func(*agentzv1alpha1.AgentTool)
}

// TestValidate exercises API and admission checks for uploaded definitions.
func TestValidate(t *testing.T) {
	t.Parallel()
	valid := agentzv1alpha1.AgentTool{
		Name: "lookup", Description: "Look up a record", Filename: "lookup.py",
		Language: agentzv1alpha1.ToolLanguagePython, Script: "print('ok')\r\n",
		Inputs: []agentzv1alpha1.ToolInput{{Name: "id", Type: agentzv1alpha1.ToolInputString}},
	}
	p := field.NewPath("tools")
	if errs := Validate([]agentzv1alpha1.AgentTool{valid}, p); len(errs) != 0 {
		t.Fatal(errs)
	}
	cases := []invalidToolCase{
		{"name", func(t *agentzv1alpha1.AgentTool) { t.Name = "../tool" }},
		{"builtin", func(t *agentzv1alpha1.AgentTool) { t.Name = "bash" }},
		{"platform", func(t *agentzv1alpha1.AgentTool) { t.Name = "memory" }},
		{"MCP", func(t *agentzv1alpha1.AgentTool) { t.Name = "gateway_future_tool" }},
		{"blank description", func(t *agentzv1alpha1.AgentTool) { t.Description = " " }},
		{"language", func(t *agentzv1alpha1.AgentTool) { t.Language = "ruby" }},
		{"extension", func(t *agentzv1alpha1.AgentTool) { t.Filename = "lookup.js" }},
		{"path", func(t *agentzv1alpha1.AgentTool) { t.Filename = "../lookup.py" }},
		{"blank source", func(t *agentzv1alpha1.AgentTool) { t.Script = "\n " }},
		{"binary source", func(t *agentzv1alpha1.AgentTool) { t.Script = "\xff" }},
		{"NUL", func(t *agentzv1alpha1.AgentTool) { t.Script = "print('ok')\x00" }},
		{"source size", func(t *agentzv1alpha1.AgentTool) { t.Script = strings.Repeat("é", 32769) }},
		{"input name", func(t *agentzv1alpha1.AgentTool) { t.Inputs[0].Name = "bad-name" }},
		{"input type", func(t *agentzv1alpha1.AgentTool) { t.Inputs[0].Type = "array" }},
		{"missing inputs", func(t *agentzv1alpha1.AgentTool) { t.Inputs = nil }},
		{"duplicate inputs", func(t *agentzv1alpha1.AgentTool) { t.Inputs = append(t.Inputs, t.Inputs[0]) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			candidate := valid.DeepCopy()
			tc.edit(candidate)
			if errs := Validate([]agentzv1alpha1.AgentTool{*candidate}, p); len(errs) == 0 {
				t.Fatal("invalid definition accepted")
			}
		})
	}
	if errs := Validate([]agentzv1alpha1.AgentTool{valid, valid}, p); len(errs) == 0 {
		t.Fatal("duplicate tool accepted")
	}
	tools := make([]agentzv1alpha1.AgentTool, 33)
	if errs := Validate(tools, p); len(errs) == 0 {
		t.Fatal("too many tools accepted")
	}
	large := valid
	large.Script = strings.Repeat("\\", 64*1024)
	if errs := Validate([]agentzv1alpha1.AgentTool{large}, p); len(errs) != 0 {
		t.Fatal(errs)
	}
	tools = make([]agentzv1alpha1.AgentTool, 3)
	for i := range tools {
		tools[i] = large
		tools[i].Name = "tool_" + strconv.Itoa(i)
	}
	if errs := Validate(tools, p); len(errs) == 0 {
		t.Fatal("oversized combined manifest accepted")
	}
}
