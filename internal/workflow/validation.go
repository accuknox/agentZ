package workflow

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gwreq"
)

var workflowScheduleParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

// ValidateCronSchedule rejects schedules Kubernetes CronJobs will not accept.
func ValidateCronSchedule(schedule string) error {
	_, err := workflowScheduleParser.Parse(schedule)
	if err != nil {
		return fmt.Errorf("invalid cron schedule: %w", err)
	}
	return nil
}

// ValidateTimeZone rejects time zone names Kubernetes will not resolve.
func ValidateTimeZone(name string) error {
	if name == "" {
		return nil
	}

	_, err := time.LoadLocation(name)
	if err != nil {
		return fmt.Errorf("invalid time zone: %w", err)
	}
	return nil
}

// ValidateInputs loads one workflow definition and validates runtime inputs.
func ValidateInputs(ctx context.Context, c *gatewayapi.ClientWithResponses, tknPath, ns string, gk schema.GroupKind, name, agtName, wfName string, raw []byte, path *field.Path) error {
	if c == nil {
		fields := field.ErrorList{field.InternalError(
			path,
			fmt.Errorf("workflow validation client is not configured"),
		)}
		return apierrors.NewInvalid(gk, name, fields)
	}

	resp, err := c.GetWorkflowWithResponse(
		ctx,
		agtName,
		wfName,
		gwreq.RequestEditor(tknPath, ns),
	)
	if err != nil {
		fields := field.ErrorList{field.InternalError(
			path,
			fmt.Errorf("get workflow definition: %w", err),
		)}
		return apierrors.NewInvalid(gk, name, fields)
	}

	if resp.JSON200 == nil {
		message := "referenced workflow could not be loaded"
		if resp.JSON404 != nil {
			message = "referenced workflow was not found"
		}
		if resp.JSON400 != nil && resp.JSON400.Message != "" {
			message = resp.JSON400.Message
		}
		if resp.JSON500 != nil && resp.JSON500.Message != "" {
			message = resp.JSON500.Message
		}

		fields := field.ErrorList{field.Invalid(
			path,
			wfName,
			message,
		)}
		return apierrors.NewInvalid(gk, name, fields)
	}

	issues, err := ValidateValues(raw, resp.JSON200.Inputs, path.String())
	if err != nil {
		fields := field.ErrorList{field.InternalError(
			path,
			fmt.Errorf("validate workflow inputs: %w", err),
		)}
		return apierrors.NewInvalid(gk, name, fields)
	}
	if len(issues) == 0 {
		return nil
	}

	fields := make(field.ErrorList, 0, len(issues))
	for _, issue := range issues {
		fields = append(fields, field.Invalid(
			childPath(path, issue.Field),
			nil,
			issue.Message,
		))
	}
	return apierrors.NewInvalid(gk, name, fields)
}

func childPath(base *field.Path, fullField string) *field.Path {
	relative := strings.TrimPrefix(fullField, base.String())
	relative = strings.TrimPrefix(relative, ".")
	if relative == "" {
		return base
	}

	next := base
	for part := range strings.SplitSeq(relative, ".") {
		next = next.Child(part)
	}
	return next
}
