// Package guardrails resolves and compiles the complete policy for an authenticated inference context.
package guardrails

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"regexp/syntax"
	"slices"
	"strings"
	"unicode/utf8"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/scope"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ResolvedCheck identifies one check and its immutable connection configuration.
type ResolvedCheck struct {
	Policy     *api.GuardrailPolicy
	Check      api.GuardrailCheck
	Connection *api.GuardrailConnection
	Mandatory  bool
}

// Bundle contains the complete ordered native checks and their effective configuration revision.
type Bundle struct {
	Checks      []ResolvedCheck
	Guard       *agw.AIPromptGuard
	Revision    string
	Connections []*api.GuardrailConnection
}

// ValidateConnection rejects unsupported transports and incomplete detector configuration.
func ValidateConnection(spec api.GuardrailConnectionSpec) error {
	if strings.TrimSpace(spec.DisplayName) == "" {
		return errors.New("connection display name is required")
	}
	switch spec.Provider {
	case "Webhook":
		u, err := url.Parse(spec.Endpoint)
		valid := err == nil && u.Hostname() != "" && (u.Scheme == "http" || u.Scheme == "https")
		if !valid || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("custom webhook endpoint must be an HTTP or HTTPS URL without credentials, query, or fragment")
		}
		if u.Path != "" && u.Path != "/" {
			return errors.New("custom webhook endpoint must use its root; AgentGateway calls /request and /response")
		}
	case "Bedrock":
		if spec.Region == "" {
			return errors.New("region is required for Bedrock")
		}
		if spec.Endpoint != "" {
			return errors.New("custom Bedrock endpoints are not supported")
		}
	case "OpenAI", "ModelArmor":
		if spec.Endpoint != "" {
			return errors.New("custom endpoints are supported only for webhook connections")
		}
	default:
		return errors.New("unsupported guardrail provider")
	}
	return nil
}

// ValidatePolicy validates locally knowable rules before resolving scoped dependencies.
func ValidatePolicy(spec api.GuardrailPolicySpec) error {
	if strings.TrimSpace(spec.DisplayName) == "" || len(spec.Checks) == 0 {
		return errors.New("policy display name and at least one check are required")
	}
	ids := make(map[string]bool, len(spec.Checks))
	for _, check := range spec.Checks {
		if check.ID == "" || check.Name == "" || ids[check.ID] {
			return errors.New("check IDs must be nonempty and unique; every check needs a name")
		}
		ids[check.ID] = true
		if check.Phase != "input" && check.Phase != "output" {
			return fmt.Errorf("check %q has an invalid phase", check.ID)
		}
		if check.Mode != "enforce" && check.Mode != "audit" {
			return fmt.Errorf("check %q must select enforce or audit", check.ID)
		}
		if check.FailureMode != "closed" && check.FailureMode != "open" {
			return fmt.Errorf("check %q must select closed or open failure handling", check.ID)
		}
		if check.Action != "deny" && check.Action != "mask" {
			return fmt.Errorf("check %q must select deny or mask", check.ID)
		}
		if check.Connection != nil && check.Action == "mask" {
			return fmt.Errorf(
				"check %q cannot override a remote provider's masking decision; configure masking in the provider and select deny to enforce its verdict",
				check.ID,
			)
		}
		if len(check.Scopes) == 0 {
			return fmt.Errorf("check %q needs a content scope", check.ID)
		}
		seen := make(map[string]bool, len(check.Scopes))
		for _, value := range check.Scopes {
			if seen[value] {
				return fmt.Errorf("check %q repeats a scope", check.ID)
			}
			seen[value] = true
			switch value {
			case "instructions", "conversation", "toolResults", "toolArguments":
			default:
				return fmt.Errorf("check %q has an unsupported content scope", check.ID)
			}
		}
		if (check.Regex == nil) == (check.Connection == nil) {
			return fmt.Errorf("check %q must select exactly one of regex or connection", check.ID)
		}
		if check.Regex != nil {
			if len(check.Regex.Patterns) == 0 {
				return fmt.Errorf("check %q needs a regex pattern", check.ID)
			}
			for _, pattern := range check.Regex.Patterns {
				if _, err := regexp.Compile(pattern); err != nil {
					return fmt.Errorf("check %q has an invalid regular expression: %w", check.ID, err)
				}
			}
		}
		if check.Action == "mask" && slices.Contains(check.Scopes, "toolArguments") {
			return errors.New("masking tool arguments can invalidate JSON and is unsupported")
		}
		if check.Phase == "output" && !slices.Equal(check.Scopes, []string{"conversation"}) {
			return errors.New("output guards currently support conversation text only")
		}
	}
	return nil
}

// Resolve loads the mandatory baseline and optional additions using trusted namespace identity.
func Resolve(ctx context.Context, reader client.Reader, namespace string, assignment api.GuardrailAssignment) (*Bundle, error) {
	orgNamespace, err := scope.Namespace(ctx, reader, namespace, api.ResourceScopeOrganisation)
	if err != nil {
		return nil, err
	}
	tenant := &api.Tenant{}
	if err := reader.Get(ctx, client.ObjectKey{Name: orgNamespace}, tenant); err != nil {
		return nil, fmt.Errorf("get organization guardrail settings: %w", err)
	}
	bundle := &Bundle{}
	refs := make([]api.ResourceReference, 0, len(tenant.Spec.Guardrails.MandatoryPolicies)+len(assignment.Policies))
	for _, name := range tenant.Spec.Guardrails.MandatoryPolicies {
		refs = append(refs, api.ResourceReference{Scope: api.ResourceScopeOrganisation, Name: name})
	}
	refs = append(refs, assignment.Policies...)
	seen := make(map[string]bool, len(refs))
	for index, ref := range refs {
		mandatory := index < len(tenant.Spec.Guardrails.MandatoryPolicies)
		if !mandatory && ref.Scope == api.ResourceScopeOrganisation {
			if slices.Contains(tenant.Spec.Guardrails.MandatoryPolicies, ref.Name) {
				continue
			}
		}
		selected := scope.Selection{
			Scope: ref.Scope,
			Kind:  api.OrganizationResourceKindGuardrailPolicy,
			Name:  ref.Name,
		}
		policyNamespace := orgNamespace
		if !mandatory {
			policyNamespace, err = scope.SelectedNamespace(ctx, reader, namespace, selected)
			if err != nil {
				return nil, err
			}
		}
		key := policyNamespace + "/" + ref.Name
		if previousMandatory, exists := seen[key]; exists {
			if previousMandatory && !mandatory {
				continue
			}
			return nil, fmt.Errorf("guardrail policy %q is assigned more than once", ref.Name)
		}
		seen[key] = mandatory
		policy := &api.GuardrailPolicy{}
		err = reader.Get(ctx, client.ObjectKey{Namespace: policyNamespace, Name: ref.Name}, policy)
		if err != nil {
			return nil, fmt.Errorf("get guardrail policy %q: %w", ref.Name, err)
		}
		if !policy.DeletionTimestamp.IsZero() {
			return nil, fmt.Errorf("guardrail policy %q is terminating", ref.Name)
		}
		if err := ValidatePolicy(policy.Spec); err != nil {
			return nil, fmt.Errorf("policy %q: %w", ref.Name, err)
		}
		for _, check := range policy.Spec.Checks {
			resolved := ResolvedCheck{Policy: policy, Check: check, Mandatory: mandatory}
			if check.Connection != nil {
				connection, err := bundle.resolveConnection(ctx, reader, policy.Namespace, *check.Connection)
				if err != nil {
					return nil, err
				}
				resolved.Connection = connection
			}
			bundle.Checks = append(bundle.Checks, resolved)
		}
	}
	bundle.Revision, err = configurationRevision(tenant.Spec.Guardrails, bundle.Checks)
	if err != nil {
		return nil, err
	}
	if err := bundle.compile(namespace); err != nil {
		return nil, err
	}
	return bundle, nil
}

// ConnectionRuntimeName is stable and distinct across source scopes.
func ConnectionRuntimeName(connection *api.GuardrailConnection) string {
	sum := sha256.Sum256([]byte(connection.Namespace + "/" + connection.Name))
	return "guardrail-" + hex.EncodeToString(sum[:8])
}

func (b *Bundle) compile(namespace string) error {
	mandatoryPhases := make(map[string]bool, 2)
	for _, resolved := range b.Checks {
		if resolved.Mandatory {
			mandatoryPhases[resolved.Check.Phase] = true
		}
	}
	guard := &agw.AIPromptGuard{Streaming: agw.PromptGuardStreamingModeEnabled}
	for _, resolved := range b.Checks {
		check := resolved.Check
		action := agw.REJECT
		rejectAction := agw.RejectAuditReject
		if check.Action == "mask" {
			action = agw.MASK
		}
		if check.Mode == "audit" {
			action = agw.AUDIT
			rejectAction = agw.RejectAuditAudit
		}
		failure := agw.FailureMode("FailClosed")
		if check.FailureMode == "open" {
			failure = "FailOpen"
		}
		if !resolved.Mandatory && mandatoryPhases[check.Phase] && check.Mode == "enforce" {
			mutates := check.Action == "mask" || resolved.Connection != nil && (resolved.Connection.Spec.Provider == "Bedrock" || resolved.Connection.Spec.Provider == "Webhook")
			if mutates {
				return fmt.Errorf("check %q can modify content after mandatory organization checks; use audit mode or a non-mutating detector", check.ID)
			}
		}
		label := fmt.Sprintf("Blocked by guardrail %q", check.Name)
		if resolved.Policy != nil {
			label += fmt.Sprintf(" in policy %q", resolved.Policy.Spec.DisplayName)
		}
		message := label
		if check.SafeExplanation != "" {
			message += ": " + check.SafeExplanation
		}
		request := agw.PromptguardRequest{
			CustomResponse: &agw.CustomResponse{StatusCode: 422, Message: &message},
		}
		response := agw.PromptguardResponse{
			CustomResponse: &agw.CustomResponse{StatusCode: 422, Message: &message},
		}
		for _, value := range check.Scopes {
			switch value {
			case "instructions":
				request.Scope = append(request.Scope, agw.ContentScopeSystemPrompt)
			case "conversation":
				request.Scope = append(request.Scope, agw.ContentScopeMessages)
			case "toolResults":
				request.Scope = append(request.Scope, agw.ContentScopeToolOutput)
			case "toolArguments":
				request.Scope = append(request.Scope, agw.ContentScopeToolInput)
			}
		}
		if check.Regex != nil {
			regex := &agw.Regex{Matches: check.Regex.Patterns, Action: &action}
			request.Regex = regex
			response.Regex = regex
		}
		if resolved.Connection != nil {
			connection := resolved.Connection
			name := ConnectionRuntimeName(connection)
			secret := &agw.LocalSecretKeyRef{Name: gwv1.ObjectName(name), Key: new("token")}
			defaultScopes := len(check.Scopes) == 2 && slices.Contains(check.Scopes, "instructions") && slices.Contains(check.Scopes, "conversation")
			if check.Phase == "input" && connection.Spec.Provider != "Bedrock" && !defaultScopes {
				return fmt.Errorf("check %q provider requires instructions and conversation scopes", check.ID)
			}
			switch connection.Spec.Provider {
			case "OpenAI":
				if check.Phase == "output" {
					return errors.New("OpenAI moderation currently supports input checks only")
				}
				request.OpenAIModeration = &agw.OpenAIModeration{
					FailureMode: failure,
					Action:      &rejectAction,
					Policies:    &agw.OpenAIModerationPolicy{Auth: &agw.OpenAIModerationAuth{SecretRef: secret}},
				}
			case "Bedrock":
				if check.GuardrailID == "" || check.GuardrailVersion == "" {
					return errors.New("guardrail ID and version are required for Bedrock")
				}
				auth := &agw.AwsAuth{}
				if connection.Spec.SecretName != "" {
					auth.SecretRef = &agw.LocalSecretObjectRef{Name: gwv1.ObjectName(name)}
				}
				bedrock := &agw.BedrockGuardrails{
					FailureMode:         failure,
					Action:              &rejectAction,
					GuardrailIdentifier: check.GuardrailID,
					GuardrailVersion:    check.GuardrailVersion,
					Region:              connection.Spec.Region,
					Policies:            &agw.BedrockGuardrailsPolicy{Auth: &agw.BedrockGuardrailsAuth{AWS: auth}},
				}
				request.BedrockGuardrails = bedrock
				response.BedrockGuardrails = bedrock
			case "ModelArmor":
				parts := strings.Split(check.Template, "/")
				if len(parts) != 6 || parts[0] != "projects" || parts[2] != "locations" || parts[4] != "templates" {
					return errors.New("template must use projects/{project}/locations/{location}/templates/{template} for Model Armor")
				}
				gcp := &agw.GcpAuth{}
				if connection.Spec.SecretName != "" {
					gcp.SecretRef = &agw.LocalSecretKeyRef{Name: gwv1.ObjectName(name), Key: new("credentials.json")}
				}
				armor := &agw.GoogleModelArmor{
					FailureMode: failure,
					Action:      &rejectAction,
					ProjectID:   parts[1],
					Location:    &parts[3],
					TemplateID:  parts[5],
					Policies:    &agw.GoogleModelArmorPolicy{Auth: &agw.GoogleModelArmorAuth{GCP: gcp}},
				}
				request.GoogleModelArmor = armor
				response.GoogleModelArmor = armor
			case "Webhook":
				webhook := &agw.Webhook{
					BackendRef: gwv1.BackendObjectReference{
						Group:     new(gwv1.Group("agentgateway.dev")),
						Kind:      new(gwv1.Kind("AgentgatewayBackend")),
						Name:      gwv1.ObjectName(name),
						Namespace: new(gwv1.Namespace(namespace)),
					},
					FailureMode: failure,
					Action:      &rejectAction,
				}
				request.Webhook = webhook
				response.Webhook = webhook
			}
		}
		if check.Phase == "input" {
			guard.Request = append(guard.Request, request)
			continue
		}
		guard.Response = append(guard.Response, response)
	}
	if len(guard.Request) > 8 || len(guard.Response) > 8 {
		return errors.New("effective guardrails exceed the gateway limit of eight checks per phase")
	}
	if len(b.Checks) > 0 {
		b.Guard = guard
	}
	return nil
}

// Apply attaches the complete effective bundle without discarding existing model/auth policies.
func (b *Bundle) Apply(policy *agw.AgentgatewayPolicy) error {
	if b.Guard == nil {
		return nil
	}
	if policy.Spec.Backend == nil {
		policy.Spec.Backend = &agw.BackendFull{}
	}
	if policy.Spec.Backend.AI == nil {
		policy.Spec.Backend.AI = &agw.BackendAI{}
	}
	policy.Spec.Backend.AI.PromptGuard = b.Guard
	if policy.Spec.Traffic == nil {
		policy.Spec.Traffic = &agw.Traffic{}
	}
	if policy.Spec.Traffic.Transformation == nil {
		policy.Spec.Traffic.Transformation = &agw.TransformationOrConditional{}
	}
	if policy.Spec.Traffic.Transformation.Request == nil {
		policy.Spec.Traffic.Transformation.Request = &agw.Transform{}
	}
	request := policy.Spec.Traffic.Transformation.Request
	if request.Metadata == nil {
		request.Metadata = map[string]agw.CELExpression{}
	}
	encoded, err := json.Marshal(b.Revision)
	if err != nil {
		return err
	}
	request.Metadata["agentz_guardrail_revision"] = agw.CELExpression(encoded)
	if policy.Annotations == nil {
		policy.Annotations = map[string]string{}
	}
	policy.Annotations["agentz.accuknox.com/guardrail-revision"] = b.Revision
	return nil
}

// ValidateStreaming rejects mutations that native checked streaming cannot apply.
// Checks inspect overlapping windows, not the complete response.
func (b *Bundle) ValidateStreaming() error {
	for _, resolved := range b.Checks {
		check := resolved.Check
		if check.Phase != "output" || check.Mode != "enforce" {
			continue
		}
		if check.Regex != nil {
			for _, pattern := range check.Regex.Patterns {
				parsed, err := syntax.Parse(pattern, syntax.Perl)
				if err != nil {
					return fmt.Errorf("check %q has an invalid regex: %w", check.ID, err)
				}
				width, compatible := boundedPatternWidth(parsed)
				if !compatible || width > 256 {
					return fmt.Errorf("check %q requires whole-output regex context; use a bounded pattern without anchors or audit mode", check.ID)
				}
			}
		}
		if check.Action == "mask" {
			return fmt.Errorf("check %q masks output, which native checked streaming cannot apply; use audit mode or denial", check.ID)
		}
		if resolved.Connection != nil && (resolved.Connection.Spec.Provider == "Bedrock" || resolved.Connection.Spec.Provider == "Webhook") {
			return fmt.Errorf(
				"check %q uses a provider that can modify output, which native checked streaming cannot apply; use audit mode or a non-mutating detector",
				check.ID,
			)
		}
	}
	return nil
}

// CompilePolicy resolves and compiles a policy to validate its checks and scoped connections.
func CompilePolicy(ctx context.Context, reader client.Reader, namespace string, policy *api.GuardrailPolicy) (*Bundle, error) {
	if err := ValidatePolicy(policy.Spec); err != nil {
		return nil, err
	}
	bundle := &Bundle{}
	for _, check := range policy.Spec.Checks {
		resolved := ResolvedCheck{Policy: policy, Check: check}
		if check.Connection != nil {
			connection, err := bundle.resolveConnection(ctx, reader, namespace, *check.Connection)
			if err != nil {
				return nil, err
			}
			resolved.Connection = connection
		}
		bundle.Checks = append(bundle.Checks, resolved)
	}
	var err error
	bundle.Revision, err = configurationRevision(api.GuardrailSettings{}, bundle.Checks)
	if err != nil {
		return nil, err
	}
	if err := bundle.compile(namespace); err != nil {
		return nil, err
	}
	return bundle, nil
}

// resolveConnection shares one validated credential snapshot across checks in a bundle.
func (b *Bundle) resolveConnection(ctx context.Context, reader client.Reader, namespace string, ref api.ResourceReference) (*api.GuardrailConnection, error) {
	ns, err := scope.SelectedNamespace(ctx, reader, namespace, scope.Selection{
		Scope: ref.Scope,
		Kind:  api.OrganizationResourceKindGuardrailConnection,
		Name:  ref.Name,
	})
	if err != nil {
		return nil, err
	}
	for _, connection := range b.Connections {
		if connection.Namespace == ns && connection.Name == ref.Name {
			return connection, nil
		}
	}
	connection := &api.GuardrailConnection{}
	err = reader.Get(ctx, client.ObjectKey{Namespace: ns, Name: ref.Name}, connection)
	if err != nil {
		return nil, fmt.Errorf("get guardrail connection: %w", err)
	}
	if !connection.DeletionTimestamp.IsZero() {
		return nil, errors.New("guardrail connection is terminating")
	}
	if err := ValidateConnection(connection.Spec); err != nil {
		return nil, err
	}
	b.Connections = append(b.Connections, connection)
	return connection, nil
}

type checkRevision struct {
	PolicyNamespace      string
	PolicyName           string
	PolicyUID            string
	PolicyGeneration     int64
	Check                api.GuardrailCheck
	ConnectionNamespace  string
	ConnectionName       string
	ConnectionUID        string
	ConnectionGeneration int64
	ConnectionSpec       *api.GuardrailConnectionSpec
}

type effectiveRevision struct {
	Settings api.GuardrailSettings
	Checks   []checkRevision
}

func configurationRevision(settings api.GuardrailSettings, checks []ResolvedCheck) (string, error) {
	snapshot := effectiveRevision{
		Settings: settings,
		Checks:   make([]checkRevision, 0, len(checks)),
	}
	for _, check := range checks {
		revision := checkRevision{
			PolicyNamespace:  check.Policy.Namespace,
			PolicyName:       check.Policy.Name,
			PolicyUID:        string(check.Policy.UID),
			PolicyGeneration: check.Policy.Generation,
			Check:            check.Check,
		}
		if check.Connection != nil {
			revision.ConnectionNamespace = check.Connection.Namespace
			revision.ConnectionName = check.Connection.Name
			revision.ConnectionUID = string(check.Connection.UID)
			revision.ConnectionGeneration = check.Connection.Generation
			revision.ConnectionSpec = &check.Connection.Spec
		}
		snapshot.Checks = append(snapshot.Checks, revision)
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// boundedPatternWidth only admits regexes whose complete match fits inside the
// gateway's overlap. Anchors and unbounded repetitions need whole-output context.
func boundedPatternWidth(pattern *syntax.Regexp) (int, bool) {
	switch pattern.Op {
	case syntax.OpEmptyMatch, syntax.OpNoMatch:
		return 0, true
	case syntax.OpLiteral:
		if pattern.Flags&syntax.FoldCase != 0 {
			return len(pattern.Rune) * utf8.UTFMax, true
		}
		width := 0
		for _, value := range pattern.Rune {
			width += utf8.RuneLen(value)
		}
		return width, true
	case syntax.OpCharClass, syntax.OpAnyCharNotNL, syntax.OpAnyChar:
		return 4, true
	case syntax.OpCapture, syntax.OpQuest:
		return boundedPatternWidth(pattern.Sub[0])
	case syntax.OpRepeat:
		if pattern.Max < 0 {
			return 0, false
		}
		width, valid := boundedPatternWidth(pattern.Sub[0])
		if !valid || width > 256 || pattern.Max > 256 {
			return 0, false
		}
		return width * pattern.Max, true
	case syntax.OpConcat:
		width := 0
		for _, part := range pattern.Sub {
			length, valid := boundedPatternWidth(part)
			if !valid {
				return 0, false
			}
			width += length
			if width > 256 {
				return 0, false
			}
		}
		return width, true
	case syntax.OpAlternate:
		width := 0
		for _, part := range pattern.Sub {
			length, valid := boundedPatternWidth(part)
			if !valid {
				return 0, false
			}
			width = max(width, length)
		}
		return width, true
	default:
		return 0, false
	}
}
