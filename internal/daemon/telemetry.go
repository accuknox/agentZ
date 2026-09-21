package daemon

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/accuknox/agentz/internal/compute"
	pb "github.com/kubearmor/KubeArmor/protobuf"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// runTelemetry forwards selected native host events without blocking KubeArmor
// on backend availability. Its queue is memory bounded; losses are reported.
func runTelemetry(ctx context.Context) error {
	const certDir = "/var/lib/agentz/sensor-tls/"
	certificate, err := tls.LoadX509KeyPair(certDir+"client.crt", certDir+"client.key")
	if err != nil {
		return fmt.Errorf("sensor client certificate: %w", err)
	}
	ca, err := os.ReadFile(certDir + "ca.crt")
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return fmt.Errorf("invalid sensor CA")
	}
	conn, err := grpc.NewClient("127.0.0.1:32767", grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{certificate},
		// Stock KubeArmor uses the changing host IP in its server certificate.
		// A dedicated root-owned sensor CA pins this service independently of DNS.
		InsecureSkipVerify: true, // verification below uses the standard X.509 verifier
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return fmt.Errorf("sensor supplied no certificate")
			}
			intermediates := x509.NewCertPool()
			for _, cert := range state.PeerCertificates[1:] {
				intermediates.AddCert(cert)
			}
			_, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
				Roots: roots, Intermediates: intermediates,
				KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			})
			return err
		},
	})), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(64*1024)))
	if err != nil {
		return err
	}
	defer conn.Close()
	client := pb.NewLogServiceClient(conn)
	queue := make(chan compute.SecurityEvent, 256)
	var dropped atomic.Uint64
	enqueue := func(kind, parent string, message proto.Message) {
		if filepath.Base(parent) != "opencode" {
			return
		}
		data, err := protojson.Marshal(message)
		if err != nil || len(data) > 64*1024 {
			dropped.Add(1)
			return
		}
		select {
		case queue <- compute.SecurityEvent{Kind: kind, Event: data}:
		default:
			dropped.Add(1)
		}
	}
	var readers sync.WaitGroup
	for _, kind := range []string{"log", "alert"} {
		readers.Go(func() {
			for ctx.Err() == nil {
				var watchErr error
				if kind == "log" {
					stream, err := client.WatchLogs(ctx, &pb.RequestMessage{Filter: "all"})
					watchErr = err
					if err == nil {
						for {
							event, err := stream.Recv()
							if err != nil {
								watchErr = err
								break
							}
							if event.GetType() == "HostLog" {
								enqueue(kind, event.GetParentProcessName(), event)
							}
						}
					}
				} else {
					stream, err := client.WatchAlerts(ctx, &pb.RequestMessage{Filter: "all"})
					watchErr = err
					if err == nil {
						for {
							event, err := stream.Recv()
							if err != nil {
								watchErr = err
								break
							}
							if event.GetContainerID() == "" && event.GetType() == "MatchedHostPolicy" {
								enqueue(kind, event.GetParentProcessName(), event)
							}
						}
					}
				}
				if ctx.Err() != nil {
					return
				}
				slog.WarnContext(ctx, "native sensor stream interrupted", "kind", kind, "error", watchErr)
				select {
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
				}
			}
		})
	}
	defer readers.Wait()
	transport := &http.Transport{MaxIdleConnsPerHost: 1, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		var conn net.Conn
		err := inNamespace(func() error {
			var err error
			conn, err = (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, address)
			return err
		})
		return conn, err
	}}
	defer transport.CloseIdleConnections()
	httpClient := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	report := time.NewTicker(time.Minute)
	defer report.Stop()
	defer func() {
		if count := dropped.Load(); count > 0 {
			slog.WarnContext(ctx, "native telemetry events dropped", "count", count)
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-report.C:
			if count := dropped.Swap(0); count > 0 {
				slog.WarnContext(ctx, "native telemetry events dropped", "count", count)
			}
		case event := <-queue:
			data, err := json.Marshal(event)
			if err != nil {
				dropped.Add(1)
				continue
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:4186/events", bytes.NewReader(data))
			if err != nil {
				dropped.Add(1)
				continue
			}
			request.Header.Set("Content-Type", "application/json")
			response, err := httpClient.Do(request)
			if err != nil {
				dropped.Add(1)
				continue
			}
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				dropped.Add(1)
			}
		}
	}
}
