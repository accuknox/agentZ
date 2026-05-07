package gateway

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
)

type backendClient struct {
	conn   *grpc.ClientConn
	client agentpb.AgentServiceClient
}

func newBackendClient(target string) (*backendClient, error) {
	conn, err := grpc.NewClient(
		target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial agent backend: %w", err)
	}
	return &backendClient{
		conn:   conn,
		client: agentpb.NewAgentServiceClient(conn),
	}, nil
}

func (c *backendClient) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

func (s *Service) backendClient(target string) (*backendClient, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, fmt.Errorf("agent backend target is required")
	}

	s.backendMu.Lock()
	defer s.backendMu.Unlock()
	if s.backends == nil {
		s.backends = make(map[string]*backendClient)
	}
	if backend, ok := s.backends[target]; ok {
		return backend, nil
	}

	backend, err := newBackendClient(target)
	if err != nil {
		return nil, err
	}
	s.backends[target] = backend
	return backend, nil
}

func (s *Service) closeBackendClients() {
	s.backendMu.Lock()
	backends := s.backends
	s.backends = make(map[string]*backendClient)
	s.backendMu.Unlock()

	for _, backend := range backends {
		_ = backend.Close()
	}
}

func backendCallContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 30*time.Second)
}
