package observer

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	labelAgentName     = "agentz.accuknox.com/agent"
	labelSinjectorName = "agentz.accuknox.com/sinjector"
	labelManaged       = "agentz.accuknox.com/managed"
	labelAppName       = "app.kubernetes.io/name"
	appNameAgent       = "agentz-agent"
	appNameSinjector   = "agentz-sinjector"
)

type resolver struct {
	client ctrlclient.Client
	mu     sync.RWMutex
	cache  map[string]string
	svcs   serviceCache
}

type serviceCache struct {
	deadline  time.Time
	namesByIP map[string]string
}

func newResolver() (*resolver, error) {
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		return nil, fmt.Errorf("add core scheme: %w", err)
	}
	if err := discoveryv1.AddToScheme(scheme); err != nil {
		return nil, fmt.Errorf("add discovery scheme: %w", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		return nil, fmt.Errorf("add agent scheme: %w", err)
	}

	cfg, err := ctrlconfig.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("get kube config: %w", err)
	}
	c, err := ctrlclient.New(cfg, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create kube client: %w", err)
	}

	return &resolver{
		client: c,
		cache:  map[string]string{},
	}, nil
}

func (r *resolver) resolve(ctx context.Context, namespace string, labels map[string]string, ownerName, podName string) (string, bool) {
	if labels[labelAppName] != appNameAgent || labels[labelManaged] != "true" {
		return "", false
	}

	agentName := labels[labelAgentName]
	if agentName == "" {
		agentName = ownerName
	}
	if agentName == "" {
		agentName = podName
	}
	if agentName == "" {
		return "", false
	}

	return r.resolveAgent(ctx, namespace, agentName)
}

func (r *resolver) resolveNetwork(ctx context.Context, namespace string, labels map[string]string, podName string) (string, bool) {
	if labels[labelManaged] != "true" {
		return "", false
	}

	var agentName string

	switch labels[labelAppName] {
	case appNameAgent:
		agentName = labels[labelAgentName]
		if agentName == "" {
			agentName = podName
		}
	case appNameSinjector:
		agentName = labels[labelSinjectorName]
	default:
		return "", false
	}

	if agentName == "" {
		return "", false
	}

	return r.resolveAgent(ctx, namespace, agentName)
}

func (r *resolver) resolveAgent(ctx context.Context, namespace, agentName string) (string, bool) {
	key := namespace + "/" + agentName
	r.mu.RLock()
	name, ok := r.cache[key]
	r.mu.RUnlock()
	if ok {
		return name, true
	}

	agt := &agentzv1alpha1.Agent{}
	err := r.client.Get(
		ctx,
		ctrlclient.ObjectKey{
			Namespace: namespace,
			Name:      agentName,
		},
		agt,
	)
	if err != nil {
		return "", false
	}

	r.mu.Lock()
	r.cache[key] = agt.Name
	r.mu.Unlock()
	return agt.Name, true
}

func (r *resolver) resolveDestinationDomain(ctx context.Context, ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return ""
	}
	return r.resolveServiceDomain(ctx, ip)
}

func (r *resolver) resolveServiceDomain(ctx context.Context, ip string) string {
	now := time.Now().UTC()

	r.mu.RLock()
	if r.svcs.deadline.After(now) {
		name := r.svcs.namesByIP[ip]
		r.mu.RUnlock()
		return name
	}
	r.mu.RUnlock()

	if r.client == nil {
		return ""
	}

	names, err := r.loadServiceDomains(ctx)
	if err != nil {
		return ""
	}

	r.mu.Lock()
	r.svcs = serviceCache{
		deadline:  now.Add(30 * time.Second),
		namesByIP: names,
	}
	name := r.svcs.namesByIP[ip]
	r.mu.Unlock()
	return name
}

func (r *resolver) loadServiceDomains(ctx context.Context) (map[string]string, error) {
	names := map[string]string{}

	var svcs corev1.ServiceList
	if err := r.client.List(ctx, &svcs); err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}
	for _, svc := range svcs.Items {
		name := serviceFQDN(svc.Namespace, svc.Name)
		for _, ip := range serviceIPs(svc) {
			addPreferredDomain(names, ip, name)
		}
	}

	var eps discoveryv1.EndpointSliceList
	if err := r.client.List(ctx, &eps); err != nil {
		return nil, fmt.Errorf("list endpoint slices: %w", err)
	}
	for _, epSlice := range eps.Items {
		svcName := epSlice.Labels["kubernetes.io/service-name"]
		if svcName == "" {
			continue
		}
		name := serviceFQDN(epSlice.Namespace, svcName)
		for _, ep := range epSlice.Endpoints {
			for _, addr := range ep.Addresses {
				addPreferredDomain(names, addr, name)
			}
		}
	}
	return names, nil
}

func serviceFQDN(namespace, name string) string {
	if namespace == "" || name == "" {
		return ""
	}
	return name + "." + namespace + ".svc.cluster.local"
}

func serviceIPs(svc corev1.Service) []string {
	ips := make([]string, 0, 1+len(svc.Spec.ClusterIPs))
	if ip := strings.TrimSpace(svc.Spec.ClusterIP); ip != "" && ip != "None" {
		ips = append(ips, ip)
	}
	for _, ip := range svc.Spec.ClusterIPs {
		ip = strings.TrimSpace(ip)
		if ip == "" || ip == "None" {
			continue
		}
		ips = append(ips, ip)
	}
	slices.Sort(ips)
	return slices.Compact(ips)
}

func addPreferredDomain(names map[string]string, ip, name string) {
	ip = strings.TrimSpace(ip)
	name = strings.TrimSpace(name)
	if ip == "" || name == "" {
		return
	}
	cur := names[ip]
	if cur == "" || name < cur {
		names[ip] = name
	}
}
