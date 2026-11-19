package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// RunBrowser executes a browser action after checking the Agent and chat access.
func (s *Service) RunBrowser(w http.ResponseWriter, r *http.Request, agent gatewayapi.AgentNamePath, session string, _ gatewayapi.RunBrowserParams) {
	s.proxyBrowser(w, r, agent, session)
}

// StreamBrowser serves authenticated browser state, artifacts and live views.
func (s *Service) StreamBrowser(w http.ResponseWriter, r *http.Request, agent gatewayapi.AgentNamePath, session string, _ gatewayapi.StreamBrowserParams) {
	s.proxyBrowser(w, r, agent, session)
}

// UploadBrowserFile transfers a file to the session's current browser chooser.
func (s *Service) UploadBrowserFile(w http.ResponseWriter, r *http.Request, agent gatewayapi.AgentNamePath, session string, _ gatewayapi.UploadBrowserFileParams) {
	s.proxyBrowser(w, r, agent, session)
}

func (s *Service) proxyBrowser(w http.ResponseWriter, r *http.Request, agent, session string) {
	ctx := r.Context()
	auth, _ := requestAuthState(ctx)
	if auth.actorType != requestActorUser || auth.claims == nil ||
		auth.claims.BrowserSessionID == "" {
		err := errors.New("browser control requires a signed-in user")
		apiutil.WriteError(w, r, resourceForbidden(err))
		return
	}
	origin := r.Header.Get("Origin")
	if origin != "" && !slices.Contains(s.cfg.AllowedWebOrigins, origin) {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("browser origin is not allowed")))
		return
	}
	ctx, cancel, apiErr := s.authorizeStream(ctx)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	defer cancel()

	access, _, _, err := s.chatInputAccess(ctx, agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get browser session", err))
		return
	}
	resolved, err := s.resolver.resolveAgent(ctx, access.namespace, agent)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get browser agent", err))
		return
	}
	if !resolved.Agent.Spec.Browser.Enabled {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "browser_disabled", "Browser use is disabled for this agent", nil))
		return
	}
	secret := &corev1.Secret{}
	key := types.NamespacedName{Namespace: resolved.Agent.Namespace, Name: agent + agentzv1alpha1.BrowserSecretSuffix}
	err = s.k8sClient.Get(ctx, key, secret)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusServiceUnavailable, "browser_unavailable", "Browser is starting", err))
		return
	}
	owner := metav1.GetControllerOf(secret)
	if owner == nil || owner.UID != resolved.Agent.UID {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusServiceUnavailable, "browser_unavailable", "Browser credential is starting", nil))
		return
	}
	token := string(secret.Data[agentzv1alpha1.BrowserGatewayTokenKey])
	if token == "" {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusServiceUnavailable, "browser_unavailable", "Browser credential is unavailable", nil))
		return
	}
	viewer := r.URL.Query().Get("viewer")
	if len(viewer) > 128 {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("invalid browser viewer")))
		return
	}
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("%s.%s.svc.cluster.local:%d", agent, access.namespace, agentzv1alpha1.BrowserPort),
	}
	if s.cfg.BrowserTargetOverride != "" {
		override, err := url.Parse("http://" + s.cfg.BrowserTargetOverride)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		target = override
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		agentEvents, stopAgents := s.resolver.watchAgents()
		defer stopAgents()
		chatEvents, stopChats := s.chatSessionEvents.subscribe(access.workspaceID + "/" + access.userID)
		defer stopChats()
		go func() {
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case event, ok := <-agentEvents:
					if !ok {
						return
					}
					if event.Agent.Namespace != access.namespace || event.Agent.Name != agent {
						continue
					}
					unavailable := event.Type == agentWatchEventDeleted || !event.Agent.Spec.Browser.Enabled
					if unavailable || event.Agent.UID != resolved.Agent.UID {
						cancel()
						return
					}
					continue
				case _, ok := <-chatEvents:
					if !ok {
						return
					}
				case <-ticker.C:
				}
				check, done := context.WithTimeout(ctx, 5*time.Second)
				current, err := s.resolver.resolveAgent(check, access.namespace, agent)
				if err != nil || !current.Agent.Spec.Browser.Enabled || current.Agent.UID != resolved.Agent.UID {
					done()
					cancel()
					return
				}
				_, _, _, err = s.chatInputAccess(check, agent, session)
				done()
				if err != nil {
					cancel()
					return
				}
			}
		}()
	}
	proxy := httputil.ReverseProxy{
		Rewrite: func(req *httputil.ProxyRequest) {
			req.SetURL(target)
			req.Out.URL.Path = "/"
			req.Out.URL.RawPath = ""
			query := req.Out.URL.Query()
			query.Set("session", session)
			req.Out.URL.RawQuery = query.Encode()
			req.Out.Header.Set("Authorization", "Bearer "+token)
			req.Out.Header.Set("X-Browser-Viewer", access.userID+":"+viewer)
			req.Out.Header.Set("X-Browser-Caller", session)
			req.Out.Header.Del("Origin")
			req.Out.Header.Del("Cookie")
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode == http.StatusSwitchingProtocols {
				body := response.Body
				context.AfterFunc(ctx, func() {
					_ = body.Close()
				})
			}
			response.Header.Set("Cache-Control", "no-store")
			response.Header.Set("X-Content-Type-Options", "nosniff")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "browser_unavailable", "Browser is unavailable", err))
		},
	}
	proxy.ServeHTTP(w, r.WithContext(ctx))
}
