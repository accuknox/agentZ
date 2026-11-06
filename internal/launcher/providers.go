package launcher

func supportedProvider(provider string) bool {
	switch provider {
	case "claude", "codex", "chatgpt-desktop", "claude-desktop", "github-copilot-cli", "github-copilot-desktop":
		return true
	default:
		return false
	}
}

// Native gateway OAuth is available in Codex and ChatGPT. The adapter owns
// resource-bound OAuth credentials for clients that only accept provider keys.
func (installed *installation) adapter() bool {
	switch installed.Provider {
	case "claude-desktop", "github-copilot-cli", "github-copilot-desktop":
		return true
	default:
		return false
	}
}
