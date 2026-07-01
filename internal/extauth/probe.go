package extauth

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	internalmcp "github.com/accuknox/agentz/internal/mcp"
	mcpconnwebhook "github.com/accuknox/agentz/internal/webhook/v1alpha1/mcpconn"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type mcpProbeOutcome struct {
	lastProbeTime metav1.Time
	healthy       bool
	reason        string
	message       string
	tools         []agentzv1alpha1.MCPConnectionTool
}

const (
	mcpProbeAttempts      = 3
	mcpProbeBackoffStart  = 100 * time.Millisecond
	mcpProbeBackoffFactor = 2.0
	maxProbeHTTPBodyBytes = 1 << 20
)

type probeRoundTripper struct {
	base   http.RoundTripper
	header http.Header
	query  url.Values
	cookie *http.Cookie

	connName string

	lastStatus    int
	lastMethod    string
	lastURL       string
	lastReqBody   []byte
	lastRespBody  []byte
	reqTruncated  bool
	respTruncated bool
}

func (s *Service) runMCPProbes(ctx context.Context) {
	if err := s.probeMCPConnections(ctx); err != nil {
		slog.ErrorContext(ctx, "initial mcp probe cycle failed", slog.Any("error", err))
	}

	ticker := time.NewTicker(s.probeInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.probeMCPConnections(ctx); err != nil {
				slog.ErrorContext(ctx, "mcp probe cycle failed", slog.Any("error", err))
			}
		}
	}
}

func (s *Service) runProbeQueue(ctx context.Context) {
	for {
		name, shutdown := s.probeQueue.Get()
		if shutdown {
			return
		}

		_, err, _ := s.sf.Do("probe:"+name, func() (any, error) {
			conn, getErr := s.mcpConnections.Get(name)
			if getErr != nil {
				return nil, ctrlclient.IgnoreNotFound(getErr)
			}
			if !conn.DeletionTimestamp.IsZero() {
				return nil, nil
			}
			outcome := s.probeMCPConnection(ctx, conn)
			s.probeTimesMu.Lock()
			s.probeTimes[name] = outcome.lastProbeTime.Time
			s.probeTimesMu.Unlock()
			if writeErr := s.writeMCPProbeStatus(ctx, conn.Namespace, conn.Name, outcome); writeErr != nil {
				return nil, writeErr
			}
			return nil, nil
		})
		s.probeQueue.Done(name)
		if err == nil {
			continue
		}

		slog.ErrorContext(
			ctx,
			"mcp immediate probe failed",
			slog.String("mcp_connection", name),
			slog.Any("error", err),
		)
	}
}

func (s *Service) probeMCPConnections(ctx context.Context) error {
	var list agentzv1alpha1.MCPConnectionList
	if err := s.kube.List(ctx, &list, ctrlclient.InNamespace(s.namespace)); err != nil {
		return fmt.Errorf("list mcp connections: %w", err)
	}

	for _, conn := range list.Items {
		if !conn.DeletionTimestamp.IsZero() {
			continue
		}
		lastProbeTime := time.Time{}
		if conn.Status.LastProbeTime != nil {
			lastProbeTime = conn.Status.LastProbeTime.Time
		}
		s.probeTimesMu.Lock()
		if probeTime, ok := s.probeTimes[conn.Name]; ok && probeTime.After(lastProbeTime) {
			lastProbeTime = probeTime
		}
		s.probeTimesMu.Unlock()
		if !lastProbeTime.IsZero() && time.Since(lastProbeTime) < s.probeInterval {
			continue
		}

		outcome := s.probeMCPConnection(ctx, &conn)
		s.probeTimesMu.Lock()
		s.probeTimes[conn.Name] = outcome.lastProbeTime.Time
		s.probeTimesMu.Unlock()
		if err := s.writeMCPProbeStatus(ctx, conn.Namespace, conn.Name, outcome); err != nil {
			slog.ErrorContext(
				ctx,
				"write mcp probe status failed",
				slog.String("mcp_connection", conn.Name),
				slog.Any("error", err),
			)
		}
	}
	return nil
}

func (s *Service) probeMCPConnection(ctx context.Context, conn *agentzv1alpha1.MCPConnection) mcpProbeOutcome {
	outcome := mcpProbeOutcome{
		lastProbeTime: metav1.NewTime(time.Now().UTC()),
		healthy:       false,
		reason:        internalmcp.ReasonInternalError,
		message:       "ext auth probe failed",
	}
	backoff := wait.Backoff{
		Duration: mcpProbeBackoffStart,
		Factor:   mcpProbeBackoffFactor,
		Steps:    mcpProbeAttempts,
	}

	err := wait.ExponentialBackoffWithContext(
		ctx,
		backoff,
		func(ctx context.Context) (bool, error) {
			outcome = s.probeMCPConnectionOnce(ctx, conn)
			outcome.lastProbeTime = metav1.NewTime(time.Now().UTC())
			if outcome.healthy {
				return true, nil
			}
			if outcome.reason == internalmcp.ReasonCredentialsInvalid {
				return false, errors.New(outcome.message)
			}
			return false, nil
		},
	)
	if err == nil || wait.Interrupted(err) {
		return outcome
	}

	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		outcome.reason = internalmcp.ReasonInternalError
		outcome.message = err.Error()
		return outcome
	}

	return outcome
}

func (s *Service) probeMCPConnectionOnce(ctx context.Context, conn *agentzv1alpha1.MCPConnection) mcpProbeOutcome {
	outcome := mcpProbeOutcome{
		lastProbeTime: metav1.NewTime(time.Now().UTC()),
		healthy:       false,
		reason:        internalmcp.ReasonInternalError,
		message:       "ext auth probe failed",
	}

	reqCtx, cancel := context.WithTimeout(ctx, s.probeTimeout)
	defer cancel()

	rt, err := s.probeTransport(reqCtx, conn)
	if err != nil {
		if errors.Is(err, errCredentialPending) {
			outcome.reason = internalmcp.ReasonProbePending
			outcome.message = "mcp credentials are pending"
			return outcome
		}
		if errors.Is(err, errCredentialUnavailable) {
			outcome.reason = internalmcp.ReasonCredentialsInvalid
		}
		outcome.message = err.Error()
		return outcome
	}

	client := mcpsdk.NewClient(
		&mcpsdk.Implementation{
			Name:    "agentz-extauth",
			Version: "v0.0.1",
		},
		&mcpsdk.ClientOptions{
			Capabilities: &mcpsdk.ClientCapabilities{},
		},
	)
	transport := &mcpsdk.StreamableClientTransport{
		Endpoint:             conn.Spec.Endpoint.URL,
		HTTPClient:           &http.Client{Transport: rt},
		DisableStandaloneSSE: true,
		MaxRetries:           -1,
	}

	session, err := client.Connect(reqCtx, transport, nil)
	if err != nil {
		outcome.reason = classifyProbeError(err, rt.lastStatus)
		outcome.message = err.Error()
		rt.logHTTPExchange(
			ctx,
			slog.LevelWarn,
			"mcp initialize http exchange",
			slog.String("probe_reason", outcome.reason),
		)
		return outcome
	}
	defer func() {
		if closeErr := session.Close(); closeErr != nil {
			slog.DebugContext(
				ctx,
				"close mcp probe session failed",
				slog.String("mcp_connection", conn.Name),
				slog.Any("error", closeErr),
			)
		}
	}()

	tools, err := session.ListTools(reqCtx, nil)
	if err != nil {
		outcome.reason = classifyProbeError(err, rt.lastStatus)
		outcome.message = err.Error()
		rt.logHTTPExchange(ctx, slog.LevelWarn, "mcp list_tools http exchange",
			slog.String("probe_reason", outcome.reason),
		)
		return outcome
	}
	outcome.tools = make([]agentzv1alpha1.MCPConnectionTool, 0, len(tools.Tools))
	for _, tool := range tools.Tools {
		outcome.tools = append(outcome.tools, agentzv1alpha1.MCPConnectionTool{
			Name: strings.TrimSpace(tool.Name),
		})
	}

	outcome.healthy = true
	outcome.reason = internalmcp.ReasonReady
	outcome.message = "probe healthy"
	return outcome
}

func (s *Service) probeTransport(ctx context.Context, conn *agentzv1alpha1.MCPConnection) (*probeRoundTripper, error) {
	conn = conn.DeepCopy()
	mcpconnwebhook.ApplyDefaults(&conn.Spec)

	header := http.Header{}
	query := url.Values{}
	var cookie *http.Cookie

	if conn.Spec.Auth != nil {
		token, location, err := s.probeToken(ctx, conn)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(token) == "" {
			return nil, fmt.Errorf("mcp credentials are invalid: %w", errCredentialUnavailable)
		}

		if location == nil || location.Header != nil {
			authHeader, err := headerLocation(location)
			if err != nil {
				return nil, err
			}
			value := token
			if prefix := strings.TrimSpace(authHeader.prefix); prefix != "" {
				value = prefix + " " + token
			}
			header.Set(authHeader.name, value)
		}
		if location != nil && location.QueryParameter != nil {
			query.Set(location.QueryParameter.Name, token)
		}
		if location != nil && location.Cookie != nil {
			cookie = &http.Cookie{Name: location.Cookie.Name, Value: token}
		}
	}

	for key, value := range conn.Spec.Endpoint.Headers {
		header.Set(key, value)
	}

	base := http.DefaultTransport.(*http.Transport).Clone()
	base.TLSClientConfig = &tls.Config{
		InsecureSkipVerify: conn.Spec.Endpoint.InsecureSkipVerify,
	}

	return &probeRoundTripper{
		base:     base,
		header:   header,
		query:    query,
		cookie:   cookie,
		connName: conn.Name,
	}, nil
}

func (s *Service) probeToken(ctx context.Context, conn *agentzv1alpha1.MCPConnection) (string, *agentzv1alpha1.MCPConnectionAuthLocation, error) {
	if conn.Spec.Auth.Bearer != nil {
		auth := conn.Spec.Auth.Bearer
		if auth.SecretRef == nil {
			return "", nil, fmt.Errorf(
				"bearer secret ref is missing: %w",
				errCredentialUnavailable,
			)
		}
		record, err := s.readBearerRecord(ctx, *auth.SecretRef)
		if err != nil {
			return "", nil, err
		}
		return strings.TrimSpace(record.Token), auth.Location, nil
	}
	if conn.Spec.Auth.OAuth != nil {
		token, location, _, err := s.resolveOAuthAccessToken(ctx, conn)
		if err != nil {
			return "", nil, err
		}
		return strings.TrimSpace(token), location, nil
	}
	return "", nil, fmt.Errorf("mcp connection %q has no supported auth mode: %w", conn.Name, errCredentialUnavailable)
}

func classifyProbeError(err error, statusCode int) string {
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return internalmcp.ReasonCredentialsInvalid
	}
	if isReachabilityError(err) {
		return internalmcp.ReasonConnectionUnreachable
	}
	return internalmcp.ReasonProtocolError
}

func isReachabilityError(err error) bool {
	if err == nil {
		return false
	}

	if urlErr, ok := errors.AsType[*url.Error](err); ok {
		err = urlErr.Err
	}

	if _, ok := errors.AsType[net.Error](err); ok {
		return true
	}

	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "i/o timeout") ||
		strings.Contains(msg, "tls") ||
		strings.Contains(msg, "x509")
}

func (s *Service) writeMCPProbeStatus(ctx context.Context, namespace, name string, outcome mcpProbeOutcome) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		conn := &agentzv1alpha1.MCPConnection{}
		key := ctrlclient.ObjectKey{Namespace: namespace, Name: name}
		if err := s.kube.Get(ctx, key, conn); err != nil {
			return ctrlclient.IgnoreNotFound(err)
		}

		conn.Status.LastProbeTime = &outcome.lastProbeTime
		conn.Status.ToolCatalogReady = outcome.healthy
		conn.Status.Tools = outcome.tools
		status := metav1.ConditionFalse
		if outcome.healthy {
			status = metav1.ConditionTrue
		}
		if outcome.reason == internalmcp.ReasonProbePending {
			status = metav1.ConditionUnknown
		}
		conn.Status.SetCondition(metav1.Condition{
			Type:               internalmcp.ConditionProbeHealthy,
			Status:             status,
			Reason:             outcome.reason,
			Message:            outcome.message,
			ObservedGeneration: conn.Generation,
		})
		setProbeErrorCondition(
			conn,
			internalmcp.ConditionConnectionUnreachable,
			outcome.reason == internalmcp.ReasonConnectionUnreachable,
			outcome,
		)
		setProbeErrorCondition(
			conn,
			internalmcp.ConditionCredentialsInvalid,
			outcome.reason == internalmcp.ReasonCredentialsInvalid,
			outcome,
		)
		setProbeErrorCondition(
			conn,
			internalmcp.ConditionProtocolError,
			outcome.reason == internalmcp.ReasonProtocolError,
			outcome,
		)
		setProbeErrorCondition(
			conn,
			internalmcp.ConditionInternalError,
			outcome.reason == internalmcp.ReasonInternalError,
			outcome,
		)

		return s.kube.Status().Update(ctx, conn)
	})
}

func setProbeErrorCondition(conn *agentzv1alpha1.MCPConnection, typ string, active bool, outcome mcpProbeOutcome) {
	status := metav1.ConditionFalse
	reason := internalmcp.ReasonReady
	message := "probe did not report this error"
	if active {
		status = metav1.ConditionTrue
		reason = outcome.reason
		message = outcome.message
	}
	conn.Status.SetCondition(metav1.Condition{
		Type:               typ,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: conn.Generation,
	})
}

func (rt *probeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header = clone.Header.Clone()

	var reqBody []byte
	if req.Body != nil {
		var truncated bool
		var err error
		reqBody, truncated, err = readProbeBody(req.Body)
		if err != nil {
			return nil, err
		}
		if truncated {
			return nil, fmt.Errorf("mcp probe request body exceeds %d bytes", maxProbeHTTPBodyBytes)
		}
		req.Body = io.NopCloser(bytes.NewReader(reqBody))
	}

	if len(reqBody) > 0 {
		clone.Body = io.NopCloser(bytes.NewReader(reqBody))
	}

	for key, values := range rt.header {
		for _, value := range values {
			clone.Header.Add(key, value)
		}
	}

	if len(rt.query) > 0 {
		q := clone.URL.Query()
		for key, values := range rt.query {
			for _, value := range values {
				q.Add(key, value)
			}
		}
		clone.URL.RawQuery = q.Encode()
	}

	if rt.cookie != nil {
		clone.AddCookie(rt.cookie)
	}

	resp, err := rt.base.RoundTrip(clone)
	if resp != nil {
		rt.lastStatus = resp.StatusCode
		rt.lastMethod = req.Method
		rt.lastURL = probeLogURL(req.URL)
		rt.lastReqBody = reqBody
		rt.reqTruncated = false

		respBody, truncated, err := readProbeBody(resp.Body)
		if err != nil {
			return nil, err
		}
		resp.Body = io.NopCloser(bytes.NewReader(respBody))
		rt.lastRespBody = respBody
		rt.respTruncated = truncated
	}
	return resp, err
}

func (rt *probeRoundTripper) logHTTPExchange(ctx context.Context, level slog.Level, msg string, attrs ...slog.Attr) {
	if rt.lastURL == "" {
		return
	}
	attrs = append(attrs,
		slog.String("mcp_connection", rt.connName),
		slog.String("http_method", rt.lastMethod),
		slog.String("http_url", rt.lastURL),
		slog.Int("http_status", rt.lastStatus),
		slog.String("http_req_body", strings.TrimSpace(string(rt.lastReqBody))),
		slog.Bool("http_req_body_truncated", rt.reqTruncated),
		slog.String("http_resp_body", strings.TrimSpace(string(rt.lastRespBody))),
		slog.Bool("http_resp_body_truncated", rt.respTruncated),
	)
	slog.LogAttrs(ctx, level, msg, attrs...)
}

func readProbeBody(body io.ReadCloser) ([]byte, bool, error) {
	defer body.Close()

	data, err := io.ReadAll(io.LimitReader(body, maxProbeHTTPBodyBytes+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) <= maxProbeHTTPBodyBytes {
		return data, false, nil
	}
	return data[:maxProbeHTTPBodyBytes], true, nil
}

func probeLogURL(raw *url.URL) string {
	if raw == nil {
		return ""
	}

	clean := *raw
	clean.User = nil
	if clean.RawQuery != "" {
		clean.RawQuery = "redacted"
	}
	return clean.String()
}
