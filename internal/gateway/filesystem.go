/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const (
	filesystemPort           = 4097
	filesystemProxyBodyLimit = 8 << 20
)

// CreateAgentDirectory handles POST /api/agent/{agentName}/fs/directory.
func (s *Service) CreateAgentDirectory(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	s.proxyFilesystem(w, r, agentName, "/directory")
}

// DeleteAgentEntry handles DELETE /api/agent/{agentName}/fs/entry.
func (s *Service) DeleteAgentEntry(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, _ gatewayapi.DeleteAgentEntryParams) {
	s.proxyFilesystem(w, r, agentName, "/entry")
}

// ReadAgentFile handles GET /api/agent/{agentName}/fs/file.
func (s *Service) ReadAgentFile(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, _ gatewayapi.ReadAgentFileParams) {
	s.proxyFilesystem(w, r, agentName, "/file")
}

// CreateAgentFile handles POST /api/agent/{agentName}/fs/file.
func (s *Service) CreateAgentFile(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	s.proxyFilesystem(w, r, agentName, "/file")
}

// WriteAgentFile handles PUT /api/agent/{agentName}/fs/file.
func (s *Service) WriteAgentFile(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	s.proxyFilesystem(w, r, agentName, "/file")
}

// ReadAgentFileRaw handles GET /api/agent/{agentName}/fs/raw.
func (s *Service) ReadAgentFileRaw(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, _ gatewayapi.ReadAgentFileRawParams) {
	s.proxyFilesystem(w, r, agentName, "/raw")
}

// RenameAgentEntry handles POST /api/agent/{agentName}/fs/rename.
func (s *Service) RenameAgentEntry(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	s.proxyFilesystem(w, r, agentName, "/rename")
}

// StatAgentFile handles GET /api/agent/{agentName}/fs/stat.
func (s *Service) StatAgentFile(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, _ gatewayapi.StatAgentFileParams) {
	s.proxyFilesystem(w, r, agentName, "/stat")
}

func (s *Service) proxyFilesystem(w http.ResponseWriter, r *http.Request, rawAgentName, upstreamPath string) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	agentName, ok := validAgentName(w, r, rawAgentName, "agentName")
	if !ok {
		return
	}
	resolved, err := s.resolver.resolveAgent(r.Context(), ns, agentName)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "agent not found", err))
		return
	}

	targetAddress := strings.TrimSpace(s.cfg.FilesystemTargetOverride)
	if targetAddress == "" {
		serviceName := strings.TrimSpace(resolved.Agent.Status.ServiceName)
		if serviceName == "" {
			serviceName = resolved.Agent.Name
		}
		targetAddress = fmt.Sprintf(
			"%s.%s.svc.cluster.local:%d",
			serviceName,
			resolved.Agent.Namespace,
			filesystemPort,
		)
	}
	targetAddress = strings.TrimPrefix(targetAddress, "https://")
	targetAddress = strings.TrimPrefix(targetAddress, "http://")
	target, err := url.Parse("http://" + targetAddress)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("parse filesystem target: %w", err))
		return
	}
	if target.Host == "" {
		writeInternalError(w, r, fmt.Errorf("filesystem target is empty"))
		return
	}

	if r.ContentLength > filesystemProxyBodyLimit {
		writeError(w, r, newAPIError(
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"request body exceeds the maximum allowed size",
			nil,
		))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, filesystemProxyBodyLimit)

	proxy := &httputil.ReverseProxy{
		Rewrite: func(preq *httputil.ProxyRequest) {
			preq.Out.URL.Scheme = target.Scheme
			preq.Out.URL.Host = target.Host
			preq.Out.URL.Path = upstreamPath
			preq.Out.URL.RawPath = ""
			preq.Out.Host = target.Host
			preq.Out.Header.Del("Authorization")
			preq.Out.Header.Del("Proxy-Authorization")
			preq.Out.Header.Set("X-Request-ID", requestID(preq.In))
			preq.SetXForwarded()
		},
		ModifyResponse: func(resp *http.Response) error {
			stripOpenCodeCORSHeaders(resp)
			return nil
		},
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
				"filesystem_unavailable",
				"agent filesystem is unavailable",
				proxyErr,
			))
		},
	}
	proxy.ServeHTTP(w, r)
}
