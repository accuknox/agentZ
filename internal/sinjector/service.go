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
	"syscall"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/sync/singleflight"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"

	"github.com/accuknox/clawarmor/internal/oauth"
	baoclient "github.com/accuknox/clawarmor/internal/openbao"
	secretstore "github.com/accuknox/clawarmor/internal/secret"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	// DefaultListenAddr is the default SIP listen address.
	DefaultListenAddr  = "0.0.0.0:4096"
	defaultHeaderBytes = 1 << 20
	defaultReadTimeout = 10 * time.Second
	defaultIdleTimeout = 60 * time.Second
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
	Verbose                 bool
}

type resolver struct {
	kv        *baoapi.KVv2
	agentName string
	namespace string
	http      *http.Client
	k8sClient ctrlclient.Client
	sf        singleflight.Group
}

// Serve starts the secret injection proxy and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := validate(cfg); err != nil {
		return err
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
	namespace, err := podNamespace()
	if err != nil {
		return err
	}

	ca, err := tls.LoadX509KeyPair(cfg.CACertPath, cfg.CAKeyPath)
	if err != nil {
		return fmt.Errorf("load mitm ca: %w", err)
	}

	p := &proxy{
		ca:        &ca,
		certCache: newCertStore(1024),
		resolver: &resolver{
			kv:        baoClient.KVv2(cfg.OpenBaoSecretMountPath),
			agentName: cfg.AgentName,
			namespace: namespace,
			http:      http.DefaultClient,
			k8sClient: k8sClient,
		},
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
	rawSecret, err := r.kv.Get(ctx, secretstore.SecretPath(r.agentName, name))
	if err != nil {
		return resolvedSecret{}, fmt.Errorf("read openbao secret %q: %w", name, err)
	}
	if rawSecret == nil {
		return resolvedSecret{}, fmt.Errorf("openbao secret %q not found", name)
	}
	typ, err := secretstore.RecordType(rawSecret.Data)
	if err != nil {
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
	switch typ {
	case clawarmorv1alpha1.SecretTypeStatic:
		record, err := secretstore.DecodeRecord[secretstore.StaticRecord](rawSecret.Data)
		if err != nil {
			return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
		}
		hosts, err := ParseSecretHosts(record.Hosts)
		if err != nil {
			return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
		}
		if err := validateSecretValue(record.Value); err != nil {
			return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
		}
		return resolvedSecret{value: record.Value, hosts: hosts}, nil
	case clawarmorv1alpha1.SecretTypeOAuth:
		return r.resolveOAuth(ctx, name, rawSecret.Data)
	default:
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
}

func (r *resolver) resolveOAuth(ctx context.Context, key string, raw map[string]any) (resolvedSecret, error) {
	record, err := secretstore.DecodeRecord[secretstore.OAuthRecord](raw)
	if err != nil {
		return resolvedSecret{}, err
	}

	hosts, err := ParseSecretHosts(record.Hosts)
	if err != nil {
		return resolvedSecret{}, err
	}
	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return resolvedSecret{value: record.Token.AccessToken, hosts: hosts}, nil
	}

	result, err, _ := r.sf.Do(key, func() (any, error) {
		return r.refreshOAuth(ctx, key, record)
	})
	if err != nil {
		return resolvedSecret{}, err
	}

	refreshed, ok := result.(secretstore.OAuthRecord)
	if !ok {
		return resolvedSecret{}, fmt.Errorf("unexpected oauth refresh result type %T", result)
	}
	if refreshed.Token == nil || strings.TrimSpace(refreshed.Token.AccessToken) == "" {
		return resolvedSecret{}, fmt.Errorf("oauth refresh did not return an access token")
	}
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
		r.patchRefreshFailure(ctx, record.SecretName, err)
		return secretstore.OAuthRecord{}, err
	}

	record.Token = token
	if len(scopes) > 0 {
		record.Scopes = scopes
	}
	record.UpdatedAt = now

	data, err := secretstore.RecordData(record)
	if err != nil {
		r.patchRefreshFailure(ctx, record.SecretName, err)
		return secretstore.OAuthRecord{}, err
	}
	if _, err := r.kv.Put(ctx, secretstore.SecretPath(r.agentName, key), data); err != nil {
		r.patchRefreshFailure(ctx, record.SecretName, err)
		return secretstore.OAuthRecord{}, err
	}

	r.patchRefreshSuccess(ctx, record.SecretName, record)
	return record, nil
}

func (r *resolver) patchRefreshSuccess(ctx context.Context, name string, record secretstore.OAuthRecord) {
	if strings.TrimSpace(name) == "" {
		return
	}
	secret := &clawarmorv1alpha1.Secret{}
	if err := r.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: r.namespace, Name: name}, secret); err != nil {
		slog.WarnContext(ctx, "load secret status for oauth refresh success", slog.Any("err", err))
		return
	}

	now := metav1.NewTime(time.Now().UTC())
	secret.Status.State = clawarmorv1alpha1.SecretStateReady
	secret.Status.ObservedGeneration = secret.Generation
	secret.Status.LastRuntimeUpdateTime = &now
	secret.Status.LastRefreshTime = &now
	secret.Status.LastRefreshFailureTime = nil
	secret.Status.LastRefreshFailureReason = ""
	secret.Status.LastRefreshFailureMessage = ""
	if record.Token != nil && !record.Token.Expiry.IsZero() {
		expiry := metav1.NewTime(record.Token.Expiry.UTC())
		secret.Status.TokenExpiryTime = &expiry
	}
	secretstore.SetCondition(&secret.Status, metav1.Condition{
		Type:               clawarmorv1alpha1.SecretConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             clawarmorv1alpha1.SecretReasonReady,
		Message:            "Secret runtime is ready",
		ObservedGeneration: secret.Generation,
	})
	if err := r.k8sClient.Status().Update(ctx, secret); err != nil {
		slog.WarnContext(ctx, "update secret status for oauth refresh success", slog.Any("err", err))
	}
}

func (r *resolver) patchRefreshFailure(ctx context.Context, name string, refreshErr error) {
	if strings.TrimSpace(name) == "" {
		return
	}
	secret := &clawarmorv1alpha1.Secret{}
	if err := r.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: r.namespace, Name: name}, secret); err != nil {
		slog.WarnContext(ctx, "load secret status for oauth refresh failure", slog.Any("err", err))
		return
	}

	now := metav1.NewTime(time.Now().UTC())
	secret.Status.State = clawarmorv1alpha1.SecretStateDegraded
	secret.Status.ObservedGeneration = secret.Generation
	secret.Status.LastRuntimeUpdateTime = &now
	secret.Status.LastRefreshFailureTime = &now
	secret.Status.LastRefreshFailureReason = clawarmorv1alpha1.SecretReasonRefreshFailed
	secret.Status.LastRefreshFailureMessage = refreshErr.Error()
	secretstore.SetCondition(&secret.Status, metav1.Condition{
		Type:               clawarmorv1alpha1.SecretConditionDegraded,
		Status:             metav1.ConditionTrue,
		Reason:             clawarmorv1alpha1.SecretReasonRefreshFailed,
		Message:            refreshErr.Error(),
		ObservedGeneration: secret.Generation,
	})
	if err := r.k8sClient.Status().Update(ctx, secret); err != nil {
		slog.WarnContext(ctx, "update secret status for oauth refresh failure", slog.Any("err", err))
	}
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
