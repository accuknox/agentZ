package guardrail

import (
	"net/http"
	"net/http/httptest"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	eso "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	baoapi "github.com/openbao/openbao/api/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/accuknox/agentz/internal/guardrails"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestConnectionDeletionRemovesAllProjectionsBeforeCredentials(t *testing.T) {
	scheme := runtime.NewScheme()
	additions := []func(*runtime.Scheme) error{api.AddToScheme, corev1.AddToScheme, agw.Install, eso.AddToScheme}
	for _, add := range additions {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	connection := &api.GuardrailConnection{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "detector",
			Namespace:  "source",
			UID:        "detector-uid",
			Finalizers: []string{api.GuardrailConnectionFinalizer},
		},
		Spec: api.GuardrailConnectionSpec{
			DisplayName: "Detector",
			Provider:    "Webhook",
			Endpoint:    "https://guardrail.example",
			SecretName:  "credentials",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(connection).Build()
	bundle := &guardrails.Bundle{Connections: []*api.GuardrailConnection{connection}}
	name := guardrails.ConnectionRuntimeName(connection)
	for _, namespace := range []string{"source", "consumer-one", "consumer-two"} {
		if _, err := bundle.ProjectConnections(t.Context(), c, namespace, "store"); err != nil {
			t.Fatal(err)
		}
		// Another workload in the same namespace reuses the same transport.
		if _, err := bundle.ProjectConnections(t.Context(), c, namespace, "store"); err != nil {
			t.Fatal(err)
		}
		external := &eso.ExternalSecret{}
		err := c.Get(t.Context(), client.ObjectKey{Namespace: namespace, Name: name}, external)
		if err != nil {
			t.Fatal(err)
		}
		if len(external.OwnerReferences) != 0 || external.Spec.Target.Template.Metadata.Labels[guardrails.ConnectionUIDLabel] != string(connection.UID) {
			t.Fatal("shared credential projection must follow connection identity, not a consumer owner")
		}
		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Namespace: namespace,
				Name:      name,
				Labels:    external.Spec.Target.Template.Metadata.Labels,
			},
		}
		if err := c.Create(t.Context(), secret); err != nil {
			t.Fatal(err)
		}
	}
	foreign := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "consumer-one",
			Name:      "unrelated",
			Labels:    map[string]string{guardrails.ConnectionUIDLabel: "other-connection-uid"},
		},
	}
	if err := c.Create(t.Context(), foreign); err != nil {
		t.Fatal(err)
	}
	credentialDeletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/secret/metadata/source/guardrail-connections/detector" {
			t.Errorf("unexpected credential cleanup %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		credentialDeletes++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	bao, err := baoapi.NewClient(&baoapi.Config{Address: server.URL, HttpClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	r := &ConnectionReconciler{Client: c, Bao: bao, OpenBaoSecretMountPath: "secret"}
	request := ctrl.Request{NamespacedName: client.ObjectKeyFromObject(connection)}
	if err := c.Delete(t.Context(), connection); err != nil {
		t.Fatal(err)
	}
	result, err := r.Reconcile(t.Context(), request)
	if err != nil || result.RequeueAfter == 0 || credentialDeletes != 0 {
		t.Fatalf("projection cleanup must finish before credentials: result=%+v deletes=%d err=%v", result, credentialDeletes, err)
	}
	for _, namespace := range []string{"source", "consumer-one", "consumer-two"} {
		key := client.ObjectKey{Namespace: namespace, Name: name}
		objects := []client.Object{&agw.AgentgatewayBackend{}, &eso.ExternalSecret{}, &corev1.Secret{}}
		for _, object := range objects {
			if err := c.Get(t.Context(), key, object); !apierrors.IsNotFound(err) {
				t.Fatalf("projection remains %T %s: %v", object, key, err)
			}
		}
	}
	if _, err := bundle.ProjectConnections(t.Context(), c, "late-consumer", "store"); err == nil {
		t.Fatal("a deleting connection must not recreate projections")
	}
	if _, err := r.Reconcile(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	if credentialDeletes != 1 {
		t.Fatalf("expected one credential cleanup, got %d", credentialDeletes)
	}
	err = c.Get(t.Context(), request.NamespacedName, &api.GuardrailConnection{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("connection finalizer was not released: %v", err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(foreign), &corev1.Secret{}); err != nil {
		t.Fatalf("unrelated connection credentials were deleted: %v", err)
	}
}
