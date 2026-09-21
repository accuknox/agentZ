package daemon

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"golang.org/x/sys/unix"
)

type enrollmentFile struct {
	name    string
	content []byte
}

// Enroll exchanges a one-use browser code and persists SPIRE's native bootstrap.
// Runtime updates use the existing identity and must not call Enroll again.
func Enroll(ctx context.Context, backend, username, workdir, runtimeDirectory, configHome, dataHome, stateHome, cacheHome string, input io.Reader, output io.Writer) error {
	if os.Geteuid() != 0 {
		return errors.New("enrollment requires sudo")
	}
	account, err := user.Lookup(username)
	if err != nil {
		return fmt.Errorf("look up invoking user: %w", err)
	}
	if account.Uid == "0" {
		return errors.New("choose the non-root user who will run OpenCode")
	}
	if workdir == "" {
		workdir = filepath.Join(account.HomeDir, "agentz")
	}
	if !filepath.IsAbs(workdir) || strings.ContainsAny(workdir, "\x00\n\r") {
		return errors.New("workdir must be an absolute path")
	}
	if !filepath.IsAbs(runtimeDirectory) || strings.ContainsAny(runtimeDirectory, "\x00\n\r") {
		return errors.New("native runtime directory must be absolute")
	}
	if configHome == "" {
		configHome = filepath.Join(account.HomeDir, ".config")
	}
	if !filepath.IsAbs(configHome) || strings.ContainsAny(configHome, "\x00\n\r") {
		return errors.New("config-home must be an absolute path")
	}
	if dataHome == "" {
		dataHome = filepath.Join(account.HomeDir, ".local/share")
	}
	if stateHome == "" {
		stateHome = filepath.Join(account.HomeDir, ".local/state")
	}
	if cacheHome == "" {
		cacheHome = filepath.Join(account.HomeDir, ".cache")
	}
	for _, dir := range []string{dataHome, stateHome, cacheHome} {
		if !filepath.IsAbs(dir) || strings.ContainsAny(dir, "\x00\n\r") {
			return errors.New("XDG directories must be absolute paths")
		}
	}
	endpoint, err := url.Parse(backend)
	if err != nil {
		return err
	}
	invalidEndpoint := endpoint.Scheme != "https" || endpoint.Host == "" ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != ""
	if invalidEndpoint {
		return errors.New("backend must be an HTTPS URL without credentials, query or fragment")
	}
	_, err = os.Lstat("/etc/agentz/daemon.json")
	if err == nil {
		return errors.New("this host is already enrolled; disconnect it in AgentZ before re-enrollment")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect enrollment state: %w", err)
	}
	for _, dir := range []string{"/etc/agentz", "/var/lib/agentz/spire", "/var/lib/agentz/daemon", "/run/agentz/spire"} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		var stat unix.Stat_t
		if err := unix.Lstat(dir, &stat); err != nil {
			return err
		}
		if stat.Uid != 0 || stat.Mode&unix.S_IFMT != unix.S_IFDIR {
			return fmt.Errorf("identity directory %s must be an actual root-owned directory", dir)
		}
		if err := os.Chmod(dir, 0700); err != nil {
			return err
		}
	}
	fmt.Fprint(output, "Paste the one-use enrollment code from your Agent's setup screen: ")
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 256), 256)
	if !scanner.Scan() {
		return errors.Join(errors.New("enrollment code is required"), scanner.Err())
	}
	code := strings.TrimSpace(scanner.Text())
	if len(code) != 43 {
		return errors.New("enrollment code is invalid")
	}
	hostname, err := os.Hostname()
	if err != nil {
		return err
	}
	httpClient := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	client, err := gatewayapi.NewClientWithResponses(
		strings.TrimRight(backend, "/"), gatewayapi.WithHTTPClient(httpClient),
	)
	if err != nil {
		return err
	}
	response, err := client.RedeemComputeEnrollmentWithResponse(ctx, gatewayapi.RedeemComputeEnrollmentRequest{Code: code, Hostname: hostname, WorkDirectory: workdir})
	if err != nil {
		return fmt.Errorf("redeem enrollment: %w", err)
	}
	if response.JSON200 == nil {
		return fmt.Errorf("enrollment rejected (%s); obtain a fresh code in AgentZ", response.Status())
	}
	enrollment := response.JSON200
	host, port, err := net.SplitHostPort(enrollment.SpireServer)
	if err != nil {
		return fmt.Errorf("invalid SPIRE address: %w", err)
	}
	portNumber, err := strconv.ParseUint(port, 10, 16)
	if err != nil || portNumber == 0 {
		return errors.New("invalid SPIRE server port")
	}
	if _, err := spiffeid.TrustDomainFromString(enrollment.TrustDomain); err != nil {
		return fmt.Errorf("invalid SPIRE trust domain: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(enrollment.TrustBundle)) {
		return errors.New("enrollment returned an invalid trust bundle")
	}
	config := Config{
		WorkloadID:       enrollment.WorkloadId,
		Backend:          enrollment.ComputeServer,
		ServerSPIFFEID:   "spiffe://" + enrollment.TrustDomain + "/agentz/backend",
		WorkloadSocket:   "unix:///run/agentz/spire/api.sock",
		Username:         username,
		XDGConfigHome:    configHome,
		XDGDataHome:      dataHome,
		XDGStateHome:     stateHome,
		XDGCacheHome:     cacheHome,
		WorkDirectory:    workdir,
		StateDirectory:   "/var/lib/agentz/daemon",
		RuntimeDirectory: runtimeDirectory,
		Executable:       "/usr/local/lib/agentz/agentz",
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	spireConfig := fmt.Sprintf(`agent {
 trust_domain = %q
 server_address = %q
 server_port = %d
 trust_bundle_path = "/etc/agentz/trust-bundle.pem"
 socket_path = "/run/agentz/spire/api.sock"
 data_dir = "/var/lib/agentz/spire"
 availability_target = "4800h"
 join_token_file = "/etc/agentz/join-token"
}
plugins {
 KeyManager "disk" { plugin_data { directory = "/var/lib/agentz/spire/keys" } }
 NodeAttestor "join_token" { plugin_data {} }
 WorkloadAttestor "unix" { plugin_data { discover_workload_path = true workload_size_limit = -1 } }
}
`, enrollment.TrustDomain, host, portNumber)
	// daemon.json is the enrollment marker and is published only after SPIRE
	// configuration and trust are durable. Rename avoids following stale symlinks.
	files := []enrollmentFile{
		{"trust-bundle.pem", []byte(enrollment.TrustBundle)},
		{"join-token", []byte(enrollment.JoinToken)},
		{"spire.conf", []byte(spireConfig)},
		{"daemon.json", data},
	}
	directory, err := os.Open("/etc/agentz")
	if err != nil {
		return err
	}
	defer directory.Close()
	for _, file := range files {
		temporary, err := os.CreateTemp("/etc/agentz", ".enrollment-*")
		if err != nil {
			return err
		}
		defer os.Remove(temporary.Name())
		_, writeErr := temporary.Write(file.content)
		syncErr := temporary.Sync()
		closeErr := temporary.Close()
		if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
			return err
		}
		if err := os.Rename(temporary.Name(), filepath.Join("/etc/agentz", file.name)); err != nil {
			return err
		}
		if err := directory.Sync(); err != nil {
			return err
		}
	}
	command := exec.CommandContext(ctx, "systemctl", "enable", "--now", "agentz-spire.service", "agentz-daemon.service")
	command.Stdout, command.Stderr = output, output
	if err := command.Run(); err != nil {
		return fmt.Errorf("start native services: %w", err)
	}
	fmt.Fprintln(output, "Host enrolled. AgentZ is preparing your sandbox. Check connection status in the app or run: agentz daemon status")
	return nil
}
