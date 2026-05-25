/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package workflowtrigger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const pollInterval = 2 * time.Second

// Config defines one CronJob-triggered WorkflowRun request.
type Config struct {
	Namespace      string
	ScheduleName   string
	AgentName      string
	WorkflowName   string
	InputsJSON     string
	TimeoutSeconds int32
}

// RunSchedule creates a WorkflowRun and waits for its terminal status.
func RunSchedule(ctx context.Context, cfg Config) error {
	rawInputs := json.RawMessage("null")
	if cfg.InputsJSON != "" {
		rawInputs = json.RawMessage(cfg.InputsJSON)
	}
	if !json.Valid(rawInputs) {
		return fmt.Errorf("inputs json is invalid")
	}

	scheme := runtime.NewScheme()
	err := clawarmorv1alpha1.AddToScheme(scheme)
	if err != nil {
		return fmt.Errorf("add clawarmor scheme: %w", err)
	}

	restCfg, err := ctrl.GetConfig()
	if err != nil {
		return fmt.Errorf("get kubernetes config: %w", err)
	}
	k8sClient, err := client.New(restCfg, client.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create kubernetes client: %w", err)
	}

	schedule := &clawarmorv1alpha1.WorkflowSchedule{}
	err = k8sClient.Get(ctx, types.NamespacedName{
		Namespace: cfg.Namespace,
		Name:      cfg.ScheduleName,
	}, schedule)
	if err != nil {
		return fmt.Errorf("get workflow schedule: %w", err)
	}

	run := &clawarmorv1alpha1.WorkflowRun{
		ObjectMeta: metav1.ObjectMeta{
			Namespace:    cfg.Namespace,
			GenerateName: "wfs-" + cfg.ScheduleName + "-",
			Labels: map[string]string{
				"clawarmor.accuknox.com/workflow-schedule": cfg.ScheduleName,
			},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					schedule,
					clawarmorv1alpha1.SchemeGroupVersion.WithKind("WorkflowSchedule"),
				),
			},
		},
		Spec: clawarmorv1alpha1.WorkflowRunSpec{
			AgentName:      cfg.AgentName,
			WorkflowName:   cfg.WorkflowName,
			Inputs:         apiextensionsv1.JSON{Raw: rawInputs},
			TimeoutSeconds: cfg.TimeoutSeconds,
			ScheduleRef: &corev1.LocalObjectReference{
				Name: cfg.ScheduleName,
			},
		},
	}

	err = k8sClient.Create(ctx, run)
	if err != nil {
		return fmt.Errorf("create workflow run: %w", err)
	}

	waitCtx, cancel := context.WithTimeout(
		ctx,
		time.Duration(cfg.TimeoutSeconds+300)*time.Second,
	)
	defer cancel()

	run, err = waitForRun(waitCtx, k8sClient, client.ObjectKeyFromObject(run))
	if err != nil {
		return fmt.Errorf("wait for workflow run: %w", err)
	}
	if run.Status.Phase == clawarmorv1alpha1.WorkflowRunPhaseSucceeded {
		return nil
	}

	msg := run.Status.Message
	if msg == "" {
		msg = "workflow run failed"
	}
	return errors.New(msg)
}

func waitForRun(ctx context.Context, k8sClient client.Client, key types.NamespacedName) (*clawarmorv1alpha1.WorkflowRun, error) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		run := &clawarmorv1alpha1.WorkflowRun{}
		err := k8sClient.Get(ctx, key, run)
		if err != nil {
			if apierrors.IsNotFound(err) {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-ticker.C:
					continue
				}
			}
			return nil, fmt.Errorf("get workflow run: %w", err)
		}
		if run.Status.Phase.Terminal() {
			return run, nil
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
