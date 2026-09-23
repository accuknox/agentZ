package helm_test

import (
	"bytes"
	"io"
	"os/exec"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	yamlutil "k8s.io/apimachinery/pkg/util/yaml"
)

func TestRelayDeploymentSeparation(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm is required for chart rendering")
	}
	values := `migrations:
  enabled: false
web:
  enabled: false
gateway:
  replicaCount: 2
  config:
    relayAddress: test-relay:9444
    externalJWTJWKSURL: http://web:3000/jwks
    externalJWTIssuer: https://example.test
    allowedWebOrigins: [https://example.test]
    skillsS3Endpoint: https://s3.example.test
    skillsS3Bucket: skills
relay:
  enabled: true
  publicAddress: hosts.example.test:9443
  config:
    skillsS3Endpoint: https://s3.example.test
    skillsS3Bucket: skills
spire:
  enabled: true
  rootSecret: stable-ca
  publicAddress: spire.example.test:8081
`
	cmd := exec.CommandContext(t.Context(), "helm", "template", "test", ".", "--namespace", "agentz-system", "-f", "-")
	cmd.Stdin = strings.NewReader(values)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("render chart: %v\n%s", err, output)
	}
	for _, override := range []string{
		"spire.enabled=false", "spire.rootSecret=", "gateway.config.relayAddress=",
		"gateway.config.relayTrustDomain=wrong.example", "relay.replicaCount=0", "relay.replicaCount=2",
		"manager.config.relayServiceAccountName=gateway", "manager.config.relayServiceAccountNamespace=foreign",
	} {
		t.Run(override, func(t *testing.T) {
			cmd := exec.CommandContext(t.Context(), "helm", "template", "test", ".", "--namespace", "agentz-system", "-f", "-", "--set", override)
			cmd.Stdin = strings.NewReader(values)
			if output, err := cmd.CombinedOutput(); err == nil {
				t.Fatalf("unsafe deployment accepted: %s", output)
			}
		})
	}

	decoder := yamlutil.NewYAMLOrJSONDecoder(bytes.NewReader(output), 4096)
	var gateway appsv1.Deployment
	var relay, spire appsv1.StatefulSet
	var gatewayRole rbacv1.ClusterRole
	var relayRole rbacv1.ClusterRole
	var hostService, controlService corev1.Service
	certificates := map[string]string{}
	for {
		obj := &unstructured.Unstructured{}
		err := decoder.Decode(obj)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		var target any
		switch obj.GetKind() + "/" + obj.GetName() {
		case "Deployment/test-gateway":
			target = &gateway
		case "StatefulSet/test-relay":
			target = &relay
		case "StatefulSet/test-spire":
			target = &spire
		case "ClusterRole/test-gateway":
			target = &gatewayRole
		case "ClusterRole/test-relay":
			target = &relayRole
		case "Service/test-relay":
			target = &controlService
		case "Service/test-relay-hosts":
			target = &hostService
		}
		if target != nil {
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, target); err != nil {
				t.Fatal(err)
			}
		}
		if obj.GetKind() == "Certificate" {
			uris, _, err := unstructured.NestedStringSlice(obj.Object, "spec", "uris")
			if err != nil {
				t.Fatal(err)
			}
			if len(uris) == 1 {
				certificates[obj.GetName()] = uris[0]
			}
		}
	}
	for _, template := range []corev1.PodTemplateSpec{gateway.Spec.Template, relay.Spec.Template} {
		if len(template.Spec.Containers) != 1 {
			t.Fatal("gateway or relay embeds another service")
		}
		for _, volume := range template.Spec.Volumes {
			if volume.PersistentVolumeClaim != nil || (volume.Secret != nil && volume.Secret.SecretName == "stable-ca") {
				t.Fatal("gateway or relay mounts SPIRE signing state")
			}
		}
	}
	if gateway.Spec.Replicas == nil || *gateway.Spec.Replicas != 2 {
		t.Fatal("gateway must support multiple replicas")
	}
	if relay.Spec.Replicas == nil || *relay.Spec.Replicas != 1 || relay.Spec.ServiceName != "test-relay" {
		t.Fatal("relay must use a singleton StatefulSet with its governing Service")
	}
	if gateway.Spec.Template.Spec.ServiceAccountName == relay.Spec.Template.Spec.ServiceAccountName {
		t.Fatal("gateway and relay share a ServiceAccount")
	}
	if spire.Spec.Replicas == nil || *spire.Spec.Replicas != 1 || len(spire.Spec.VolumeClaimTemplates) != 1 {
		t.Fatal("SPIRE must have one replica and persistent state")
	}
	if len(spire.Spec.Template.Spec.Containers) != 2 {
		t.Fatal("SPIRE requires its singleton authority-maintenance sidecar")
	}
	maintenance := spire.Spec.Template.Spec.Containers[1]
	if maintenance.Name != "authority-maintenance" || len(maintenance.Ports) != 0 || len(maintenance.VolumeMounts) != 1 || maintenance.VolumeMounts[0].Name != "socket" {
		t.Fatal("authority maintenance must share only the private SPIRE socket")
	}

	if spire.Spec.PersistentVolumeClaimRetentionPolicy == nil || spire.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		t.Fatal("SPIRE PVC is not retained")
	}
	if controlService.Spec.ClusterIP != corev1.ClusterIPNone || len(controlService.Spec.Ports) != 1 || controlService.Spec.Ports[0].Port != 9444 {
		t.Fatal("relay requires a headless internal control Service")
	}
	if len(hostService.Spec.Ports) != 1 || hostService.Spec.Ports[0].Port != 9443 {
		t.Fatal("public host service exposes internal control")
	}
	statusAccess := false
	for _, rule := range gatewayRole.Rules {
		for _, resource := range rule.Resources {
			if resource == "agents/status" {
				for _, verb := range rule.Verbs {
					if verb == "patch" {
						statusAccess = true
					}
				}
			}
			if resource == "serviceaccounts/token" {
				t.Fatal("gateway can mint host ServiceAccount tokens")
			}
		}
	}
	if !statusAccess {
		t.Fatal("gateway must clear native Agent status during revocation")
	}
	tokenAccess := false
	for _, rule := range relayRole.Rules {
		for _, resource := range rule.Resources {
			if resource == "serviceaccounts/token" {
				tokenAccess = true
			}
		}
	}
	if !tokenAccess {
		t.Fatal("relay lacks host ServiceAccount token permission")
	}
	if certificates["test-relay-identity"] != "spiffe://agentz.local/agentz/relay-admin" || certificates["test-gateway-relay-client"] != "spiffe://agentz.local/agentz/gateway" {
		t.Fatalf("incorrect service identities: %v", certificates)
	}
	for _, args := range [][]string{gateway.Spec.Template.Spec.Containers[0].Args, relay.Spec.Template.Spec.Containers[0].Args} {
		for _, arg := range args {
			if strings.HasPrefix(arg, "--compute-") || strings.HasPrefix(arg, "--advertise-address=") {
				t.Fatalf("obsolete flag: %s", arg)
			}
		}
	}
}
