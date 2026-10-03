package openbao

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	k8sauth "github.com/openbao/openbao/api/auth/kubernetes/v2"
	baoapi "github.com/openbao/openbao/api/v2"
)

const loginRetryDelay = 5 * time.Second

// NewClient creates an OpenBao client and keeps its Kubernetes-auth token fresh.
func NewClient(ctx context.Context, addr, role, mountPath, tokenPath string) (*baoapi.Client, error) {
	// Keep the SDK's request timeout so a stalled renewal cannot prevent
	// reauthentication, and preserve its transport and retry defaults.
	cfg := baoapi.DefaultConfig()
	cfg.Address = addr
	client, err := baoapi.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("create openbao client: %w", err)
	}

	secret, err := login(ctx, client, role, mountPath, tokenPath)
	if err != nil {
		return nil, err
	}

	go renew(ctx, client, secret, role, mountPath, tokenPath)
	return client, nil
}

func login(ctx context.Context, client *baoapi.Client, role, mountPath, tokenPath string) (*baoapi.Secret, error) {
	auth, err := k8sauth.NewKubernetesAuth(
		role,
		k8sauth.WithMountPath(mountPath),
		k8sauth.WithServiceAccountTokenPath(tokenPath),
	)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes auth: %w", err)
	}

	secret, err := client.Auth().Login(ctx, auth)
	if err != nil {
		return nil, fmt.Errorf("openbao kubernetes auth login: %w", err)
	}
	return secret, nil
}

func renew(ctx context.Context, client *baoapi.Client, secret *baoapi.Secret, role, mountPath, tokenPath string) {
	for ctx.Err() == nil {
		// Reauthenticate on renewal failure instead of retrying an unusable
		// token. Batch tokens only need watching until reauthentication time.
		behavior := baoapi.RenewBehaviorRenewDisabled
		if secret.Auth.Renewable {
			behavior = baoapi.RenewBehaviorErrorOnErrors
		}
		watcher, err := client.NewLifetimeWatcher(&baoapi.LifetimeWatcherInput{
			Secret:        secret,
			RenewBehavior: behavior,
		})
		if err != nil {
			slog.ErrorContext(ctx, "create openbao lifetime watcher",
				slog.Any("err", err))
		}
		if err == nil {
			go watcher.Start()

			select {
			case <-ctx.Done():
				watcher.Stop()
				return
			case err = <-watcher.DoneCh():
				watcher.Stop()
				if err != nil {
					slog.WarnContext(ctx, "openbao token renewal stopped",
						slog.Any("err", err))
				}
			}
		}

		// A role that can log in but cannot renew must not create tokens in
		// a tight loop. Keep retrying until authentication recovers or stops.
		retry := err != nil
		for ctx.Err() == nil {
			if retry {
				timer := time.NewTimer(loginRetryDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			secret, err = login(ctx, client, role, mountPath, tokenPath)
			if err == nil {
				slog.InfoContext(
					ctx,
					"reauthenticated to openbao",
					slog.String("role", role),
				)
				break
			}

			slog.ErrorContext(ctx, "reauthenticate to openbao", slog.Any("err", err))
			retry = true
		}
	}
}
