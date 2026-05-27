package gateway

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/tools/cache"
	ctrl "sigs.k8s.io/controller-runtime"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
	clientset "github.com/accuknox/clawarmor/pkg/controller/clientset/versioned"
	informers "github.com/accuknox/clawarmor/pkg/controller/informers/externalversions"
	listersv1alpha1 "github.com/accuknox/clawarmor/pkg/controller/listers/clawarmor/v1alpha1"
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

type workflowRunWatchEventType string

const (
	workflowRunWatchEventChanged workflowRunWatchEventType = "changed"
	workflowRunWatchEventDeleted workflowRunWatchEventType = "deleted"
)

type workflowRunWatchEvent struct {
	Type workflowRunWatchEventType
	Run  *clawarmorv1alpha1.WorkflowRun
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
	runWatchers    map[chan workflowRunWatchEvent]struct{}
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
	agentInformer := factory.Clawarmor().V1alpha1().Agents()
	workflowRunInformer := factory.Clawarmor().V1alpha1().WorkflowRuns()
	informer := agentInformer.Informer()
	runInformer := workflowRunInformer.Informer()
	lister := agentInformer.Lister()

	r := &resolver{
		namespace:      namespace,
		targetOverride: strings.TrimSpace(targetOverride),
		client:         cs,
		lister:         lister,
		stopCh:         make(chan struct{}),
		watchers:       make(map[chan agentWatchEvent]struct{}),
		runWatchers:    make(map[chan workflowRunWatchEvent]struct{}),
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
	_, err = runInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj any) {
			r.broadcastWorkflowRunEvent(workflowRunWatchEventChanged, workflowRunFromInformerObject(obj))
		},
		UpdateFunc: func(_, newObj any) {
			r.broadcastWorkflowRunEvent(workflowRunWatchEventChanged, workflowRunFromInformerObject(newObj))
		},
		DeleteFunc: func(obj any) {
			r.broadcastWorkflowRunEvent(workflowRunWatchEventDeleted, workflowRunFromInformerObject(obj))
		},
	})
	if err != nil {
		r.Close()
		return nil, fmt.Errorf("register workflow run informer handler: %w", err)
	}
	go func() {
		<-ctx.Done()
		r.Close()
	}()

	factory.Start(r.stopCh)

	ok := cache.WaitForCacheSync(r.stopCh, informer.HasSynced, runInformer.HasSynced)
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

func (r *resolver) watchWorkflowRuns() (<-chan workflowRunWatchEvent, func()) {
	ch := make(chan workflowRunWatchEvent, 16)
	r.watchMu.Lock()
	r.runWatchers[ch] = struct{}{}
	r.watchMu.Unlock()

	cancel := func() {
		r.watchMu.Lock()
		if _, ok := r.runWatchers[ch]; ok {
			delete(r.runWatchers, ch)
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

func (r *resolver) broadcastWorkflowRunEvent(typ workflowRunWatchEventType, run *clawarmorv1alpha1.WorkflowRun) {
	if run == nil {
		return
	}
	evt := workflowRunWatchEvent{
		Type: typ,
		Run:  run.DeepCopy(),
	}

	r.watchMu.Lock()
	defer r.watchMu.Unlock()
	for ch := range r.runWatchers {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (r *resolver) resolveAgent(_ context.Context, agentName string) (*resolvedAgent, error) {
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		return nil, fmt.Errorf("agent name is required")
	}

	agt, err := r.lister.Agents(r.namespace).Get(agentName)
	if err != nil {
		return nil, errAgentNotFound
	}
	return &resolvedAgent{
		Target: r.agentTarget(agt),
		Agent:  agt.DeepCopy(),
	}, nil
}

func (r *resolver) agentTarget(agt *clawarmorv1alpha1.Agent) string {
	if r.targetOverride != "" {
		return r.targetOverride
	}
	svcName := strings.TrimSpace(agt.Status.ServiceName)
	if svcName == "" {
		svcName = agt.Name
	}
	return fmt.Sprintf("%s.%s.svc.cluster.local:%d", svcName, agt.Namespace, 4096)
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

func workflowRunFromInformerObject(obj any) *clawarmorv1alpha1.WorkflowRun {
	switch item := obj.(type) {
	case *clawarmorv1alpha1.WorkflowRun:
		return item
	case cache.DeletedFinalStateUnknown:
		if run, ok := item.Obj.(*clawarmorv1alpha1.WorkflowRun); ok {
			return run
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
	Name      string
	Namespace string
	Phase     agentPhase
	Reason    string
	Message   string
}

func statusFromAgent(agt *clawarmorv1alpha1.Agent) *agentStatusView {
	view := &agentStatusView{
		Name:      agt.Name,
		Namespace: agt.Namespace,
		Phase:     agentPhaseProgressing,
		Reason:    "Unknown",
		Message:   "Agent status is unknown",
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
