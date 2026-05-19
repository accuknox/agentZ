package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
)

const (
	opencodePrefix              = "/api/opencode"
	opencodeProxyBodyLimitBytes = 16 * 1024 * 1024
)

var opencodeProxyBodyLimitedMethods = map[string]struct{}{
	http.MethodPatch:  {},
	http.MethodPost:   {},
	http.MethodPut:    {},
	http.MethodDelete: {},
}

type opencodeRoute struct {
	Method   string
	Segments []string
}

// handleOpenCodeProxy resolves and proxies supported OpenCode requests.
func (s *Service) handleOpenCodeProxy(w http.ResponseWriter, r *http.Request) {
	agentName, ok := validAgentName(w, r, chi.URLParam(r, "agentName"), "agentName")
	if !ok {
		return
	}

	route, methodAllowed := matchOpenCodeRoute(r.Method, r.URL.Path)
	if route == nil {
		if methodAllowed {
			writeError(w, r, newAPIError(
				http.StatusMethodNotAllowed,
				"method_not_allowed",
				"method is not allowed for this route",
				nil,
			))
			return
		}

		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"route not found",
			nil,
		))
		return
	}
	resolved, err := s.resolver.resolveAgent(r.Context(), agentName)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
			err,
		))
		return
	}

	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	path, rawPath, err := openCodeUpstreamPath(r.URL, agentName)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"route not found",
			err,
		))
		return
	}

	if opencodeProxyBodyLimitEnabled(r.Method) {
		if r.ContentLength > opencodeProxyBodyLimitBytes {
			writeError(w, r, newAPIError(
				http.StatusRequestEntityTooLarge,
				"request_too_large",
				"request body exceeds the maximum allowed size",
				nil,
			))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, opencodeProxyBodyLimitBytes)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(preq *httputil.ProxyRequest) {
			preq.Out.URL.Scheme = target.Scheme
			preq.Out.URL.Host = target.Host
			preq.Out.Host = target.Host
			preq.Out.URL.Path = path
			preq.Out.URL.RawPath = rawPath
			preq.SetXForwarded()
			preq.Out.Header.Set("X-Request-ID", requestID(preq.In))
		},
		ModifyResponse: func(resp *http.Response) error {
			// gateway owns CORS policy for browser clients. Strip upstream CORS
			// headers so chi/cors writes a single value.
			resp.Header.Del("Access-Control-Allow-Credentials")
			resp.Header.Del("Access-Control-Allow-Headers")
			resp.Header.Del("Access-Control-Allow-Methods")
			resp.Header.Del("Access-Control-Allow-Origin")
			resp.Header.Del("Access-Control-Expose-Headers")
			resp.Header.Del("Access-Control-Max-Age")
			return nil
		},
		FlushInterval: -1,
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
			if _, ok := errors.AsType[*http.MaxBytesError](proxyErr); ok {
				writeError(rw, req, newAPIError(
					http.StatusRequestEntityTooLarge,
					"request_too_large",
					"request body exceeds the maximum allowed size",
					proxyErr,
				))
				return
			}

			writeError(rw, req, newAPIError(
				http.StatusBadGateway,
				"proxy_error",
				"request failed",
				proxyErr,
			))
		},
	}

	proxy.ServeHTTP(w, r)
}

func matchOpenCodeRoute(method, path string) (*opencodeRoute, bool) {
	segments := pathSegments(path)
	methodAllowed := false

	for i := range opencodeRoutes {
		route := &opencodeRoutes[i]
		if !segmentsMatch(route.Segments, segments) {
			continue
		}
		if route.Method == method {
			return route, false
		}
		methodAllowed = true
	}

	return nil, methodAllowed
}

func openCodeTargetURL(target string) (*url.URL, error) {
	addr := strings.TrimSpace(target)
	addr = strings.TrimPrefix(addr, "https://")
	addr = strings.TrimPrefix(addr, "http://")
	if addr == "" {
		return nil, fmt.Errorf("opencode target is empty")
	}

	out, err := url.Parse("http://" + addr)
	if err != nil {
		return nil, fmt.Errorf("parse opencode target: %w", err)
	}
	return out, nil
}

func openCodeUpstreamPath(u *url.URL, agentName string) (string, string, error) {
	prefix := opencodePrefix + "/" + agentName
	path := u.Path
	if !strings.HasPrefix(path, prefix) {
		return "", "", fmt.Errorf("path %q does not match prefix %q", path, prefix)
	}

	out := strings.TrimPrefix(path, prefix)
	if out == "" {
		out = "/"
	}
	if !strings.HasPrefix(out, "/") {
		out = "/" + out
	}

	rawPath := u.EscapedPath()
	rawPath = strings.TrimPrefix(rawPath, prefix)
	if rawPath == "" {
		rawPath = "/"
	}
	if !strings.HasPrefix(rawPath, "/") {
		rawPath = "/" + rawPath
	}

	return out, rawPath, nil
}

func pathSegments(path string) []string {
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func segmentsMatch(pattern, actual []string) bool {
	if len(pattern) != len(actual) {
		return false
	}

	for i := range pattern {
		if isPathParam(pattern[i]) {
			continue
		}
		if pattern[i] != actual[i] {
			return false
		}
	}
	return true
}

func isPathParam(segment string) bool {
	return strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")
}

// opencodeProxyBodyLimitEnabled reports whether the request method should be
// subject to attachment-aware body limits before proxying upstream.
func opencodeProxyBodyLimitEnabled(method string) bool {
	_, ok := opencodeProxyBodyLimitedMethods[method]
	return ok
}
