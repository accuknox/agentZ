package gateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/host"
	hostv1 "github.com/accuknox/agentz/internal/host/proto"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// CreateComputeEnrollment issues a short, single-use bootstrap for an authored Agent.
func (s *Service) CreateComputeEnrollment(w http.ResponseWriter, r *http.Request, agentName string, _ gatewayapi.CreateComputeEnrollmentParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUpdateAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if s.relay == nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			503, "compute_unavailable", "Host enrollment is not configured", nil,
		))
		return
	}
	agt := &agentzv1alpha1.Agent{}
	err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: agentName}, agt)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get Agent", err))
		return
	}
	if agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		apiutil.WriteError(w, r, apiutil.NewError(
			409, "execution_conflict", "This Agent uses Kubernetes compute", nil,
		))
		return
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	code := base64.RawURLEncoding.EncodeToString(secret)
	hash := sha256.Sum256([]byte(code))
	expires := time.Now().Add(15 * time.Minute)
	_, err = s.queries.GatewayPrepareComputeEnrollment(
		r.Context(), gatewaydb.GatewayPrepareComputeEnrollmentParams{
			ID: uuid.New(), TenantNamespace: access.namespace, AgentName: agentName,
			EnrollmentHash: hash[:], EnrollmentExpiresAt: expires,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteError(w, r, apiutil.NewError(
			409, "host_already_enrolled",
			"Disconnect the current host before enrolling another", nil,
		))
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	apiutil.WriteJSON(w, http.StatusCreated, gatewayapi.ComputeEnrollment{Code: code, ExpiresAt: expires})
}

// RedeemComputeEnrollment exchanges the one-time code for native SPIRE bootstrap.
func (s *Service) RedeemComputeEnrollment(w http.ResponseWriter, r *http.Request) {
	if s.relay == nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			503, "compute_unavailable", "Host enrollment is not configured", nil,
		))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req gatewayapi.RedeemComputeEnrollmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	validHost := len(req.Hostname) > 0 && len(req.Hostname) <= 253
	validDirectory := filepath.IsAbs(req.WorkDirectory) && req.WorkDirectory != "/" &&
		filepath.Clean(req.WorkDirectory) == req.WorkDirectory && len(req.WorkDirectory) <= 4096 &&
		!strings.ContainsAny(req.WorkDirectory, "\x00\r\n")
	if len(req.Code) != 43 || !validHost || !validDirectory {
		apiutil.WriteError(w, r, apiutil.NewError(400, "invalid_request", "Invalid enrollment details", nil))
		return
	}
	hash := sha256.Sum256([]byte(req.Code))
	registration, err := s.queries.GatewayConsumeComputeEnrollment(
		r.Context(), gatewaydb.GatewayConsumeComputeEnrollmentParams{
			EnrollmentHash: hash[:], Hostname: req.Hostname, WorkDirectory: req.WorkDirectory,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteError(w, r, apiutil.NewError(
			401, "invalid_enrollment",
			"Enrollment code has expired or was already used", nil,
		))
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	agt := &agentzv1alpha1.Agent{}
	key := ctrlclient.ObjectKey{
		Namespace: registration.TenantNamespace,
		Name:      registration.AgentName,
	}
	err = s.k8sClient.Get(r.Context(), key, agt)
	agentUnavailable := err != nil || !agt.DeletionTimestamp.IsZero() || agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative
	if agentUnavailable {
		apiutil.WriteError(w, r, apiutil.NewError(
			409, "agent_unavailable", "Agent is no longer available for enrollment", err,
		))
		return
	}
	enrollment, err := s.relay.Enroll(r.Context(), &hostv1.EnrollmentRequest{
		AssignmentId: registration.ID.String(),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	count, err := s.queries.GatewayBindComputeHost(r.Context(), gatewaydb.GatewayBindComputeHostParams{
		ID: registration.ID, NodeID: enrollment.NodeId, WorkloadID: enrollment.WorkloadId,
	})
	if err != nil || count != 1 {
		revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
		defer cancel()
		revokeErr := s.relay.Revoke(revokeCtx, &hostv1.RevokeRequest{
			Namespace: registration.TenantNamespace, Agent: registration.AgentName,
			AssignmentId: registration.ID.String(), NodeId: enrollment.NodeId,
			WorkloadId: enrollment.WorkloadId,
		})
		apiutil.WriteInternalError(
			w, r,
			errors.Join(err, revokeErr, errors.New("enrollment was replaced or revoked")),
		)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.RedeemComputeEnrollmentResponse{
		JoinToken: enrollment.JoinToken, TrustDomain: enrollment.TrustDomain,
		TrustBundle: string(enrollment.TrustBundle), WorkloadId: enrollment.WorkloadId,
		SpireServer: enrollment.SpireAddress, ComputeServer: enrollment.RelayAddress,
	})
}

// RevokeComputeHost disconnects the host and bans its native SPIRE node.
func (s *Service) RevokeComputeHost(w http.ResponseWriter, r *http.Request, agentName string, _ gatewayapi.RevokeComputeHostParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUpdateAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if err := s.revokeCompute(r.Context(), access.namespace, agentName); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) revokeCompute(ctx context.Context, namespace, name string) error {
	registration, err := s.queries.GatewayRevokeComputeHost(
		ctx,
		gatewaydb.GatewayRevokeComputeHostParams{
			TenantNamespace: namespace,
			AgentName:       name,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var revokeErr error
	if s.relay != nil {
		revokeErr = s.relay.Revoke(ctx, &hostv1.RevokeRequest{
			Namespace: namespace, Agent: name, AssignmentId: registration.ID.String(),
			NodeId: registration.NodeID, WorkloadId: registration.WorkloadID,
		})
	}
	agt := &agentzv1alpha1.Agent{}
	err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, agt)
	if err != nil {
		return errors.Join(revokeErr, ctrlclient.IgnoreNotFound(err))
	}
	patch := ctrlclient.MergeFrom(agt.DeepCopy())
	agt.Status.Connected = false
	agt.Status.Hostname = ""
	agt.Status.RuntimeRoot = ""
	agt.Status.SetCondition(metav1.Condition{
		Type: agentzv1alpha1.ConditionTypeReady.String(), Status: metav1.ConditionFalse,
		Reason: "HostRevoked", Message: "Host disconnected. Enroll again to reconnect.",
		ObservedGeneration: agt.Generation,
	})
	return errors.Join(revokeErr, s.k8sClient.Status().Patch(ctx, agt, patch))
}

type hostHTTPTransport struct {
	relay     *host.RelayClient
	transport *http.Transport
}

// RoundTrip keys HTTP connection pooling by the live control connection. An
// earlier queued admission cannot be replayed onto a newly connected runtime.
func (t *hostHTTPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if !strings.HasSuffix(request.URL.Hostname(), ".native.agentz") {
		return t.transport.RoundTrip(request)
	}
	parts := strings.Split(strings.TrimSuffix(request.URL.Hostname(), ".native.agentz"), ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid native Agent address")
	}
	if t.relay == nil {
		return nil, errors.New("host relay unavailable")
	}
	connection, ready, err := t.relay.Connection(request.Context(), parts[1], parts[0])
	if err != nil {
		return nil, err
	}
	if !ready {
		return nil, errors.New("native Agent is offline")
	}
	expected := request.Header.Get("X-Agentz-Compute-Connection")
	if expected != "" && expected != connection {
		return nil, errors.New("native Agent reconnected; submit new work explicitly")
	}
	expected, _ = request.Context().Value(computeConnectionContextKey{}).(string)
	if expected != "" && expected != connection {
		return nil, errors.New("native Agent reconnected; submit new work explicitly")
	}
	forward := request.Clone(request.Context())
	forward.Header.Del("X-Agentz-Compute-Connection")
	hostname := parts[0] + "." + parts[1] + "." + connection + ".native.agentz"
	forward.URL.Host = net.JoinHostPort(hostname, request.URL.Port())
	return t.transport.RoundTrip(forward)
}

func (s *Service) startRelay() (func(), error) {
	if s.cfg.RelayAddress == "" {
		return func() {}, nil
	}
	config, err := host.ClientTLS(
		s.cfg.RelayCertFile, s.cfg.RelayKeyFile, s.cfg.RelayTrustBundle,
		s.cfg.RelayTrustDomain, "/agentz/relay",
	)
	if err != nil {
		return nil, err
	}
	client, err := host.NewRelayClient(s.cfg.RelayAddress, config)
	if err != nil {
		return nil, err
	}
	s.relay = client
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(request *http.Request) (*url.URL, error) {
		if strings.HasSuffix(request.URL.Hostname(), ".native.agentz") {
			return nil, nil
		}
		return http.ProxyFromEnvironment(request)
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		hostname, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if !strings.HasSuffix(hostname, ".native.agentz") {
			return dialer.DialContext(ctx, network, address)
		}
		parts := strings.Split(strings.TrimSuffix(hostname, ".native.agentz"), ".")
		if len(parts) != 3 {
			return nil, errors.New("invalid native Agent address")
		}
		var service string
		switch port {
		case "4096":
			service = "opencode"
		case "4097":
			service = "filesystem"
		default:
			return nil, errors.New("invalid host service")
		}
		return client.DialConnection(ctx, parts[1], parts[0], service, parts[2])
	}
	s.outboundHTTP.Transport = &hostHTTPTransport{relay: client, transport: transport}
	return func() {
		transport.CloseIdleConnections()
		client.Close()
	}, nil
}
