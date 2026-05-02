package gateway

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/tools/cache"
	ctrl "sigs.k8s.io/controller-runtime"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	clientset "github.com/accuknox/clawarmor/pkg/agent-controller/clientset/versioned"
	informers "github.com/accuknox/clawarmor/pkg/agent-controller/informers/externalversions"
	listersv1alpha1 "github.com/accuknox/clawarmor/pkg/agent-controller/listers/api/v1alpha1"
)

type resolvedAgent struct {
	Target string
	Agent  *clawarmorv1alpha1.Agent
}

type agentWatchEventType string

const (
	agentWatchEventChanged agentWatchEventType = "changed"
	agentWatchEventDeleted agentWatchEventType = "deleted"
)

type agentWatchEvent struct {
	Type  agentWatchEventType
	Agent *clawarmorv1alpha1.Agent
}

type resolver struct {
	namespace      string
	targetOverride string
	client         clientset.Interface
	lister         listersv1alpha1.AgentLister
	stopCh         chan struct{}
	stopOnce       sync.Once
	watchMu        sync.Mutex
	watchers       map[chan agentWatchEvent]struct{}
}

func newResolver(ctx context.Context, namespace, targetOverride string) (*resolver, error) {
	cfg, err := ctrl.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("load kube config: %w", err)
	}

	cs, err := clientset.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create agent clientset: %w", err)
	}

	if namespace == "" {
		namespace = DefaultNamespace
	}

	factory := informers.NewSharedInformerFactoryWithOptions(
		cs,
		30*time.Second,
		informers.WithNamespace(namespace),
	)
	agentInformer := factory.Api().V1alpha1().Agents()
	informer := agentInformer.Informer()
	lister := agentInformer.Lister()

	r := &resolver{
		namespace:      namespace,
		targetOverride: strings.TrimSpace(targetOverride),
		client:         cs,
		lister:         lister,
		stopCh:         make(chan struct{}),
		watchers:       make(map[chan agentWatchEvent]struct{}),
	}
	_, err = informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj any) {
			r.broadcastAgentEvent(agentWatchEventChanged, agentFromInformerObject(obj))
		},
		UpdateFunc: func(_, newObj any) {
			r.broadcastAgentEvent(agentWatchEventChanged, agentFromInformerObject(newObj))
		},
		DeleteFunc: func(obj any) {
			r.broadcastAgentEvent(agentWatchEventDeleted, agentFromInformerObject(obj))
		},
	})
	if err != nil {
		r.Close()
		return nil, fmt.Errorf("register agent informer handler: %w", err)
	}
	go func() {
		<-ctx.Done()
		r.Close()
	}()

	factory.Start(r.stopCh)

	ok := cache.WaitForCacheSync(r.stopCh, informer.HasSynced)
	if !ok {
		r.Close()
		return nil, fmt.Errorf("agent informer cache did not sync")
	}
	return r, nil
}

func (r *resolver) Close() {
	if r == nil || r.stopCh == nil {
		return
	}
	r.stopOnce.Do(func() {
		close(r.stopCh)
	})
}

func (r *resolver) watchAgents() (<-chan agentWatchEvent, func()) {
	ch := make(chan agentWatchEvent, 16)
	r.watchMu.Lock()
	r.watchers[ch] = struct{}{}
	r.watchMu.Unlock()

	cancel := func() {
		r.watchMu.Lock()
		if _, ok := r.watchers[ch]; ok {
			delete(r.watchers, ch)
			close(ch)
		}
		r.watchMu.Unlock()
	}
	return ch, cancel
}

func (r *resolver) broadcastAgentEvent(typ agentWatchEventType, agt *clawarmorv1alpha1.Agent) {
	if agt == nil {
		return
	}
	evt := agentWatchEvent{
		Type:  typ,
		Agent: agt.DeepCopy(),
	}

	r.watchMu.Lock()
	defer r.watchMu.Unlock()
	for ch := range r.watchers {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (r *resolver) resolveSession(_ context.Context, sessionID string) (*resolvedAgent, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("session id is required")
	}

	items, err := r.lister.Agents(r.namespace).List(labels.Everything())
	if err != nil {
		return nil, fmt.Errorf("list agents from lister: %w", err)
	}

	for _, agt := range items {
		if agt.Spec.Session.ID != sessionID {
			continue
		}
		return &resolvedAgent{
			Target: r.agentTarget(agt),
			Agent:  agt.DeepCopy(),
		}, nil
	}
	return nil, errAgentNotFound
}

func (r *resolver) agentTarget(agt *clawarmorv1alpha1.Agent) string {
	if r.targetOverride != "" {
		return r.targetOverride
	}
	svcName := strings.TrimSpace(agt.Status.ServiceName)
	if svcName == "" {
		svcName = agt.Name
	}
	_, portStr, err := net.SplitHostPort(agt.Spec.Server.Address)
	if err != nil {
		return agt.Spec.Server.Address
	}
	port, convErr := strconv.Atoi(portStr)
	if convErr != nil || port <= 0 {
		return agt.Spec.Server.Address
	}
	return fmt.Sprintf("%s.%s.svc.cluster.local:%d", svcName, agt.Namespace, port)
}

func agentFromInformerObject(obj any) *clawarmorv1alpha1.Agent {
	switch item := obj.(type) {
	case *clawarmorv1alpha1.Agent:
		return item
	case cache.DeletedFinalStateUnknown:
		if agt, ok := item.Obj.(*clawarmorv1alpha1.Agent); ok {
			return agt
		}
	default:
		return nil
	}
	return nil
}

type agentPhase int

const (
	agentPhaseReady agentPhase = iota + 1
	agentPhaseProgressing
	agentPhaseDegraded
	agentPhaseNotFound
)

type agentStatusView struct {
	SessionID string
	Name      string
	Namespace string
	Phase     agentPhase
	Reason    string
	Message   string
}

func statusFromAgent(agt *clawarmorv1alpha1.Agent) *agentStatusView {
	view := &agentStatusView{
		SessionID: agt.Status.ObservedSessionID,
		Name:      agt.Name,
		Namespace: agt.Namespace,
		Phase:     agentPhaseProgressing,
		Reason:    "Unknown",
		Message:   "Agent status is unknown",
	}
	if view.SessionID == "" {
		view.SessionID = agt.Spec.Session.ID
	}

	cond := apimeta.FindStatusCondition(
		agt.Status.Conditions,
		clawarmorv1alpha1.ConditionTypeReady.String(),
	)
	if cond != nil && cond.Status == "True" {
		view.Phase = agentPhaseReady
		view.Reason = cond.Reason
		view.Message = cond.Message
		return view
	}

	cond = apimeta.FindStatusCondition(
		agt.Status.Conditions,
		clawarmorv1alpha1.ConditionTypeDegraded.String(),
	)
	if cond != nil && cond.Status == "True" {
		view.Phase = agentPhaseDegraded
		view.Reason = cond.Reason
		view.Message = cond.Message
		return view
	}

	cond = apimeta.FindStatusCondition(
		agt.Status.Conditions,
		clawarmorv1alpha1.ConditionTypeProgressing.String(),
	)
	if cond != nil {
		view.Phase = agentPhaseProgressing
		view.Reason = cond.Reason
		view.Message = cond.Message
	}
	return view
}
