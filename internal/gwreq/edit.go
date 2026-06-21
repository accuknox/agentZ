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

func RequestEditor(tokenPath string, namespace string) gatewayapi.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		token, err := readServiceAccountToken(tokenPath)
		if err != nil {
			return err
		}

		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set(
			internalTenantNamespaceHeader,
			strings.TrimSpace(namespace),
		)
		return nil
	}
}

func readServiceAccountToken(path string) (string, error) {
	token, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read service account token %q: %w", path, err)
	}
	return strings.TrimSpace(string(token)), nil
}
