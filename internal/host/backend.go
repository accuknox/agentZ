package host

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"time"

	pb "github.com/accuknox/agentz/internal/host/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
)

// RelayClient connects backend requests to the singleton host relay.
// Interrupted byte streams are never retried transparently.
type RelayClient struct {
	conn   *grpc.ClientConn
	client pb.RelayControlClient
}

// NewRelayClient requires authenticated TLS for the relay service.
func NewRelayClient(address string, tlsConfig *tls.Config) (*RelayClient, error) {
	if address == "" || tlsConfig == nil {
		return nil, errors.New("relay client requires an address and verified TLS")
	}
	verificationDisabled := tlsConfig.InsecureSkipVerify && tlsConfig.VerifyConnection == nil && tlsConfig.VerifyPeerCertificate == nil
	if verificationDisabled {
		return nil, errors.New("relay TLS requires peer verification")
	}
	conn, err := grpc.NewClient(address,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig.Clone())),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(64<<10), grpc.MaxCallSendMsgSize(64<<10)),
	)
	if err != nil {
		return nil, err
	}
	return &RelayClient{conn: conn, client: pb.NewRelayControlClient(conn)}, nil
}

// Enroll requests SPIRE bootstrap material from the internal relay service.
func (c *RelayClient) Enroll(ctx context.Context, request *pb.EnrollmentRequest) (*pb.EnrollmentResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.Enroll(ctx, request)
}

// Revoke closes the assigned session and revokes its SPIRE identity.
// The caller must persist assignment revocation before calling this method.
func (c *RelayClient) Revoke(ctx context.Context, request *pb.RevokeRequest) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.Revoke(ctx, request)
	return err
}

// Connection returns the live session and its runtime readiness.
func (c *RelayClient) Connection(ctx context.Context, namespace, agent string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, err := c.client.GetSession(ctx, &pb.SessionRequest{Namespace: namespace, Agent: agent})
	if err != nil {
		return "", false, err
	}
	if response.SessionId == "" {
		return "", false, status.Error(codes.Unavailable, "host is offline")
	}
	return response.SessionId, response.Ready, nil
}

// DialConnection opens a net.Conn to one fixed service and one admitted session.
// Its five-second handshake must complete before HTTP may write any request data.
func (c *RelayClient) DialConnection(ctx context.Context, namespace, agent, service, expected string) (net.Conn, error) {
	var targetService pb.Service
	switch service {
	case "opencode":
		targetService = pb.Service_SERVICE_OPENCODE
	case "filesystem":
		targetService = pb.Service_SERVICE_FILESYSTEM
	default:
		return nil, fmt.Errorf("unsupported host service %q", service)
	}
	if expected == "" {
		return nil, status.Error(codes.FailedPrecondition, "host session is required")
	}
	streamCtx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(5*time.Second, cancel)
	stream, err := c.client.Dial(streamCtx)
	if err == nil {
		err = stream.Send(&pb.RelayFrame{Target: &pb.HostTarget{
			Namespace: namespace, Agent: agent,
			SessionId: expected, Service: targetService,
		}})
	}
	if err == nil {
		var frame *pb.RelayFrame
		frame, err = stream.Recv()
		if err == nil && (!frame.Ready || frame.Target != nil || len(frame.Data) != 0) {
			err = status.Error(codes.InvalidArgument, "invalid relay acknowledgement")
		}
	}
	if !timer.Stop() && err == nil {
		err = context.DeadlineExceeded
	}
	if err != nil {
		cancel()
		return nil, err
	}
	local, remote := net.Pipe()
	go func() {
		defer cancel()
		defer remote.Close()
		_ = BridgeRelay(stream, remote)
	}()
	go func() {
		<-streamCtx.Done()
		remote.Close()
	}()
	return local, nil
}

// Close closes the relay connection and its in-flight streams.
func (c *RelayClient) Close() error { return c.conn.Close() }

type relayStream interface {
	Send(*pb.RelayFrame) error
	Recv() (*pb.RelayFrame, error)
}

type relayFrames struct{ relayStream }

func (s relayFrames) Send(frame *pb.DataFrame) error {
	return s.relayStream.Send(&pb.RelayFrame{Data: frame.Data})
}

func (s relayFrames) Recv() (*pb.DataFrame, error) {
	frame, err := s.relayStream.Recv()
	if err != nil {
		return nil, err
	}
	if frame.Target != nil || frame.Ready {
		return nil, status.Error(codes.InvalidArgument, "unexpected relay control frame")
	}
	return &pb.DataFrame{Data: frame.Data}, nil
}

// BridgeRelay copies bounded data frames after the target/ready handshake.
// The caller must close conn and cancel its RPC when this function returns.
func BridgeRelay(stream relayStream, conn net.Conn) error {
	return relay(relayFrames{stream}, conn)
}
