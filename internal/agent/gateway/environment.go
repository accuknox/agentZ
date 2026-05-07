package gateway

import (
	"fmt"
	"net/http"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

// ListEnvironments handles GET /api/environment/list.
func (s *Service) ListEnvironments(w http.ResponseWriter, r *http.Request, params gatewayapi.ListEnvironmentsParams) {
	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	var envList clawarmorv1alpha1.EnvironmentList
	if err := s.k8sClient.List(r.Context(), &envList, ctrlclient.InNamespace(s.cfg.Namespace)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list environments: %w", err))
		return
	}

	items := make([]gatewayapi.Environment, 0, len(envList.Items))
	for _, env := range envList.Items {
		items = append(items, environmentFromCRD(env))
	}

	start := min(offset, len(items))
	end := min(start+limit, len(items))

	page := items[start:end]
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListEnvironmentsResponse{
		Environments:  page,
		NextPageToken: next,
	})
}

// CreateEnvironment handles POST /api/environment/create.
func (s *Service) CreateEnvironment(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateEnvironmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, fields := validateCreateEnvironmentRequest(req)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	packages := []string{}
	if req.Packages != nil {
		for _, p := range *req.Packages {
			p = strings.TrimSpace(p)
			if p != "" {
				packages = append(packages, p)
			}
		}
	}

	env := &clawarmorv1alpha1.Environment{
		TypeMeta: metav1.TypeMeta{
			APIVersion: clawarmorv1alpha1.GroupVersion.String(),
			Kind:       "Environment",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.cfg.Namespace,
		},
		Spec: clawarmorv1alpha1.EnvironmentSpec{
			Packages: packages,
		},
	}

	if err := s.k8sClient.Create(r.Context(), env); err != nil {
		writeError(w, r, mapKubeHTTPError("create environment", err))
		return
	}

	writeJSON(w, http.StatusCreated, environmentFromCRD(*env))
}

// DeleteEnvironment handles POST /api/environment/delete.
func (s *Service) DeleteEnvironment(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.DeleteEnvironmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "name", Message: "required"},
		))
		return
	}

	env := &clawarmorv1alpha1.Environment{}
	env.Name = name
	env.Namespace = s.cfg.Namespace

	if err := s.k8sClient.Delete(r.Context(), env); err != nil {
		writeError(w, r, mapKubeHTTPError("delete environment", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateEnvironment handles POST /api/environment/update/{name}.
func (s *Service) UpdateEnvironment(w http.ResponseWriter, r *http.Request, name gatewayapi.EnvironmentNamePath) {
	var req gatewayapi.UpdateEnvironmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	fields := validateUpdateEnvironmentRequest(req)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	envName := strings.TrimSpace(name)
	var updated *clawarmorv1alpha1.Environment
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		env := &clawarmorv1alpha1.Environment{}
		if getErr := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{
			Name:      envName,
			Namespace: s.cfg.Namespace,
		}, env); getErr != nil {
			return getErr
		}

		packages := []string{}
		for _, p := range req.Packages {
			p = strings.TrimSpace(p)
			if p != "" {
				packages = append(packages, p)
			}
		}
		env.Spec.Packages = packages

		if updateErr := s.k8sClient.Update(r.Context(), env); updateErr != nil {
			return updateErr
		}
		updated = env
		return nil
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update environment", err))
		return
	}

	writeJSON(w, http.StatusOK, environmentFromCRD(*updated))
}

func environmentFromCRD(env clawarmorv1alpha1.Environment) gatewayapi.Environment {
	out := gatewayapi.Environment{
		Name:      env.Name,
		Packages:  env.Spec.Packages,
		CreatedAt: env.CreationTimestamp.Time,
	}
	out.Metadata.PackageCount = int32(len(env.Spec.Packages))
	return out
}

func validateCreateEnvironmentRequest(req gatewayapi.CreateEnvironmentRequest) (string, []gatewayapi.FieldError) {
	fields := []gatewayapi.FieldError{}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{Field: "name", Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be at most 32 characters",
		})
	}
	if name != "" {
		if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field: "name", Message: "must be a valid DNS label",
			})
		}
	}

	if req.Packages != nil {
		for i, p := range *req.Packages {
			if strings.TrimSpace(p) == "" {
				fields = append(fields, gatewayapi.FieldError{
					Field:   fmt.Sprintf("packages[%d]", i),
					Message: "must not be empty",
				})
			}
		}
	}

	return name, fields
}

func validateUpdateEnvironmentRequest(req gatewayapi.UpdateEnvironmentRequest) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	for i, p := range req.Packages {
		if strings.TrimSpace(p) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("packages[%d]", i),
				Message: "must not be empty",
			})
		}
	}
	return fields
}
