package sinjector

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/sync/singleflight"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	"github.com/accuknox/clawarmor/internal/oauth"
	baoclient "github.com/accuknox/clawarmor/internal/openbao"
	secretstore "github.com/accuknox/clawarmor/internal/secret"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
	clawarmorclientset "github.com/accuknox/clawarmor/pkg/controller/clientset/versioned"
	clawarmorinformers "github.com/accuknox/clawarmor/pkg/controller/informers/externalversions"
	clawarmorlisters "github.com/accuknox/clawarmor/pkg/controller/listers/clawarmor/v1alpha1"
)

const (
	// DefaultListenAddr is the default SIP listen address.
	DefaultListenAddr = "0.0.0.0:4096"
	// DefaultSecretProbeInterval bounds how often Secret runtime status is refreshed.
	DefaultSecretProbeInterval = 2 * time.Minute
	defaultHeaderBytes         = 1 << 20
	defaultReadTimeout         = 10 * time.Second
	defaultIdleTimeout         = 60 * time.Second
	probeQueueName             = "sinjector-secret-probe"
)

var errBadSecret = errors.New("secret has invalid value")

// Config describes how to start the secret injection proxy.
type Config struct {
	Addr                    string
	OpenBaoAddr             string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
	AgentName               string
	CACertPath              string
	CAKeyPath               string
	SecretProbeInterval     time.Duration
	Verbose                 bool
}

type resolver struct {
	kv            *baoapi.KVv2
	namespace     string
	agentName     string
	http          *http.Client
	k8sClient     ctrlclient.Client
	secrets       clawarmorlisters.SecretNamespaceLister
	probeQueue    workqueue.TypedInterface[string]
	probeInterval time.Duration
	probeTimes    map[string]time.Time
	probeTimesMu  sync.Mutex
	sf            singleflight.Group
}

// Serve starts the secret injection proxy and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	if err := validate(cfg); err != nil {
		return err
	}
	if cfg.SecretProbeInterval <= 0 {
		cfg.SecretProbeInterval = DefaultSecretProbeInterval
	}

	baoClient, err := baoclient.NewClient(
		ctx,
		cfg.OpenBaoAddr,
		cfg.OpenBaoK8sAuthRole,
		cfg.OpenBaoK8sAuthMountPath,
		cfg.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return err
	}

	scheme := runtime.NewScheme()
	if err := clawarmorv1alpha1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("add clawarmor scheme: %w", err)
	}
	kubeCfg, err := ctrlconfig.GetConfig()
	if err != nil {
		return fmt.Errorf("load kube config: %w", err)
	}
	k8sClient, err := ctrlclient.New(kubeCfg, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create kubernetes client: %w", err)
	}
	clawarmorClient, err := clawarmorclientset.NewForConfig(kubeCfg)
	if err != nil {
		return fmt.Errorf("create clawarmor clientset: %w", err)
	}
	namespace, err := podNamespace()
	if err != nil {
		return err
	}
	informerFactory := clawarmorinformers.NewSharedInformerFactoryWithOptions(
		clawarmorClient,
		cfg.SecretProbeInterval,
		clawarmorinformers.WithNamespace(namespace),
	)
	secretInformer := informerFactory.Clawarmor().V1alpha1().Secrets()

	ca, err := tls.LoadX509KeyPair(cfg.CACertPath, cfg.CAKeyPath)
	if err != nil {
		return fmt.Errorf("load mitm ca: %w", err)
	}

	res := &resolver{
		kv:            baoClient.KVv2(cfg.OpenBaoSecretMountPath),
		namespace:     namespace,
		agentName:     cfg.AgentName,
		http:          http.DefaultClient,
		k8sClient:     k8sClient,
		secrets:       secretInformer.Lister().Secrets(namespace),
		probeQueue:    workqueue.NewTypedWithConfig(workqueue.TypedQueueConfig[string]{Name: probeQueueName}),
		probeInterval: cfg.SecretProbeInterval,
		probeTimes:    map[string]time.Time{},
	}
	_, err = secretInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj any) {
			secret, ok := obj.(*clawarmorv1alpha1.Secret)
			if ok && secret.Spec.AgentRef.Name == cfg.AgentName {
				res.probeQueue.Add(secret.Name)
			}
		},
		UpdateFunc: func(oldObj, newObj any) {
			oldSecret, ok := oldObj.(*clawarmorv1alpha1.Secret)
			if !ok {
				return
			}
			secret, ok := newObj.(*clawarmorv1alpha1.Secret)
			if !ok || secret.Spec.AgentRef.Name != cfg.AgentName {
				return
			}
			if oldSecret.Generation != secret.Generation {
				res.probeQueue.Add(secret.Name)
			}
		},
		DeleteFunc: func(obj any) {
			secret, ok := obj.(*clawarmorv1alpha1.Secret)
			if !ok {
				tombstone, ok := obj.(cache.DeletedFinalStateUnknown)
				if !ok {
					return
				}
				secret, ok = tombstone.Obj.(*clawarmorv1alpha1.Secret)
				if !ok {
					return
				}
			}
			res.probeTimesMu.Lock()
			delete(res.probeTimes, secret.Name)
			res.probeTimesMu.Unlock()
		},
	})
	if err != nil {
		return fmt.Errorf("register secret informer handler: %w", err)
	}
	informerFactory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), secretInformer.Informer().HasSynced) {
		return fmt.Errorf("sync secret informer cache")
	}

	p := &proxy{
		ca:        &ca,
		certCache: newCertStore(1024),
		resolver:  res,
		transport: newProxyTransport(),
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           p,
		ReadHeaderTimeout: defaultReadTimeout,
		IdleTimeout:       defaultIdleTimeout,
		MaxHeaderBytes:    defaultHeaderBytes,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(
			ctx, "starting secret injection proxy",
			slog.String("addr", cfg.Addr),
			slog.String("agent_name", cfg.AgentName),
		)
		errCh <- srv.ListenAndServe()
	}()

	var bg sync.WaitGroup
	bg.Go(func() {
		res.runSecretProbes(ctx)
	})
	bg.Go(func() {
		res.runProbeQueue(ctx)
	})

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			_ = srv.Close()
		}
		err = <-errCh
	case err = <-errCh:
	}

	cancel()
	res.probeQueue.ShutDown()
	bg.Wait()

	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve http: %w", err)
	}
	return nil
}

func validate(cfg Config) error {
	if strings.TrimSpace(cfg.OpenBaoAddr) == "" {
		return fmt.Errorf("openbao addr is required")
	}
	if strings.TrimSpace(cfg.OpenBaoSecretMountPath) == "" {
		return fmt.Errorf("openbao secret mount path is required")
	}
	if strings.TrimSpace(cfg.OpenBaoK8sAuthRole) == "" {
		return fmt.Errorf("openbao k8s auth role is required")
	}
	if strings.TrimSpace(cfg.AgentName) == "" {
		return fmt.Errorf("agent name is required")
	}
	if strings.TrimSpace(cfg.CACertPath) == "" {
		return fmt.Errorf("ca cert path is required")
	}
	if strings.TrimSpace(cfg.CAKeyPath) == "" {
		return fmt.Errorf("ca key path is required")
	}
	return nil
}

// newProxyTransport builds the upstream transport used after request rewriting.
func newProxyTransport() http.RoundTripper {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DisableCompression = true
	tr.ForceAttemptHTTP2 = true
	return tr
}

func (r *resolver) resolve(ctx context.Context, name string) (resolvedSecret, error) {
	rawSecret, err := r.kv.Get(ctx, secretstore.SecretPath(r.namespace, r.agentName, name))
	if err != nil {
		status := secretRuntimeStatus{
			state:     clawarmorv1alpha1.SecretStateDegraded,
			condition: clawarmorv1alpha1.SecretConditionDegraded,
			reason:    clawarmorv1alpha1.SecretReasonReconcileFailed,
			message:   fmt.Sprintf("read openbao runtime: %v", err),
		}
		if errors.Is(err, baoapi.ErrSecretNotFound) {
			status = acceptedSecretStatus()
		}
		r.writeStatusForKey(ctx, name, status)
		return resolvedSecret{}, fmt.Errorf("read openbao secret %q: %w", name, err)
	}
	if rawSecret == nil || rawSecret.Data == nil {
		r.writeStatusForKey(ctx, name, acceptedSecretStatus())
		return resolvedSecret{}, fmt.Errorf("openbao secret %q not found", name)
	}
	typ, err := secretstore.RecordType(rawSecret.Data)
	if err != nil {
		r.writeStatusForKey(ctx, name, degradedSecretStatus(clawarmorv1alpha1.SecretReasonReconcileFailed, err.Error()))
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
	switch typ {
	case clawarmorv1alpha1.SecretTypeStatic:
		record, err := secretstore.DecodeRecord[secretstore.StaticRecord](rawSecret.Data)
		if err != nil {
			r.writeStatusForKey(ctx, name, degradedSecretStatus(clawarmorv1alpha1.SecretReasonReconcileFailed, err.Error()))
			return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
		}
		hosts, err := ParseSecretHosts(record.Hosts)
		if err != nil {
			r.writeStatusForKey(ctx, name, degradedSecretStatus(clawarmorv1alpha1.SecretReasonReconcileFailed, err.Error()))
			return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
		}
		if err := validateSecretValue(record.Value); err != nil {
			r.writeStatusForKey(ctx, name, degradedSecretStatus(clawarmorv1alpha1.SecretReasonReconcileFailed, err.Error()))
			return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
		}
		return resolvedSecret{value: record.Value, hosts: hosts}, nil
	case clawarmorv1alpha1.SecretTypeOAuth:
		return r.resolveOAuth(ctx, name, rawSecret.Data)
	default:
		r.writeStatusForKey(
			ctx,
			name,
			degradedSecretStatus(
				clawarmorv1alpha1.SecretReasonReconcileFailed,
				fmt.Sprintf("unsupported secret type %q", typ),
			),
		)
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
}

func (r *resolver) resolveOAuth(ctx context.Context, key string, raw map[string]any) (resolvedSecret, error) {
	record, err := secretstore.DecodeRecord[secretstore.OAuthRecord](raw)
	if err != nil {
		r.writeStatusForKey(ctx, key, degradedSecretStatus(clawarmorv1alpha1.SecretReasonReconcileFailed, err.Error()))
		return resolvedSecret{}, err
	}

	hosts, err := ParseSecretHosts(record.Hosts)
	if err != nil {
		r.writeStatusForKey(ctx, key, degradedSecretStatus(clawarmorv1alpha1.SecretReasonReconcileFailed, err.Error()))
		return resolvedSecret{}, err
	}
	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return resolvedSecret{value: record.Token.AccessToken, hosts: hosts}, nil
	}

	refreshed, err := r.refreshOAuth(ctx, key, record)
	if err != nil {
		r.writeStatusForKey(ctx, key, degradedSecretStatus(clawarmorv1alpha1.SecretReasonRefreshFailed, err.Error()))
		return resolvedSecret{}, err
	}
	if refreshed.Token == nil || strings.TrimSpace(refreshed.Token.AccessToken) == "" {
		r.writeStatusForKey(ctx, key, acceptedSecretStatus())
		return resolvedSecret{}, fmt.Errorf("oauth refresh did not return an access token")
	}
	expiry := refreshed.Token.Expiry.UTC()
	refreshTime := time.Now().UTC()
	r.writeStatusForKey(ctx, key, readySecretStatus(&expiry, &refreshTime))
	return resolvedSecret{
		value: refreshed.Token.AccessToken,
		hosts: hosts,
	}, nil
}

func (r *resolver) refreshOAuth(ctx context.Context, key string, record secretstore.OAuthRecord) (secretstore.OAuthRecord, error) {
	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return record, nil
	}

	token, scopes, err := oauth.Refresh(ctx, r.http, oauth.AuthConfig{
		TokenEndpoint: record.Config.TokenEndpoint,
		Resource:      record.Config.Resource,
		Scopes:        record.Config.Scopes,
	}, record.Record)
	if err != nil {
		return secretstore.OAuthRecord{}, err
	}

	record.Token = token
	if len(scopes) > 0 {
		record.Scopes = scopes
	}
	record.UpdatedAt = now

	data, err := secretstore.RecordData(record)
	if err != nil {
		return secretstore.OAuthRecord{}, err
	}
	if _, err := r.kv.Put(ctx, secretstore.SecretPath(r.namespace, r.agentName, key), data); err != nil {
		return secretstore.OAuthRecord{}, err
	}

	return record, nil
}

func podNamespace() (string, error) {
	raw, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return "", fmt.Errorf("read pod namespace: %w", err)
	}
	namespace := strings.TrimSpace(string(raw))
	if namespace == "" {
		return "", fmt.Errorf("pod namespace is required")
	}
	return namespace, nil
}

func rewriteRequest(req *http.Request, res secretResolver, target string) *http.Request {
	ctx := req.Context()

	if req.URL != nil {
		path, changed := replacePath(ctx, req.URL.Path, res, target)
		if changed {
			req.URL.Path = path
			req.URL.RawPath = ""
		}

		values := req.URL.Query()
		changed = false
		for key, items := range values {
			for i, item := range items {
				next, ok := replacePlaceholders(ctx, item, res, target)
				if ok {
					values[key][i] = next
					changed = true
				}
			}
		}
		if changed {
			req.URL.RawQuery = values.Encode()
		}
	}

	for key, items := range req.Header {
		for i, item := range items {
			next, ok := replaceHeaderValue(ctx, key, item, res, target)
			if ok {
				req.Header[key][i] = next
			}
		}
	}

	return req
}

func replaceHeaderValue(ctx context.Context, key, value string, res secretResolver, target string) (string, bool) {
	if !strings.EqualFold(key, "Authorization") {
		return replacePlaceholders(ctx, value, res, target)
	}

	scheme, raw, ok := strings.Cut(value, " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return replacePlaceholders(ctx, value, res, target)
	}
	raw = strings.TrimSpace(raw)
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		slog.WarnContext(ctx, "failed to decode basic auth header", slog.Any("err", err))
		return value, false
	}
	next, changed := replacePlaceholders(ctx, string(decoded), res, target)
	if !changed {
		return value, false
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(next))
	return "Basic " + encoded, true
}
