// Package tool validates uploaded tool definitions at API and admission boundaries.
package tool

import (
	"encoding/json"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"k8s.io/apimachinery/pkg/util/validation/field"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// Validate rejects definitions that cannot safely register alongside runtime tools.
// Both the gateway and webhook use it so direct Kubernetes writes have the same contract.
func Validate(tools []agentzv1alpha1.AgentTool, p *field.Path) field.ErrorList {
	var errs field.ErrorList
	if len(tools) > 32 {
		errs = append(errs, field.TooMany(p, len(tools), 32))
	}
	raw, err := json.Marshal(tools)
	if err != nil {
		return append(errs, field.InternalError(p, err))
	}
	if len(raw) > 256*1024 {
		errs = append(errs, field.Forbidden(p, "combined tool definitions must not exceed 256 KiB"))
	}
	names := make(map[string]bool, len(tools))
	for i, t := range tools {
		at := p.Index(i)
		if !namePattern.MatchString(t.Name) {
			errs = append(errs, field.Invalid(at.Child("name"), t.Name, "use at most 64 lowercase letters, digits or underscores, starting with a letter"))
		}
		if names[t.Name] {
			errs = append(errs, field.Duplicate(at.Child("name"), t.Name))
		}
		names[t.Name] = true
		// OpenCode permits overriding built-ins. Uploaded tools must not change
		// platform behavior or impersonate gateway MCP tools, including future ones.
		reserved := []string{
			"bash", "shell", "read", "write", "edit", "glob", "grep", "task",
			"webfetch", "websearch", "todowrite", "question", "lsp", "apply_patch",
			"plan_enter", "plan_exit", "invalid", "execute", "skill", "list_skills",
			"analyze_file", "memory", "journal", "create_workflow", "get_workflow",
			"list_workflows", "delete_workflows", "create_workflow_schedule",
			"update_workflow_schedule", "delete_workflow_schedule",
			"list_workflow_schedules", "set_workflowrun_status", "create_dashboard",
			"get_dashboard", "list_dashboards", "delete_dashboard", "publish_dashboard_data",
			"list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
		}
		if slices.Contains(reserved, t.Name) || strings.HasPrefix(t.Name, "gateway_") {
			errs = append(errs, field.Forbidden(at.Child("name"), "reserved runtime tool name"))
		}
		if strings.TrimSpace(t.Description) == "" || utf8.RuneCountInString(t.Description) > 4096 {
			errs = append(errs, field.Invalid(at.Child("description"), "", "provide a description of at most 4096 characters"))
		}
		ext := ""
		switch t.Language {
		case agentzv1alpha1.ToolLanguageBash:
			ext = ".sh"
		case agentzv1alpha1.ToolLanguagePython:
			ext = ".py"
		case agentzv1alpha1.ToolLanguageNode:
			ext = ".js"
		default:
			errs = append(errs, field.NotSupported(at.Child("language"), t.Language, []string{"bash", "python", "node"}))
		}
		badFile := t.Filename == "" || len(t.Filename) > 255 ||
			path.Base(t.Filename) != t.Filename || strings.ContainsAny(t.Filename, "\\\x00\r\n") ||
			strings.ToLower(path.Ext(t.Filename)) != ext
		if badFile {
			errs = append(errs, field.Invalid(at.Child("filename"), t.Filename, "upload a .sh, .py or .js filename matching the language"))
		}
		if !utf8.ValidString(t.Script) || strings.ContainsRune(t.Script, '\x00') || strings.TrimSpace(t.Script) == "" {
			errs = append(errs, field.Invalid(at.Child("script"), "", "upload a nonempty UTF-8 script without NUL bytes"))
		}
		if len(t.Script) > 64*1024 {
			errs = append(errs, field.Forbidden(at.Child("script"), "script must not exceed 64 KiB"))
		}
		if t.Inputs == nil {
			errs = append(errs, field.Required(at.Child("inputs"), "provide an array; use an empty array for tools without inputs"))
		}
		if len(t.Inputs) > 32 {
			errs = append(errs, field.TooMany(at.Child("inputs"), len(t.Inputs), 32))
		}
		inputs := make(map[string]bool, len(t.Inputs))
		for j, input := range t.Inputs {
			ip := at.Child("inputs").Index(j)
			if !namePattern.MatchString(input.Name) {
				errs = append(errs, field.Invalid(ip.Child("name"), input.Name, "use at most 64 lowercase letters, digits or underscores, starting with a letter"))
			}
			if inputs[input.Name] {
				errs = append(errs, field.Duplicate(ip.Child("name"), input.Name))
			}
			inputs[input.Name] = true
			if utf8.RuneCountInString(input.Description) > 1024 {
				errs = append(errs, field.TooLong(ip.Child("description"), "", 1024))
			}
			switch input.Type {
			case agentzv1alpha1.ToolInputString, agentzv1alpha1.ToolInputNumber,
				agentzv1alpha1.ToolInputInteger, agentzv1alpha1.ToolInputBoolean, agentzv1alpha1.ToolInputJSON:
			default:
				errs = append(errs, field.NotSupported(ip.Child("type"), input.Type, []string{"string", "number", "integer", "boolean", "json"}))
			}
		}
	}
	return errs
}
