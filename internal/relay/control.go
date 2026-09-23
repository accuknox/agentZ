package relay

import (
	"context"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/host"
	hostv1 "github.com/accuknox/agentz/internal/host/proto"
)

// Enroll issues SPIRE bootstrap material for a consumed gateway enrollment.
// Only the gateway identity can reach this listener.
func (s *Service) Enroll(ctx context.Context, request *hostv1.EnrollmentRequest) (*hostv1.EnrollmentResponse, error) {
	id, err := uuid.Parse(request.AssignmentId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid host assignment")
	}
	registration, err := s.queries.RelayRegistration(ctx, id)
	pending := registration.Hostname != "" && registration.WorkDirectory != "" &&
		registration.NodeID == "" && registration.EnrollmentHash == nil
	if err != nil || !pending {
		return nil, status.Error(codes.FailedPrecondition, "host enrollment is not pending")
	}
	enrollment, err := s.identity.Enroll(ctx, id.String())
	if err != nil {
		return nil, err
	}
	enrollment.RelayAddress = s.cfg.PublicAddress
	enrollment.SpireAddress = s.cfg.SPIREPublicAddress
	return enrollment, nil
}

// Revoke closes only the requested assignment and removes its SPIRE grants.
// The gateway must persist revocation before invoking it.
func (s *Service) Revoke(ctx context.Context, request *hostv1.RevokeRequest) (*hostv1.RevokeResponse, error) {
	if _, err := uuid.Parse(request.AssignmentId); err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid host assignment")
	}
	s.hosts.RevokeAssignment(request.Namespace, request.Agent, request.AssignmentId)
	if request.NodeId != "" {
		if err := s.identity.Revoke(ctx, request.NodeId, request.WorkloadId); err != nil {
			return nil, err
		}
	}
	return &hostv1.RevokeResponse{}, nil
}

// GetSession checks the live session against its persisted assignment.
func (s *Service) GetSession(ctx context.Context, request *hostv1.SessionRequest) (*hostv1.SessionResponse, error) {
	record, err := s.queries.GatewayComputeHost(ctx, gatewaydb.GatewayComputeHostParams{
		TenantNamespace: request.Namespace, AgentName: request.Agent,
	})
	if err != nil || record.Revoked {
		return nil, status.Error(codes.Unavailable, "host assignment is unavailable")
	}
	session, ready := s.hosts.Connection(host.Binding{
		Namespace: request.Namespace, Agent: request.Agent, Epoch: record.ID.String(),
	})
	if session == "" || request.SessionId != "" && request.SessionId != session {
		return nil, status.Error(codes.Unavailable, "host session changed")
	}
	return &hostv1.SessionResponse{SessionId: session, Ready: ready}, nil
}

// Dial carries one fixed host-service connection admitted by a gateway replica.
// The first frame names an exact session; reconnect never retargets the stream.
func (s *Service) Dial(stream grpc.BidiStreamingServer[hostv1.RelayFrame, hostv1.RelayFrame]) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	target := first.Target
	if target == nil || target.SessionId == "" || len(first.Data) != 0 || first.Ready {
		return status.Error(codes.InvalidArgument, "host session target is required")
	}
	var service string
	switch target.Service {
	case hostv1.Service_SERVICE_OPENCODE:
		service = "opencode"
	case hostv1.Service_SERVICE_FILESYSTEM:
		service = "filesystem"
	default:
		return status.Error(codes.PermissionDenied, "host service is not available to gateways")
	}
	session, err := s.GetSession(stream.Context(), &hostv1.SessionRequest{
		Namespace: target.Namespace, Agent: target.Agent, SessionId: target.SessionId,
	})
	if err != nil {
		return err
	}
	if !session.Ready {
		return status.Error(codes.Unavailable, "host is preparing its runtime")
	}
	connection, err := s.hosts.DialConnection(stream.Context(), target.Namespace, target.Agent, service, target.SessionId)
	if err != nil {
		return err
	}
	defer connection.Close()
	if err := stream.Send(&hostv1.RelayFrame{Ready: true}); err != nil {
		return err
	}
	return host.BridgeRelay(stream, connection)
}

func (s *Service) validateAssignment(ctx context.Context, binding host.Binding) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	id, err := uuid.Parse(binding.Epoch)
	if err != nil {
		return err
	}
	record, err := s.queries.RelayRegistration(ctx, id)
	if err != nil {
		return err
	}
	expires, err := s.identity.Validate(ctx, record.NodeID)
	if err != nil {
		return err
	}
	count, err := s.queries.GatewayObserveComputeHost(ctx, gatewaydb.GatewayObserveComputeHostParams{
		ID: id, NodeExpiresAt: expires,
	})
	if err != nil {
		return err
	}
	if count != 1 {
		return status.Error(codes.PermissionDenied, "host assignment revoked")
	}
	return nil
}
