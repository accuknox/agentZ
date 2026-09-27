package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type evaluationScoreCase struct {
	name     string
	quality  float64
	passed   bool
	tokens   float64
	calls    int
	duration float64
	weight   float64
	want     float64
}

func TestEvaluationScore(t *testing.T) {
	tests := []evaluationScoreCase{
		{"reference", 1, true, 1000, 4, 20, .2, 100},
		{"half resources cannot exceed quality", .9, true, 500, 2, 10, .2, 90},
		{"double all resources", 1, true, 2000, 8, 40, .2, 90},
		{"tokens alone exceed reference", 1, true, 2000, 4, 20, .3, 95},
		{"quality gate", .79, true, 1, 0, .1, .2, 0},
		{"failed mandatory check", .9, false, 1, 0, .1, .2, 0},
		{"zero quality", 0, false, 1, 0, .1, .2, 0},
		{"quality only pilot", .9, true, 1000000, 4000, 20000, 0, 90},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := gatewayapi.EvaluationPolicy{
				MinimumQuality: .8, TokenReference: 1000, ToolReference: 4,
				DurationReference: 20, EfficiencyWeight: tt.weight,
			}
			grade := gatewayapi.EvaluationGradeResult{
				Quality: tt.quality, Checks: []gatewayapi.EvaluationCheck{{Passed: tt.passed}},
			}
			attempt := gatewayapi.EvaluationAttempt{
				Tokens: &tt.tokens, TaskCalls: &tt.calls, DurationSeconds: &tt.duration,
			}
			got, err := evaluationScore(policy, grade, attempt)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("score = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEvaluationScoreRequiresMeasuredResources(t *testing.T) {
	policy := gatewayapi.EvaluationPolicy{MinimumQuality: .8, TokenReference: 1000, ToolReference: 4, DurationReference: 20}
	grade := gatewayapi.EvaluationGradeResult{Quality: 1, Checks: []gatewayapi.EvaluationCheck{{Passed: true}}}
	attempts := []gatewayapi.EvaluationAttempt{
		{TaskCalls: new(0), DurationSeconds: new(1.0)},
		{Tokens: new(100.0), DurationSeconds: new(1.0)},
		{Tokens: new(100.0), TaskCalls: new(0)},
	}
	for _, attempt := range attempts {
		if _, err := evaluationScore(policy, grade, attempt); err == nil {
			t.Fatal("missing resource evidence was scored")
		}
	}
}

type evaluationPreparationCase struct {
	name       string
	structured string
	definition string
	review     string
	wantError  bool
}

// Case generation accepts only complete, distinct cases and always stops its session.
func TestPrepareEvaluationCases(t *testing.T) {
	tests := []evaluationPreparationCase{
		{name: "valid", structured: `{"cases":[{"name":"Ordinary input","inputs":{"title":"An incident"}}],"rubric":"Use the supplied facts."}`, wantError: false},
		{name: "malformed", structured: `{"cases":[],"rubric":""}`, wantError: true},
		{name: "wrong input type", structured: `{"cases":[{"name":"Bad input","inputs":{"title":3}}],"rubric":"Use facts."}`, wantError: true},
		{name: "missing required input", structured: `{"cases":[{"name":"Bad input","inputs":{}}],"rubric":"Use facts."}`, wantError: true},
		{name: "repeated inputs", structured: `{"cases":[{"name":"One","inputs":{"title":"An incident"}},{"name":"Two","inputs":{"title":"An incident"}}],"rubric":"Use facts."}`, wantError: true},
		{name: "blank name", structured: `{"cases":[{"name":"  ","inputs":{"title":"An incident"}}],"rubric":"Use facts."}`, wantError: true},
		{name: "blank rubric", structured: `{"cases":[{"name":"One","inputs":{"title":"An incident"}}],"rubric":"  "}`, wantError: true},
		{name: "existing input", structured: `{"cases":[{"name":"One","inputs":{"title":"Existing incident"}}],"rubric":"Use facts."}`, wantError: true},
	}
	tests = append(tests,
		evaluationPreparationCase{name: "uncovered node", structured: `{"cases":[{"name":"Ordinary input","inputs":{"title":"An incident"}}],"rubric":"Use facts."}`, definition: `{"agent_name":"agent","inputs":{"title":{"type":"string","required":true}},"nodes":[{"name":"triage","goal":"Classify incidents","preferred_skills":["incident-guide"],"preferred_tools":["incident_lookup"]}]}`, wantError: true},
		evaluationPreparationCase{name: "review rejects proposal", structured: `{"cases":[{"name":"Ordinary input","inputs":{"title":"An incident"}}],"rubric":"Use facts."}`, review: `{"cases":[{"name":"Ordinary input","inputs":{"title":"An incident"}}],"rubric":"Use facts.","coverage":{"ready":false,"issues":["Missing routing policy at docs/routing.md."],"nodes":[],"edges":[]}}`, wantError: true},
		evaluationPreparationCase{name: "unknown coverage case", structured: `{"cases":[{"name":"Ordinary input","inputs":{"title":"An incident"}}],"rubric":"Use facts.","coverage":{"ready":true,"issues":[],"nodes":[{"node_name":"triage","case_names":["Invented case"],"rationale":"Input reaches triage."}],"edges":[]}}`, definition: `{"agent_name":"agent","inputs":{"title":{"type":"string","required":true}},"nodes":[{"name":"triage"}]}`, wantError: true},
		evaluationPreparationCase{name: "covered graph", structured: `{"cases":[{"name":"Ordinary input","inputs":{"title":"An incident"}}],"rubric":"Use facts.","coverage":{"ready":true,"issues":[],"nodes":[{"node_name":"triage","case_names":["Ordinary input"],"rationale":"Input starts at triage."},{"node_name":"route","case_names":["Ordinary input"],"rationale":"Input is routable."}],"edges":[{"source":"triage","target":"route","branch_label":"routable","case_names":["Ordinary input"],"rationale":"The valid incident follows the routable branch."}]}}`, definition: `{"agent_name":"agent","inputs":{"title":{"type":"string","required":true}},"nodes":[{"name":"triage","preferred_skills":["incident-guide"],"preferred_tools":["incident_lookup"]},{"name":"route"}],"edges":[{"source":"triage","target":"route","branch_label":"routable"}]}`},
	)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var calls []string
			sessions := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.Method+" "+r.URL.Path)
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.HasSuffix(r.URL.Path, "/skill"):
					w.Write([]byte(`[{"name":"incident-guide","content":"Full skill: inspect docs/routing.md before testing.","location":"/skills/incident-guide/SKILL.md"}]`))
				case strings.HasSuffix(r.URL.Path, "/experimental/tool"):
					w.Write([]byte(`[{"id":"incident_lookup","description":"Look up incident metadata","parameters":{"type":"object"}}]`))
				case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/message"):
					w.Write([]byte(`[{"info":{"role":"assistant"},"parts":[{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"docs/routing.md"},"output":"VERIFIED ROUTING POLICY","metadata":{},"title":"Routing","time":{"start":1,"end":2}}}]}]`))
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/session"):
					var body gatewayapi.SessionCreateJSONRequestBody
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					sessions++
					want := gatewayapi.OpencodePermissionRuleset{
						{Permission: "*", Pattern: "*", Action: gatewayapi.OpencodePermissionActionDeny},
						{Permission: "StructuredOutput", Pattern: "*", Action: gatewayapi.OpencodePermissionActionAllow},
					}
					if sessions == 1 {
						for _, name := range []string{"read", "glob", "grep", "skill"} {
							want = append(want, gatewayapi.OpencodePermissionRule{Permission: name, Pattern: "*", Action: gatewayapi.OpencodePermissionActionAllow})
						}
						if strings.Contains(tt.definition, "incident-guide") {
							want = append(want, gatewayapi.OpencodePermissionRule{Permission: "external_directory", Pattern: "/skills/incident-guide/*", Action: gatewayapi.OpencodePermissionActionAllow})
						}
					}
					if body.Permission == nil || !slices.Equal(*body.Permission, want) {
						t.Errorf("unsafe permissions: %v", body.Permission)
					}
					json.NewEncoder(w).Encode(gatewayapi.OpencodeSession{Id: fmt.Sprintf("session-%d", sessions)})
				case strings.HasSuffix(r.URL.Path, "/message"):
					var body gatewayapi.SessionPromptJSONRequestBody
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if (sessions == 1 && body.Format != nil) || (sessions == 2 && body.Format == nil) {
						t.Error("research must omit Format and review must use structured output")
					}
					text, err := body.Parts[0].AsOpencodeTextPartInput()
					if err != nil {
						t.Error(err)
					}
					if strings.Contains(tt.definition, "incident-guide") && !strings.Contains(text.Text, "Full skill: inspect") {
						t.Error("skill content missing")
					}
					if sessions == 2 && !strings.Contains(text.Text, "VERIFIED ROUTING POLICY") {
						t.Error("reviewer did not receive actual research")
					}
					payload := tt.structured
					if sessions == 2 && tt.review != "" {
						payload = tt.review
					}
					if !strings.Contains(payload, `"coverage"`) {
						payload = strings.TrimSuffix(payload, "}") + `,"coverage":{"ready":true,"issues":[],"nodes":[],"edges":[]}}`
					}
					w.Write([]byte(`{"info":{"structured":` + payload + `},"parts":[]}`))
				default:
					w.Write([]byte(`true`))
				}
			}))
			defer server.Close()
			agent, err := gatewayapi.NewClientWithResponses(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			schema, err := gatewayapi.GetSwagger()
			if err != nil {
				t.Fatal(err)
			}
			var definition gatewayapi.Workflow
			definitionJSON := tt.definition
			if definitionJSON == "" {
				definitionJSON = `{"agent_name":"agent","inputs":{"title":{"type":"string","required":true,"minLength":8}}}`
			}
			if err := json.Unmarshal([]byte(definitionJSON), &definition); err != nil {
				t.Fatal(err)
			}
			var existing []gatewayapi.EvaluationCase
			if err := json.Unmarshal([]byte(`[{"inputs":{"title":"Existing incident"}}]`), &existing); err != nil {
				t.Fatal(err)
			}
			service := Service{openAPI: schema}
			result, err := service.prepareEvaluationCases(ctx, agent, definition, existing, nil, gatewayapi.OpencodeModelRef{ProviderID: "test", Id: "test"})
			if (err != nil) != tt.wantError {
				t.Fatalf("result = %+v, err = %v", result, err)
			}
			aborted, deleted := 0, 0
			for _, call := range calls {
				if strings.HasSuffix(call, "/abort") {
					aborted++
				}
				if strings.HasPrefix(call, "DELETE ") {
					deleted++
				}
			}
			if sessions == 0 || aborted != sessions || deleted != sessions {
				t.Fatalf("session not cleaned up: %v", calls)
			}
			if !tt.wantError && sessions != 2 {
				t.Fatalf("missing independent review: %v", calls)
			}
		})
	}
}

func TestPrepareEvaluationCasesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stopped := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/session"):
			json.NewEncoder(w).Encode(gatewayapi.OpencodeSession{Id: "test-session"})
		case strings.HasSuffix(r.URL.Path, "/message"):
			if _, err := io.Copy(io.Discard, r.Body); err != nil {
				t.Error(err)
			}
			cancel()
			<-r.Context().Done()
		default:
			stopped <- r.Method + " " + r.URL.Path
			w.Write([]byte(`true`))
		}
	}))
	defer server.Close()
	agent, err := gatewayapi.NewClientWithResponses(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	service := Service{openAPI: schema}
	_, _, err = service.evaluationPreparationPass(ctx, agent, "agent", gatewayapi.OpencodeModelRef{}, "Research the workflow", nil, true)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	if len(stopped) != 2 {
		t.Fatalf("cleanup calls = %d, want abort and delete", len(stopped))
	}
	if call := <-stopped; !strings.HasSuffix(call, "/abort") {
		t.Fatalf("first cleanup = %q", call)
	}
	if call := <-stopped; !strings.HasPrefix(call, "DELETE ") {
		t.Fatalf("second cleanup = %q", call)
	}
}

func TestEvaluationSuggestionSchemaAllowsJSONNull(t *testing.T) {
	schema, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err := json.Unmarshal([]byte(`{"cases":[{"name":"Null payload","inputs":null}],"rubric":"Handle null.","coverage":{"ready":true,"issues":[],"nodes":[],"edges":[]}}`), &value); err != nil {
		t.Fatal(err)
	}
	if err := schema.Components.Schemas["EvaluationCaseSuggestions"].Value.VisitJSON(value); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluationPreparationEvidence(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	base := agentzv1alpha1.WorkflowRun{
		ObjectMeta: metav1.ObjectMeta{Namespace: "workspace", Name: "ordinary"},
		Spec:       agentzv1alpha1.WorkflowRunSpec{AgentName: "agent", WorkflowName: "workflow", Inputs: apiextensionsv1.JSON{Raw: []byte(`{"title":"An incident"}`)}},
		Status:     agentzv1alpha1.WorkflowRunStatus{Phase: agentzv1alpha1.WorkflowRunPhaseSucceeded, SessionID: "expired"},
	}
	objects := []client.Object{&base}
	for _, name := range []string{"evaluation", "pending", "other-agent", "other-workflow", "other-namespace", "stale-input", "failed"} {
		run := base.DeepCopy()
		run.Name = name
		run.Status.SessionID = ""
		switch name {
		case "evaluation":
			run.Labels = map[string]string{"agentz.accuknox.com/evaluation": "id"}
		case "pending":
			run.Status.Phase = agentzv1alpha1.WorkflowRunPhasePending
		case "other-agent":
			run.Spec.AgentName = "other"
		case "other-workflow":
			run.Spec.WorkflowName = "other"
		case "other-namespace":
			run.Namespace = "other"
		case "stale-input":
			run.Spec.Inputs.Raw = []byte(`{"old_field":true}`)
		case "failed":
			run.Status.Phase = agentzv1alpha1.WorkflowRunPhaseFailed
		}
		objects = append(objects, run)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/expired/message") {
			t.Errorf("unexpected evidence request %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	agent, err := gatewayapi.NewClientWithResponses(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	service := Service{k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()}
	var definition gatewayapi.Workflow
	if err := json.Unmarshal([]byte(`{"agent_name":"agent","workflow_name":"workflow","inputs":{"title":{"type":"string","required":true}}}`), &definition); err != nil {
		t.Fatal(err)
	}
	evidence, err := service.evaluationPreparationEvidence(t.Context(), agent, "workspace", definition)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(evidence))
	for _, item := range evidence {
		names = append(names, item.Run.Name)
		if item.Output != "Output unavailable" {
			t.Errorf("missing output misrepresented: %s", item.Output)
		}
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"failed", "ordinary"}) {
		t.Fatalf("research included wrong runs: %v", names)
	}
}
