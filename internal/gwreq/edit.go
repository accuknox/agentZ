package gwreq

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
)

const internalTenantNamespaceHeader = "X-ClawArmor-Tenant-Namespace"

// RequestEditor attaches the manager token and tenant namespace to gateway
// requests made on behalf of one tenant.
func RequestEditor(tokenPath string, namespace string) gatewayapi.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		token, err := os.ReadFile(tokenPath)
		if err != nil {
			return fmt.Errorf(
				"read service account token %q: %w",
				tokenPath,
				err,
			)
		}

		req.Header.Set(
			"Authorization",
			"Bearer "+strings.TrimSpace(string(token)),
		)
		req.Header.Set(
			internalTenantNamespaceHeader,
			strings.TrimSpace(namespace),
		)
		return nil
	}
}
