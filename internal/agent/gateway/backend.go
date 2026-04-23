package gateway

import (
	"context"
	"fmt"
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

func backendCallContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 30*time.Second)
}
