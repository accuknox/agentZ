package mcpconn

import (
	"context"
	"errors"
	"fmt"
	"slices"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	cmapi "github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1"
	cmmeta "github.com/cert-manager/cert-manager/pkg/apis/meta/v1"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
)

func (r *ExtAuthRuntimeReconciler) reconcileDelegationRuntime(ctx context.Context, namespace *corev1.Namespace, scope extAuthScope) error {
	if r.DelegationIssuerName == "" {
		return errors.New("delegation workload ClusterIssuer is required")
	}
	ns := namespace.Name
	for _, name := range []string{"delegation-extauth-tls", "delegation-gateway-tls"} {
		dnsNames := []string{"extauth." + ns + ".svc"}
		if name == "delegation-gateway-tls" {
			dnsNames = []string{"mcp." + ns + ".svc", "inference." + ns + ".svc"}
		}
		for _, name := range dnsNames {
			dnsNames = append(dnsNames, name+".cluster.local")
		}
		certificate := &cmapi.Certificate{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
		_, err := ctrlutil.CreateOrPatch(ctx, r.Client, certificate, func() error {
			certificate.OwnerReferences = scope.ownerRefs
			certificate.Spec = cmapi.CertificateSpec{
				SecretName: name, DNSNames: dnsNames,
				IssuerRef:  cmmeta.IssuerReference{Group: "cert-manager.io", Kind: "ClusterIssuer", Name: r.DelegationIssuerName},
				Usages:     []cmapi.KeyUsage{cmapi.UsageServerAuth, cmapi.UsageClientAuth},
				PrivateKey: &cmapi.CertificatePrivateKey{Algorithm: cmapi.ECDSAKeyAlgorithm, Size: 256, RotationPolicy: cmapi.RotationPolicyAlways},
			}
			return nil
		})
		if err != nil {
			return fmt.Errorf("reconcile owner delegation certificate: %w", err)
		}
	}
	secret := &corev1.Secret{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: "delegation-gateway-tls"}, secret)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	ca := secret.Data["ca.crt"]
	if len(ca) == 0 {
		return errors.New("delegation certificate CA is not ready")
	}
	config := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "delegation-ca", Namespace: ns}}
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, config, func() error {
		config.OwnerReferences = scope.ownerRefs
		config.Data = map[string]string{"ca.crt": string(ca)}
		return nil
	})
	if err != nil {
		return err
	}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metav1.ObjectMeta{Name: "delegation-extauth", Namespace: ns}}
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, backend, func() error {
		backend.OwnerReferences = scope.ownerRefs
		backend.Spec = agw.AgentgatewayBackendSpec{
			Static: &agw.StaticBackend{Host: "extauth." + ns + ".svc.cluster.local", Port: 18084},
			Policies: &agw.BackendFull{BackendSimple: agw.BackendSimple{TLS: &agw.BackendTLS{
				CACertificateRefs:  []corev1.LocalObjectReference{{Name: "delegation-ca"}},
				MtlsCertificateRef: []agw.LocalSecretObjectRef{{Name: "delegation-gateway-tls"}},
			}}},
		}
		return nil
	})
	if err != nil {
		return err
	}
	routes := &gwv1.HTTPRouteList{}
	if err := r.List(ctx, routes, client.InNamespace(ns), client.HasLabels{authorization.DelegationLabel}); err != nil {
		return err
	}
	for _, desired := range []*gwv1.Gateway{inference.Gateway(ns), mcp.Gateway(ns)} {
		needed := slices.ContainsFunc(routes.Items, func(route gwv1.HTTPRoute) bool {
			return slices.ContainsFunc(route.Spec.ParentRefs, func(parent gwv1.ParentReference) bool { return parent.Name == gwv1.ObjectName(desired.Name) })
		})
		gateway := &gwv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: desired.Name, Namespace: ns}}
		err := r.Get(ctx, client.ObjectKeyFromObject(gateway), gateway)
		if apierrors.IsNotFound(err) && !needed {
			continue
		}
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		if !needed {
			patch := client.MergeFrom(gateway.DeepCopy())
			gateway.Spec.Listeners = slices.DeleteFunc(gateway.Spec.Listeners, func(listener gwv1.Listener) bool { return listener.Name == "delegation" })
			sandboxes := &gwv1.HTTPRouteList{}
			if err := r.List(ctx, sandboxes, client.InNamespace(ns)); err != nil {
				return err
			}
			consumed := slices.ContainsFunc(sandboxes.Items, func(route gwv1.HTTPRoute) bool {
				return slices.ContainsFunc(route.Spec.ParentRefs, func(parent gwv1.ParentReference) bool { return parent.Name == gwv1.ObjectName(desired.Name) })
			})
			if !consumed {
				if err := client.IgnoreNotFound(r.Delete(ctx, gateway)); err != nil {
					return err
				}
				parameters := &agw.AgentgatewayParameters{ObjectMeta: metav1.ObjectMeta{Name: desired.Spec.Infrastructure.ParametersRef.Name, Namespace: ns}}
				if err := client.IgnoreNotFound(r.Delete(ctx, parameters)); err != nil {
					return err
				}
				continue
			}
			if err := r.Patch(ctx, gateway, patch); err != nil {
				return err
			}
			continue
		}
		parameters := &agw.AgentgatewayParameters{ObjectMeta: metav1.ObjectMeta{Name: desired.Spec.Infrastructure.ParametersRef.Name, Namespace: ns}}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, parameters, func() error {
			parameters.OwnerReferences = scope.ownerRefs
			if parameters.CreationTimestamp.IsZero() {
				parameters.Spec.Service = &agw.KubernetesResourceOverlay{Spec: &apiextensionsv1.JSON{Raw: []byte(`{"type":"ClusterIP"}`)}}
			}
			return nil
		})
		if err != nil {
			return err
		}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, gateway, func() error {
			if gateway.CreationTimestamp.IsZero() {
				gateway.Spec = desired.Spec
			}
			gateway.OwnerReferences = scope.ownerRefs
			gateway.Spec.Listeners = slices.DeleteFunc(gateway.Spec.Listeners, func(listener gwv1.Listener) bool { return listener.Name == "delegation" })
			gateway.Spec.Listeners = append(gateway.Spec.Listeners, gwv1.Listener{
				Name: "delegation", Port: 8443, Protocol: gwv1.HTTPSProtocolType,
				TLS: &gwv1.ListenerTLSConfig{Mode: new(gwv1.TLSModeTerminate), CertificateRefs: []gwv1.SecretObjectReference{{Name: "delegation-gateway-tls"}}},
			})
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}
