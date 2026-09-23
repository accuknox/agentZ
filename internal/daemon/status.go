package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/accuknox/agentz/internal/host"
)

type snapshot struct {
	Connected bool        `json:"connected"`
	UpdatedAt time.Time   `json:"updated_at"`
	Runtime   host.Status `json:"runtime"`
}

func (s *supervisor) report() host.Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := snapshot{Connected: s.connected, UpdatedAt: time.Now(), Runtime: s.status}
	if data, err := json.Marshal(state); err == nil {
		if err := os.MkdirAll("/run/agentz", 0755); err == nil {
			if err := os.WriteFile("/run/agentz/daemon-status.json.next", data, 0600); err == nil {
				_ = os.Rename("/run/agentz/daemon-status.json.next", "/run/agentz/daemon-status.json")
			}
		}
	}
	return state.Runtime
}

// Diagnose reports local service and transport state. Doctor also checks the
// enrolled host's non-mutating prerequisites. It never emits stored credentials.
func Diagnose(ctx context.Context, configPath string, doctor bool, output io.Writer) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read enrollment: %w", err)
	}
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("read enrollment: %w", err)
	}
	fmt.Fprintf(output, "User: %s\nWork directory: %s\n", config.Username, config.WorkDirectory)
	var failures []error
	for _, unit := range []string{"agentz-spire.service", "agentz-daemon.service", "agentz-opencode.service", "agentz-filesystem.service", "agentz-kubearmor.service"} {
		state, err := exec.CommandContext(ctx, "systemctl", "is-active", unit).Output()
		fmt.Fprintf(output, "%s: %s\n", unit, strings.TrimSpace(string(state)))
		if err != nil {
			failures = append(failures, fmt.Errorf("%s is not active", unit))
		}
	}
	data, err = os.ReadFile("/run/agentz/daemon-status.json")
	if err != nil {
		failures = append(failures, fmt.Errorf("live daemon status unavailable: %w", err))
	} else {
		var state snapshot
		if err := json.Unmarshal(data, &state); err != nil {
			failures = append(failures, fmt.Errorf("decode live status: %w", err))
		} else {
			stale := time.Since(state.UpdatedAt) > time.Minute
			fmt.Fprintf(output, "Backend connected: %t\nRuntime ready: %t\nStatus last updated: %s\n", state.Connected && !stale, state.Runtime.Ready && !stale, state.UpdatedAt.Format(time.RFC3339))
			if state.Runtime.Error != "" {
				fmt.Fprintf(output, "Runtime error: %s\n", state.Runtime.Error)
			}
			if stale || !state.Connected || !state.Runtime.Ready {
				failures = append(failures, errors.New("host is not ready for remote work"))
			}
		}
	}
	if doctor {
		for _, program := range []string{"systemctl", "ip", "nft", "nix", "runuser"} {
			location, err := exec.LookPath(program)
			if err != nil {
				// sudo may reset PATH; check the same installed tools as the service.
				for _, directory := range []string{"/var/lib/agentz/runtime/tools/bin", "/nix/var/nix/profiles/default/bin"} {
					candidate := filepath.Join(directory, program)
					if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
						location, err = candidate, nil
						break
					}
				}
			}
			if err != nil {
				fmt.Fprintf(output, "%s: missing\n", program)
				failures = append(failures, err)
				continue
			}
			fmt.Fprintf(output, "%s: %s\n", program, location)
		}
		info, err := os.Stat(configPath)
		if err != nil || info.Mode().Perm()&0077 != 0 {
			failures = append(failures, errors.New("enrollment configuration must have mode 0600"))
		}
		socket := strings.TrimPrefix(config.WorkloadSocket, "unix://")
		if socket == "" {
			socket = "/run/agentz/spire/api.sock"
		}
		info, err = os.Stat(socket)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			failures = append(failures, errors.New("SPIRE workload socket is unavailable"))
		}
		if _, err := os.Stat(filepath.Join(config.RuntimeDirectory, "bin/opencode")); err != nil {
			failures = append(failures, fmt.Errorf("native OpenCode runtime unavailable: %w", err))
		}
		if _, err := os.Stat("/run/netns/agentz"); err != nil {
			failures = append(failures, fmt.Errorf("managed network namespace unavailable: %w", err))
		}
	}
	return errors.Join(failures...)
}
