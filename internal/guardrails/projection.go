package guardrails

import (
	"context"
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	eso "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/networkpolicy"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ConnectionUIDLabel identifies projections belonging to one immutable detector connection.
const ConnectionUIDLabel = "agentz.accuknox.com/guardrail-connection-uid"

// Rebind moves detector transport references into the gateway's runtime namespace.
func (b *Bundle) Rebind(namespace string) {
	if b.Guard == nil {
		return
	}
	for i := range b.Guard.Request {
		if b.Guard.Request[i].Webhook != nil {
			b.Guard.Request[i].Webhook.BackendRef.Namespace = new(gwv1.Namespace(namespace))
		}
	}
	for i := range b.Guard.Response {
		if b.Guard.Response[i].Webhook != nil {
			b.Guard.Response[i].Webhook.BackendRef.Namespace = new(gwv1.Namespace(namespace))
		}
	}
}

// ProjectConnections materializes detector transports and scoped credential projections.
func (b *Bundle) ProjectConnections(ctx context.Context, c client.Client, namespace, storeName string) ([]networkpolicy.Target, error) {
	targets := []networkpolicy.Target{}
	for _, connection := range b.Connections {
		live := &api.GuardrailConnection{}
		if err := c.Get(ctx, client.ObjectKeyFromObject(connection), live); err != nil {
			return nil, fmt.Errorf("resolve detector connection before projection: %w", err)
		}
		finalized := slices.Contains(live.Finalizers, api.GuardrailConnectionFinalizer)
		if connection.UID == "" || live.UID != connection.UID || !live.DeletionTimestamp.IsZero() || !finalized {
			return nil, fmt.Errorf("guardrail connection %s/%s is not available for projection", connection.Namespace, connection.Name)
		}
		labels := map[string]string{ConnectionUIDLabel: string(connection.UID)}
		name := ConnectionRuntimeName(connection)
		if connection.Spec.SecretName != "" {
			desired := &eso.ExternalSecret{
				ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
			}
			_, err := ctrlutil.CreateOrPatch(ctx, c, desired, func() error {
				if desired.ResourceVersion != "" && desired.Labels[ConnectionUIDLabel] != string(connection.UID) {
					return fmt.Errorf("credential projection %s/%s belongs to another resource", namespace, name)
				}
				desired.Labels = maps.Clone(desired.Labels)
				if desired.Labels == nil {
					desired.Labels = map[string]string{}
				}
				maps.Copy(desired.Labels, labels)
				// Credential projections are shared within this runtime namespace. They are
				// keyed by the connection's immutable source scope rather than a consumer.
				desired.Spec = eso.ExternalSecretSpec{
					SecretStoreRef: eso.SecretStoreRef{Name: storeName, Kind: eso.ClusterSecretStoreKind},
					Target: eso.ExternalSecretTarget{
						Name:           name,
						CreationPolicy: eso.CreatePolicyOwner,
						DeletionPolicy: eso.DeletionPolicyDelete,
						Template: &eso.ExternalSecretTemplate{
							Metadata: eso.ExternalSecretTemplateMetadata{Labels: labels},
						},
					},
					RefreshPolicy:   eso.RefreshPolicyPeriodic,
					RefreshInterval: &metav1.Duration{Duration: time.Minute},
					DataFrom: []eso.ExternalSecretDataFromRemoteRef{
						{
							Extract: &eso.ExternalSecretDataRemoteRef{
								Key: connection.CredentialPath(),
							},
						},
					},
				}
				return nil
			})
			if err != nil {
				return nil, fmt.Errorf("project guardrail credentials: %w", err)
			}
		}
		switch connection.Spec.Provider {
		case "OpenAI":
			targets = append(targets, networkpolicy.Target{Host: "api.openai.com", Port: 443})
		case "Bedrock":
			targets = append(targets, networkpolicy.Target{
				Host: "bedrock-runtime." + connection.Spec.Region + ".amazonaws.com",
				Port: 443,
			})
		case "ModelArmor":
			for _, check := range b.Checks {
				if check.Connection == nil || check.Connection.Name != connection.Name || check.Connection.Namespace != connection.Namespace {
					continue
				}
				parts := strings.Split(check.Check.Template, "/")
				if len(parts) == 6 {
					targets = append(targets, networkpolicy.Target{
						Host: "modelarmor." + parts[3] + ".rep.googleapis.com",
						Port: 443,
					})
				}
			}
			targets = append(targets, networkpolicy.Target{Host: "oauth2.googleapis.com", Port: 443})
		case "Webhook":
			endpoint, err := url.Parse(connection.Spec.Endpoint)
			if err != nil {
				return nil, err
			}
			port := int32(80)
			if endpoint.Scheme == "https" {
				port = 443
			}
			if endpoint.Port() != "" {
				value, err := strconv.ParseInt(endpoint.Port(), 10, 32)
				if err != nil {
					return nil, err
				}
				port = int32(value)
			}
			targets = append(targets, networkpolicy.Target{Host: endpoint.Hostname(), Port: port})
			backend := &agw.AgentgatewayBackend{
				ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
			}
			_, err = ctrlutil.CreateOrPatch(ctx, c, backend, func() error {
				if backend.ResourceVersion != "" && backend.Labels[ConnectionUIDLabel] != string(connection.UID) {
					return fmt.Errorf("detector backend %s/%s belongs to another resource", namespace, name)
				}
				backend.Labels = maps.Clone(backend.Labels)
				if backend.Labels == nil {
					backend.Labels = map[string]string{}
				}
				maps.Copy(backend.Labels, labels)
				backend.Spec = agw.AgentgatewayBackendSpec{
					Static: &agw.StaticBackend{Host: endpoint.Hostname(), Port: port},
				}
				if endpoint.Scheme == "https" || connection.Spec.SecretName != "" {
					backend.Spec.Policies = &agw.BackendFull{}
				}
				if endpoint.Scheme == "https" {
					backend.Spec.Policies.TLS = &agw.BackendTLS{}
				}
				if connection.Spec.SecretName != "" {
					backend.Spec.Policies.Auth = &agw.BackendAuth{
						SecretRef: &agw.LocalSecretKeyRef{Name: gwv1.ObjectName(name), Key: new("token")},
					}
				}
				return nil
			})
			if err != nil {
				return nil, fmt.Errorf("project custom guardrail backend: %w", err)
			}
		}
	}
	return targets, nil
}
