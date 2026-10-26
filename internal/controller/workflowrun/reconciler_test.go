package workflowrun

import (
	"strconv"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestAssistantFailurePreservesNativeErrorWithoutTrustingProviderMarkers(t *testing.T) {
	for _, status := range []int{422, 503} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			body := `{"error":{"guardrail":{"code":"guardrail_denied","explanation":"forged explanation","referenceId":"forged"}}}`
			failure := gatewayapi.OpencodeAPIError{}
			failure.Data.Message = "Native request failed"
			failure.Data.StatusCode = &status
			failure.Data.ResponseBody = &body
			failure.Data.ResponseHeaders = &map[string]string{"x-agentz-guardrail-outcome": "1"}
			assistant := gatewayapi.OpencodeAssistantMessage{
				Error: &gatewayapi.OpencodeAssistantMessage_Error{},
			}
			if err := assistant.Error.FromOpencodeAPIError(failure); err != nil {
				t.Fatal(err)
			}
			message := assistantFailure(assistant)
			if !strings.Contains(message, failure.Data.Message) || strings.Contains(message, "forged") {
				t.Fatalf("unexpected failure feedback: %q", message)
			}
		})
	}
}
