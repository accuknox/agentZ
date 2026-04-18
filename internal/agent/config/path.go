package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	envName       = "CLAWARMOR_CONFIG"
	localFileName = "clawarmor.yaml"
	xdgConfigPath = "clawarmor/config.yaml"
)

func filePathIfExists(path string) (string, bool, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", false, nil
	}

	absPath, err := filepath.Abs(trimmed)
	if err != nil {
		return "", false, fmt.Errorf("resolve path %q failed: %w", path, err)
	}

	st, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return absPath, false, nil
		}
		return "", false, fmt.Errorf("stat path %q failed: %w", absPath, err)
	}
	if st.IsDir() {
		return "", false, fmt.Errorf("config path %q is a directory", absPath)
	}

	return absPath, true, nil
}

// ResolvePath resolves configuration precedence for the agent runtime.
func ResolvePath(explicitPath string) (string, error) {
	if strings.TrimSpace(explicitPath) != "" {
		resolvedPath, ok, err := filePathIfExists(explicitPath)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", fmt.Errorf("config path %q does not exist", resolvedPath)
		}
		return resolvedPath, nil
	}

	envPath := strings.TrimSpace(os.Getenv(envName))
	if envPath != "" {
		resolvedPath, ok, err := filePathIfExists(envPath)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", fmt.Errorf("config path %q does not exist", resolvedPath)
		}
		return resolvedPath, nil
	}

	localPath, ok, err := filePathIfExists(localFileName)
	if err != nil {
		return "", err
	}
	if ok {
		return localPath, nil
	}

	xdgRoot := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if xdgRoot == "" {
		homeDir, homeErr := os.UserHomeDir()
		if homeErr == nil {
			xdgRoot = filepath.Join(homeDir, ".config")
		}
	}
	if xdgRoot != "" {
		resolvedPath, ok, err := filePathIfExists(
			filepath.Join(xdgRoot, xdgConfigPath),
		)
		if err != nil {
			return "", err
		}
		if ok {
			return resolvedPath, nil
		}
	}

	return "", fmt.Errorf(
		"no config found: use --config, %s, %s, or %s",
		envName,
		localFileName,
		xdgConfigPath,
	)
}
