package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (r *Reconciler) reconcileBrowser(ctx context.Context, agt *agentzv1alpha1.Agent) error {
	if !agt.Spec.Browser.Enabled {
		return nil
	}
	if r.Config.BrowserImage == "" {
		return fmt.Errorf("browser image is not configured")
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name: agt.Name + agentzv1alpha1.BrowserSecretSuffix, Namespace: agt.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, secret, func() error {
		if len(secret.Data["token"]) == 0 {
			token := make([]byte, 32)
			if _, err := rand.Read(token); err != nil {
				return err
			}
			secret.Data = map[string][]byte{"token": []byte(hex.EncodeToString(token))}
		}
		return ctrl.SetControllerReference(agt, secret, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile browser credential: %w", err)
	}
	return nil
}

func (r *Reconciler) addBrowser(agt *agentzv1alpha1.Agent, deployment *appsv1.Deployment) {
	pod := &deployment.Spec.Template.Spec
	pod.Volumes = append(pod.Volumes,
		corev1.Volume{
			Name: "browser-auth",
			VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
				SecretName: agt.Name + agentzv1alpha1.BrowserSecretSuffix, DefaultMode: new(int32(0440)),
			}},
		},
		corev1.Volume{
			Name: "browser-tmp",
			VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{
				SizeLimit: new(resource.MustParse("1Gi")),
			}},
		},
		corev1.Volume{
			Name: "browser-shm",
			VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{
				Medium: corev1.StorageMediumMemory, SizeLimit: new(resource.MustParse("256Mi")),
			}},
		},
	)
	pod.InitContainers = append(pod.InitContainers, corev1.Container{
		Name: "browser-profile", Image: r.Config.BrowserImage,
		Command: []string{"node", "-e", "require('node:fs').mkdirSync('/pvc/browser', {recursive:true,mode:448})"},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot: new(true), RunAsUser: new(agentRuntimeUID),
			ReadOnlyRootFilesystem: new(true), AllowPrivilegeEscalation: new(false),
			Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
		VolumeMounts: []corev1.VolumeMount{{Name: nixAgentVolume, MountPath: "/pvc"}},
	})
	agent := &pod.Containers[0]
	agent.Env = append(agent.Env, corev1.EnvVar{
		Name: "AGENTZ_BROWSER_TOKEN_PATH", Value: "/var/run/agentz/browser/token",
	})
	agent.VolumeMounts = append(agent.VolumeMounts, corev1.VolumeMount{
		Name: "browser-auth", MountPath: "/var/run/agentz/browser", ReadOnly: true,
	})
	health := corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{
		"node", "-e", "fetch('http://127.0.0.1:4098/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
	}}}
	seccomp := &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}
	if r.Config.BrowserSeccompProfile != "" {
		seccomp = &corev1.SeccompProfile{
			Type: corev1.SeccompProfileTypeLocalhost, LocalhostProfile: &r.Config.BrowserSeccompProfile,
		}
	}
	pod.Containers = append(pod.Containers, corev1.Container{
		Name: "browser", Image: r.Config.BrowserImage, ImagePullPolicy: corev1.PullIfNotPresent,
		Env: []corev1.EnvVar{
			{Name: "BROWSER_TOKEN_PATH", Value: "/var/run/agentz/browser/token"},
			{Name: "BROWSER_DATA", Value: "/var/lib/browser"},
			{Name: "BROWSER_HOST", Value: agt.Name + "." + agt.Namespace + ".svc.cluster.local"},
		},
		Ports: []corev1.ContainerPort{{Name: "browser", ContainerPort: agentzv1alpha1.BrowserPort}},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot: new(true), RunAsUser: new(agentRuntimeUID), RunAsGroup: new(agentRuntimeGID),
			ReadOnlyRootFilesystem: new(true), SeccompProfile: seccomp, AllowPrivilegeEscalation: new(false),
			Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "browser-auth", MountPath: "/var/run/agentz/browser", ReadOnly: true},
			{Name: nixAgentVolume, MountPath: "/var/lib/browser", SubPath: "browser"},
			{Name: "browser-tmp", MountPath: "/tmp"},
			{Name: "browser-shm", MountPath: "/dev/shm"},
		},
		ReadinessProbe: &corev1.Probe{ProbeHandler: health, PeriodSeconds: 10, TimeoutSeconds: 3},
		StartupProbe: &corev1.Probe{
			ProbeHandler: health, PeriodSeconds: 5, TimeoutSeconds: 3, FailureThreshold: 30,
		},
	})
}
