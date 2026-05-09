package sinjector

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	k8sauth "github.com/openbao/openbao/api/auth/kubernetes/v2"
	baoapi "github.com/openbao/openbao/api/v2"
)

const (
	// DefaultListenAddr is the default SIP listen address.
	DefaultListenAddr  = "0.0.0.0:8080"
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
}

// Serve starts the secret injection proxy and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := validate(cfg); err != nil {
		return err
	}

	baoClient, err := baoapi.NewClient(&baoapi.Config{Address: cfg.OpenBaoAddr})
	if err != nil {
		return fmt.Errorf("create openbao client: %w", err)
	}
	auth, err := k8sauth.NewKubernetesAuth(
		cfg.OpenBaoK8sAuthRole,
		k8sauth.WithMountPath(cfg.OpenBaoK8sAuthMountPath),
		k8sauth.WithServiceAccountTokenPath(cfg.OpenBaoK8sAuthTokenPath),
	)
	if err != nil {
		return fmt.Errorf("create kubernetes auth: %w", err)
	}
	if _, err := baoClient.Auth().Login(ctx, auth); err != nil {
		return fmt.Errorf("openbao kubernetes auth login: %w", err)
	}

	ca, err := tls.LoadX509KeyPair(cfg.CACertPath, cfg.CAKeyPath)
	if err != nil {
		return fmt.Errorf("load mitm ca: %w", err)
	}

	p := &proxy{
		ca:        &ca,
		certCache: newCertStore(1024),
		resolver: resolver{
			kv:        baoClient.KVv2(cfg.OpenBaoSecretMountPath),
			agentName: cfg.AgentName,
		},
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
		slog.InfoContext(ctx, "starting secret injection proxy",
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

func (r resolver) resolve(ctx context.Context, name string) (resolvedSecret, error) {
	secret, err := r.kv.Get(ctx, fmt.Sprintf("%s/%s", r.agentName, name))
	if err != nil {
		return resolvedSecret{}, fmt.Errorf("read openbao secret %q: %w", name, err)
	}
	if secret == nil {
		return resolvedSecret{}, fmt.Errorf("openbao secret %q not found", name)
	}
	value, ok := secret.Data["value"].(string)
	if !ok {
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
	if err := validateSecretValue(value); err != nil {
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
	var hosts []string
	switch rawHosts := secret.Data["hosts"].(type) {
	case []any:
		for _, raw := range rawHosts {
			host, ok := raw.(string)
			if !ok {
				return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
			}
			hosts = append(hosts, host)
		}
	case []string:
		hosts = append(hosts, rawHosts...)
	default:
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
	hosts, err = NormalizeSecretHosts(hosts)
	if err != nil {
		return resolvedSecret{}, fmt.Errorf("%w: %s", errBadSecret, name)
	}
	return resolvedSecret{value: value, hosts: hosts}, nil
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
