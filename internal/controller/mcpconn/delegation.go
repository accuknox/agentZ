package mcpconn

import (
	"context"
	"slices"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
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

func (r *ExtAuthRuntimeReconciler) reconcileDelegationRuntime(ctx context.Context, namespace *corev1.Namespace) error {
	ns := namespace.Name
	ownerRefs := []metav1.OwnerReference{
		*metav1.NewControllerRef(namespace, corev1.SchemeGroupVersion.WithKind("Namespace")),
	}
	routes := &gwv1.HTTPRouteList{}
	err := r.List(ctx, routes, client.InNamespace(ns))
	if err != nil {
		return err
	}
	delegated := slices.ContainsFunc(routes.Items, func(route gwv1.HTTPRoute) bool {
		_, delegated := route.Labels[authorization.DelegationLabel]
		return delegated
	})
	backend := &agw.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "delegation-extauth",
			Namespace: ns,
		},
	}
	if delegated {
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, backend, func() error {
			backend.OwnerReferences = ownerRefs
			backend.Spec = agw.AgentgatewayBackendSpec{
				Static: &agw.StaticBackend{Host: "extauth." + ns + ".svc.cluster.local", Port: 18084},
			}
			return nil
		})
	}
	if !delegated {
		err = client.IgnoreNotFound(r.Delete(ctx, backend))
	}
	if err != nil {
		return err
	}
	gateways := []*gwv1.Gateway{inference.Gateway(ns), mcp.Gateway(ns)}
	for _, desired := range gateways {
		var needed, consumed bool
		for _, route := range routes.Items {
			attached := slices.ContainsFunc(route.Spec.ParentRefs, func(parent gwv1.ParentReference) bool {
				return parent.Name == gwv1.ObjectName(desired.Name)
			})
			if !attached {
				continue
			}
			consumed = true
			_, delegated := route.Labels[authorization.DelegationLabel]
			needed = needed || delegated
		}
		gateway := &gwv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: desired.Name, Namespace: ns}}
		err := r.Get(ctx, client.ObjectKeyFromObject(gateway), gateway)
		missing := apierrors.IsNotFound(err)
		if err != nil && !missing {
			return err
		}
		if !needed {
			if !consumed {
				if err := client.IgnoreNotFound(r.Delete(ctx, gateway)); err != nil {
					return err
				}
				parameters := &agw.AgentgatewayParameters{
					ObjectMeta: metav1.ObjectMeta{
						Name:      desired.Spec.Infrastructure.ParametersRef.Name,
						Namespace: ns,
					},
				}
				if err := client.IgnoreNotFound(r.Delete(ctx, parameters)); err != nil {
					return err
				}
				continue
			}
			if missing {
				continue
			}
			patch := client.MergeFrom(gateway.DeepCopy())
			gateway.Spec.Listeners = slices.DeleteFunc(gateway.Spec.Listeners, func(listener gwv1.Listener) bool {
				return listener.Name == "delegation"
			})
			if err := r.Patch(ctx, gateway, patch); err != nil {
				return err
			}
			continue
		}
		parameters := &agw.AgentgatewayParameters{
			ObjectMeta: metav1.ObjectMeta{
				Name:      desired.Spec.Infrastructure.ParametersRef.Name,
				Namespace: ns,
			},
		}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, parameters, func() error {
			parameters.OwnerReferences = ownerRefs
			if parameters.CreationTimestamp.IsZero() {
				parameters.Spec.Service = &agw.KubernetesResourceOverlay{
					Spec: &apiextensionsv1.JSON{
						Raw: []byte(`{"type":"ClusterIP"}`),
					},
				}
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
			gateway.OwnerReferences = ownerRefs
			gateway.Spec.Listeners = slices.DeleteFunc(gateway.Spec.Listeners, func(listener gwv1.Listener) bool {
				return listener.Name == "delegation"
			})
			gateway.Spec.Listeners = append(gateway.Spec.Listeners, gwv1.Listener{
				Name:     "delegation",
				Port:     8080,
				Protocol: gwv1.HTTPProtocolType,
			})
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}
