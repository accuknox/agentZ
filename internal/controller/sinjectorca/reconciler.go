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

// Package sinjectorca reconciles the namespace-local sinjector certificate.
package sinjectorca

import (
	"context"
	"errors"
	"fmt"

	cmapi "github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1"
	cmmeta "github.com/cert-manager/cert-manager/pkg/apis/meta/v1"
	cmclientset "github.com/cert-manager/cert-manager/pkg/client/clientset/versioned"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ErrOwnershipConflict means the certificate name is controlled by another
// resource and cannot be adopted safely.
var ErrOwnershipConflict = errors.New("sinjector certificate has a foreign controller")

// Config identifies one namespace certificate and its stable controller owner.
type Config struct {
	Name      string
	Namespace string
	Issuer    string
	Labels    map[string]string
	Owner     metav1.OwnerReference
}

// Reconcile converges one namespace CA and reports whether cert-manager has
// issued it. A foreign controller owner is never adopted.
func Reconcile(ctx context.Context, client cmclientset.Interface, cfg Config) (bool, error) {
	certs := client.CertmanagerV1().Certificates(cfg.Namespace)
	current, err := certs.Get(ctx, cfg.Name, metav1.GetOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return false, fmt.Errorf("get sinjector certificate: %w", err)
	}
	if apierrors.IsNotFound(err) {
		current = &cmapi.Certificate{
			ObjectMeta: metav1.ObjectMeta{
				Name:      cfg.Name,
				Namespace: cfg.Namespace,
			},
		}
	}
	for _, owner := range current.OwnerReferences {
		if owner.Controller != nil && *owner.Controller && owner.UID != cfg.Owner.UID {
			return false, ErrOwnershipConflict
		}
	}

	desired := current.DeepCopy()
	desired.Labels = cfg.Labels
	desired.OwnerReferences = []metav1.OwnerReference{cfg.Owner}
	desired.Spec = cmapi.CertificateSpec{
		CommonName: cfg.Name,
		SecretName: cfg.Name,
		IssuerRef: cmmeta.IssuerReference{
			Name:  cfg.Issuer,
			Kind:  "ClusterIssuer",
			Group: "cert-manager.io",
		},
		IsCA: true,
		Usages: []cmapi.KeyUsage{
			cmapi.UsageCertSign,
			cmapi.UsageCRLSign,
			cmapi.UsageDigitalSignature,
			cmapi.UsageKeyEncipherment,
		},
		PrivateKey: &cmapi.CertificatePrivateKey{
			Algorithm:      cmapi.RSAKeyAlgorithm,
			Encoding:       cmapi.PKCS1,
			RotationPolicy: cmapi.RotationPolicyAlways,
			Size:           2048,
		},
	}

	if apierrors.IsNotFound(err) {
		_, err = certs.Create(ctx, desired, metav1.CreateOptions{})
		if err != nil {
			return false, fmt.Errorf("create sinjector certificate: %w", err)
		}
		return false, nil
	}
	labelsChanged := !apiequality.Semantic.DeepEqual(current.Labels, desired.Labels)
	ownersChanged := !apiequality.Semantic.DeepEqual(current.OwnerReferences, desired.OwnerReferences)
	specChanged := !apiequality.Semantic.DeepEqual(current.Spec, desired.Spec)
	if labelsChanged || ownersChanged || specChanged {
		_, err = certs.Update(ctx, desired, metav1.UpdateOptions{})
		if err != nil {
			return false, fmt.Errorf("update sinjector certificate: %w", err)
		}
		return false, nil
	}
	for _, condition := range current.Status.Conditions {
		if condition.Type == cmapi.CertificateConditionReady && condition.Status == cmmeta.ConditionTrue {
			return true, nil
		}
	}
	return false, nil
}
