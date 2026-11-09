package launcher

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/tmaxmax/go-sse"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type modelOption struct {
	BehavesAs   string `json:"behavesAs,omitempty"`
	Description string `json:"description"`
	Label       string `json:"label"`
	Model       string `json:"model"`
}

type modelPicker struct {
	Options               []modelOption `json:"options"`
	ReplaceBuiltInOptions bool          `json:"replaceBuiltInOptions"`
}

// Fields are alphabetical so the checksum matches Claude's canonical JSON.
type managedSettings struct {
	AvailableModels      []string          `json:"availableModels"`
	AvailableModelsMatch string            `json:"availableModelsMatch"`
	DisableAutoMode      string            `json:"disableAutoMode"`
	EnforceAvailable     bool              `json:"enforceAvailableModels"`
	Model                string            `json:"model"`
	ModelOverrides       map[string]string `json:"modelOverrides"`
	ModelPicker          modelPicker       `json:"modelPicker"`
}

type settingsResponse struct {
	UUID     string          `json:"uuid"`
	Checksum string          `json:"checksum"`
	Settings managedSettings `json:"settings"`
}

type discovery struct {
	Issuer        string `json:"issuer"`
	DeviceURL     string `json:"device_authorization_endpoint"`
	TokenURL      string `json:"token_endpoint"`
	RevocationURL string `json:"revocation_endpoint"`
}

type modelListItem struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type modelList struct {
	Data []modelListItem `json:"data"`
}

type relayErrorDetail struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type relayError struct {
	Type  string           `json:"type"`
	Error relayErrorDetail `json:"error"`
}

type oauthCatalog struct {
	Grant *gatewayapi.DelegationCatalog `json:"agentz_grant"`
}

func (installed *installation) serve(ctx context.Context) error {
	copilot := installed.Provider == "github-copilot-cli" || installed.Provider == "github-copilot-desktop"
	address, err := url.Parse(installed.address)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", address.Host)
	if err != nil {
		return fmt.Errorf("listen for the AgentZ relay: %w", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	api, err := gatewayapi.NewClientWithResponses(installed.upstream.String(), gatewayapi.WithHTTPClient(client))
	if err != nil {
		listener.Close()
		return err
	}
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			responses := strings.HasSuffix(response.Request.URL.Path, "/responses")
			streaming := strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream")
			if copilot && responses && streaming && response.StatusCode == http.StatusOK {
				next, stop := iter.Pull2(sse.Read(response.Body, &sse.ReadConfig{MaxEventSize: 32 << 20}))
				response.Body = &copilotStream{
					ReadCloser: response.Body,
					next:       next,
					stop:       stop,
					items:      make(map[int]json.RawMessage),
				}
				response.ContentLength = -1
				response.Header.Del("Content-Length")
			}
			return nil
		},
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(installed.upstream)
			request.Out.URL.Path = "/api/inference" + request.In.URL.Path
			if request.In.URL.Path == "/mcp" {
				request.Out.URL.Path = "/api/mcp"
			}
			request.Out.URL.RawPath = ""
			request.Out.Header.Del("Cookie")
			request.Out.Header.Del("Origin")
			request.Out.Header.Del("X-Api-Key")
			request.Out.Header.Del("Api-Key")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(relayError{
				Type: "error",
				Error: relayErrorDetail{
					Type:    "api_error",
					Message: "AgentZ is unreachable. Check your network connection.",
				},
			})
		},
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	mux := http.NewServeMux()
	control := func(w http.ResponseWriter, r *http.Request) {
		installed.serveControl(w, r, cancel)
	}
	mux.HandleFunc("GET /relay/status", control)
	mux.HandleFunc("POST /relay/stop", control)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(discovery{
			Issuer:        installed.address,
			DeviceURL:     installed.address + "/oauth/device_authorization",
			TokenURL:      installed.address + "/oauth/token",
			RevocationURL: installed.address + "/oauth/revoke",
		})
	})
	oauth := func(w http.ResponseWriter, r *http.Request) {
		installed.forwardOAuth(w, r, client)
	}
	mux.HandleFunc("POST /oauth/device_authorization", oauth)
	mux.HandleFunc("POST /oauth/token", oauth)
	mux.HandleFunc("POST /oauth/revoke", oauth)
	mux.Handle("POST /v1/messages", proxy)
	mux.Handle("POST /v1/messages/count_tokens", proxy)
	mux.Handle("POST /v1/chat/completions", proxy)
	mux.Handle("POST /v1/responses", proxy)
	mux.Handle("/mcp", proxy)
	catalog := func(w http.ResponseWriter, r *http.Request) {
		installed.serveCatalog(w, r, api)
	}
	mux.HandleFunc("GET /managed/settings", catalog)
	if copilot {
		mux.Handle("POST /v1/traces", proxy)
	}
	if !copilot {
		mux.HandleFunc("GET /v1/models", catalog)
		mux.HandleFunc("POST /v1/traces", catalog)
	}
	mux.HandleFunc("POST /v1/metrics", catalog)
	mux.HandleFunc("POST /v1/logs", catalog)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-transform")
		// Reject browser origins and hostile Host values before routing, even
		// when DNS resolves to loopback. Only native clients use this relay.
		if r.Host != address.Host || r.Header.Get("Origin") != "" {
			http.Error(w, "This relay accepts local native-client requests only.", http.StatusForbidden)
			return
		}
		catalog := r.Method == http.MethodGet && (r.URL.Path == "/v1/meta" || r.URL.Path == "/v1/models")
		if copilot && catalog {
			// Copilot's service catalog has no hosted models or Fusion routing.
			// Approved models use explicit BYOK providers with native protocols.
			// This public metadata contains no grant or account information;
			// Copilot may authenticate it with its separate GitHub credentials.
			data := `{"data":[],"object":"list"}`
			if r.URL.Path == "/v1/meta" {
				data = `{"models":{"data":[],"object":"list"},"object":"meta","service_messages":[]}`
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, data)
			return
		}
		adapter := copilot || installed.Provider == "claude-desktop"
		if adapter && !strings.HasPrefix(r.URL.Path, "/relay/") {
			credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if credential == "" {
				credential = r.Header.Get("X-Api-Key")
			}
			if !hmac.Equal([]byte(credential), []byte(installed.clientKey)) {
				http.Error(w, "Local AgentZ credential required.", http.StatusUnauthorized)
				return
			}
			resource := "inference"
			if r.URL.Path == "/mcp" {
				resource = "mcp"
			}
			token, err := installed.accessToken(r.Context(), resource)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("x-should-retry", "false")
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(relayError{
					Type:  "error",
					Error: relayErrorDetail{Type: "authentication_error", Message: err.Error()},
				})
				return
			}
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Del("X-AgentZ-Authorization")
			// Return upstream rejections before a native client finishes its
			// upload. HTTP/1 otherwise drains the body before writing headers.
			err = http.NewResponseController(w).EnableFullDuplex()
			if err != nil && !errors.Is(err, http.ErrNotSupported) {
				http.Error(w, "The AgentZ relay is unavailable.", http.StatusServiceUnavailable)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		owners := flock.New(filepath.Join(installed.profile, "relay.lock"))
		defer owners.Close()
		var absent time.Time
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for ctx.Err() == nil {
			locked, err := owners.TryLock()
			if err != nil {
				slog.ErrorContext(ctx, "check relay ownership", slog.Any("error", err))
				cancel()
				break
			}
			if !locked {
				absent = time.Time{}
			}
			if locked {
				desktop := installed.Provider == "claude-desktop" || installed.Provider == "chatgpt-desktop" || installed.Provider == "github-copilot-desktop"
				running, err := installed.appsRunning(ctx)
				if err != nil {
					slog.ErrorContext(ctx, "check app lifetime", slog.Any("error", err))
					running = true
				}
				if running {
					absent = time.Time{}
				}
				if !running && absent.IsZero() {
					absent = time.Now()
				}
				if !running && (!desktop || time.Since(absent) >= 5*time.Second) {
					cancel()
					break
				}
				if err := owners.Unlock(); err != nil {
					slog.ErrorContext(ctx, "release relay ownership", slog.Any("error", err))
					cancel()
					break
				}
			}
			select {
			case <-ctx.Done():
			case <-ticker.C:
			}
		}
		shutdownCtx, shutdownCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			server.Close()
		}
	}()
	err = server.Serve(listener)
	cancel()
	<-stopped
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (installed *installation) serveControl(w http.ResponseWriter, r *http.Request, cancel context.CancelFunc) {
	operation := strings.TrimPrefix(r.URL.Path, "/relay/")
	nonce := r.Header.Get("X-AgentZ-Relay-Nonce")
	timestamp, _, _ := strings.Cut(nonce, ":")
	issued, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || time.Since(time.Unix(issued, 0)).Abs() > 30*time.Second {
		http.Error(w, "Relay owner authentication required.", http.StatusUnauthorized)
		return
	}
	message := operation + ":" + nonce
	signature := hmac.New(sha256.New, []byte(installed.ownerKey))
	signature.Write([]byte(message))
	credential := strings.TrimPrefix(r.Header.Get("Authorization"), "AgentZ-HMAC ")
	if !hmac.Equal([]byte(credential), []byte(hex.EncodeToString(signature.Sum(nil)))) {
		http.Error(w, "Relay owner authentication required.", http.StatusUnauthorized)
		return
	}
	signature.Reset()
	signature.Write([]byte("response:" + message))
	w.Header().Set("X-AgentZ-Relay-Proof", hex.EncodeToString(signature.Sum(nil)))
	w.Header().Set("X-AgentZ-Relay-Pid", strconv.Itoa(os.Getpid()))
	w.Header().Set("X-AgentZ-Relay-Lifetime", "app")
	fmt.Fprintln(w, "AgentZ relay running at "+installed.address)
	if r.Method == http.MethodPost {
		cancel()
	}
}

func (installed *installation) serveCatalog(w http.ResponseWriter, r *http.Request, api *gatewayapi.ClientWithResponses) {
	requestCtx, requestCancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer requestCancel()
	catalog, err := api.GetDelegatedCatalogWithResponse(requestCtx, func(_ context.Context, outgoing *http.Request) error {
		outgoing.Header.Set("Authorization", r.Header.Get("Authorization"))
		return nil
	})
	if err != nil {
		http.Error(w, "AgentZ catalog is unavailable.", http.StatusBadGateway)
		return
	}
	if catalog.JSON200 == nil {
		status := catalog.StatusCode()
		if status < 400 {
			status = http.StatusBadGateway
		}
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			w.Header().Set("x-should-retry", "false")
		}
		http.Error(w, "AgentZ authorization is unavailable. Sign in again.", status)
		return
	}
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}
	settings := managedSettings{
		DisableAutoMode:      "disable",
		AvailableModels:      []string{},
		AvailableModelsMatch: "exact",
		EnforceAvailable:     true,
		ModelOverrides:       map[string]string{},
		ModelPicker:          modelPicker{Options: []modelOption{}, ReplaceBuiltInOptions: true},
	}
	list := modelList{Data: []modelListItem{}}
	for _, model := range catalog.JSON200.Models {
		if model.ApiCompatibility == nil {
			continue
		}
		supported := slices.ContainsFunc(*model.ApiCompatibility, func(item gatewayapi.DelegationAPICompatibility) bool {
			return item.Api == gatewayapi.Messages && item.Support != gatewayapi.DelegationAPICompatibilitySupportUnsupported
		})
		if !supported {
			continue
		}
		option := modelOption{
			Model:       model.Id,
			Label:       model.ModelDisplayName,
			Description: model.ProviderDisplayName,
		}
		if option.Label == "" {
			option.Label = model.Model
		}
		if strings.HasPrefix(model.Model, "claude-") {
			option.BehavesAs = model.Model
			duplicates := slices.ContainsFunc(catalog.JSON200.Models, func(other gatewayapi.DelegationModel) bool {
				return other.Id != model.Id && other.Model == model.Model
			})
			if !duplicates && installed.Provider == "claude" {
				option.Model = model.Model
				settings.ModelOverrides[model.Model] = model.Id
			}
		}
		settings.AvailableModels = append(settings.AvailableModels, option.Model)
		settings.ModelPicker.Options = append(settings.ModelPicker.Options, option)
		list.Data = append(list.Data, modelListItem{ID: option.Model, DisplayName: option.Label})
	}
	if len(settings.AvailableModels) == 0 {
		http.Error(w, "No approved model supports Messages. Reconnect and select a supported model.", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/v1/models" {
		json.NewEncoder(w).Encode(list)
		return
	}
	settings.Model = settings.AvailableModels[0]
	data, err := json.Marshal(settings)
	if err != nil {
		http.Error(w, "Cannot prepare model settings.", http.StatusInternalServerError)
		return
	}
	digest := sha256.Sum256(data)
	checksum := "sha256:" + hex.EncodeToString(digest[:])
	etag := `"` + checksum + `"`
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	json.NewEncoder(w).Encode(settingsResponse{
		UUID:     filepath.Base(installed.profile),
		Checksum: checksum,
		Settings: settings,
	})
}

func (installed *installation) forwardOAuth(w http.ResponseWriter, r *http.Request, client *http.Client) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Invalid OAuth form.", http.StatusBadRequest)
		return
	}
	form := r.PostForm
	if clientID := form.Get("client_id"); clientID != "" && clientID != installed.ClientID {
		http.Error(w, "This relay belongs to another OAuth client.", http.StatusBadRequest)
		return
	}
	form.Set("client_id", installed.ClientID)
	path := "/api/auth/oauth2/token"
	switch r.URL.Path {
	case "/oauth/device_authorization":
		path = "/api/auth/device/code"
		form.Set("scope", "openid profile email offline_access inference:use")
		form.Set("resource", installed.upstream.String()+"/api/inference/v1")
		form.Del("surface")
	case "/oauth/revoke":
		path = "/api/auth/oauth2/revoke"
	case "/oauth/token":
		switch form.Get("grant_type") {
		case "authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token":
		default:
			http.Error(w, "Unsupported OAuth grant type.", http.StatusBadRequest)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	target := installed.upstream.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), strings.NewReader(form.Encode()))
	if err != nil {
		http.Error(w, "Cannot prepare OAuth request.", http.StatusInternalServerError)
		return
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err != nil {
		http.Error(w, "AgentZ authentication is unreachable.", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		http.Error(w, "AgentZ authentication redirected unexpectedly.", http.StatusBadGateway)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		http.Error(w, "Invalid AgentZ authentication response.", http.StatusBadGateway)
		return
	}
	code := form.Get("grant_type") == "authorization_code"
	refresh := form.Get("grant_type") == "refresh_token" && form.Get("resource") == installed.upstream.String()+"/api/inference/v1"
	if response.StatusCode == http.StatusOK && (code || refresh) {
		var metadata oauthCatalog
		if err := json.Unmarshal(data, &metadata); err != nil {
			http.Error(w, "Invalid AgentZ authentication response.", http.StatusBadGateway)
			return
		}
		if metadata.Grant != nil {
			catalog, err := json.Marshal(metadata.Grant)
			if err != nil {
				http.Error(w, "Cannot prepare approved model metadata.", http.StatusInternalServerError)
				return
			}
			err = writeProfileFile(filepath.Join(installed.profile, "codex-catalog.json"), catalog)
			if err != nil {
				http.Error(w, "Cannot save approved model metadata.", http.StatusInternalServerError)
				return
			}
		}
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	if retry := response.Header.Get("Retry-After"); retry != "" {
		w.Header().Set("Retry-After", retry)
	}
	w.WriteHeader(response.StatusCode)
	w.Write(data)
}
