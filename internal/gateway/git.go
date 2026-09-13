package gateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/go-github/v91/github"
	"github.com/jackc/pgx/v5/pgtype"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type codingIdentity struct {
	client *github.Client
	token  string
	name   string
	email  string
}

type codingTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshIn    int64  `json:"refresh_token_expires_in"`
}

type codingRepository struct {
	dir   string
	url   string
	token string
}

// codingIdentity refreshes under the account flow's lock so rotating credentials
// remain usable by both Go workers and the account connection UI.
func (s *Service) codingIdentity(ctx context.Context, userID string) (codingIdentity, error) {
	var identity codingIdentity
	retry, err := s.queries.GatewayCodingCooldown(ctx, userID)
	if err != nil {
		return identity, err
	}
	if time.Now().Before(retry) {
		return identity, fmt.Errorf("GitHub requests are paused until %s", retry.UTC().Format(time.RFC3339))
	}
	key, err := hex.DecodeString(s.cfg.CodingGitHubEncryptionKey)
	if err != nil || len(key) != 32 || s.cfg.CodingGitHubClientID == "" || s.cfg.CodingGitHubClientSecret == "" {
		return identity, errors.New("the Coding GitHub App is not configured")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return identity, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return identity, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return identity, err
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	if _, err := q.GatewayLockCodingIdentity(ctx, userID); err != nil {
		return identity, err
	}
	conn, err := q.GatewayCodingConnection(ctx, userID)
	if err != nil {
		return identity, errors.New("connect your GitHub account in account settings")
	}
	aad := fmt.Appendf(nil, "agentz:github:%s:%d", userID, conn.GithubUserID)
	open := func(encoded string) (string, error) {
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) < gcm.NonceSize()+gcm.Overhead() {
			return "", errors.New("invalid GitHub credentials; reconnect your account")
		}
		plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], aad)
		return string(plain), err
	}
	identity.token, err = open(conn.AccessToken)
	if err != nil {
		return identity, errors.New("cannot decrypt GitHub credentials; reconnect your account")
	}
	if time.Until(conn.ExpiresAt.Time) < time.Minute {
		if time.Now().After(conn.RefreshExpiresAt.Time) {
			return identity, errors.New("GitHub authorization expired; reconnect your account")
		}
		refresh, err := open(conn.RefreshToken)
		if err != nil {
			return identity, errors.New("cannot decrypt GitHub credentials; reconnect your account")
		}
		values := url.Values{"client_id": {s.cfg.CodingGitHubClientID}, "client_secret": {s.cfg.CodingGitHubClientSecret}, "grant_type": {"refresh_token"}, "refresh_token": {refresh}}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(values.Encode()))
		if err != nil {
			return identity, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Do(req)
		if err != nil {
			return identity, errors.New("could not refresh GitHub authorization")
		}
		defer resp.Body.Close()
		var token codingTokenResponse
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&token)
		if err != nil || resp.StatusCode != http.StatusOK || token.AccessToken == "" || token.RefreshToken == "" || token.ExpiresIn <= 0 || token.RefreshIn <= 0 {
			return identity, errors.New("GitHub authorization expired; reconnect your account")
		}
		seal := func(token string) string {
			nonce := make([]byte, gcm.NonceSize())
			rand.Read(nonce)
			return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(token), aad))
		}
		identity.token = token.AccessToken
		err = q.GatewayRefreshCodingConnection(ctx, gatewaydb.GatewayRefreshCodingConnectionParams{
			UserID: userID, AccessToken: seal(token.AccessToken), RefreshToken: seal(token.RefreshToken),
			ExpiresAt:        pgtype.Timestamptz{Time: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second), Valid: true},
			RefreshExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Duration(token.RefreshIn) * time.Second), Valid: true},
		})
		if err != nil {
			return identity, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return identity, err
	}
	identity.client, err = github.NewClient(github.WithAuthToken(identity.token), github.WithHTTPClient(&http.Client{Timeout: 30 * time.Second}))
	if err != nil {
		return identity, err
	}
	user, _, err := identity.client.Users.Get(ctx, "")
	if err != nil {
		return identity, err
	}
	if user.GetID() != conn.GithubUserID {
		return identity, errors.New("GitHub account identity changed; reconnect your account")
	}
	identity.name = user.GetName()
	if identity.name == "" {
		identity.name = user.GetLogin()
	}
	identity.email = fmt.Sprintf("%d+%s@users.noreply.github.com", user.GetID(), user.GetLogin())
	return identity, nil
}

// ListCodingRepositories lists repositories using only the caller's connection.
func (s *Service) ListCodingRepositories(w http.ResponseWriter, r *http.Request, params gatewayapi.ListCodingRepositoriesParams) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	identity, err := s.codingIdentity(r.Context(), access.claims.UserID)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusBadGateway, "github_failed", err.Error(), err))
		return
	}
	page := 1
	if params.Page != nil {
		page = *params.Page
	}
	var repos []*github.Repository
	var response *github.Response
	result := gatewayapi.CodingRepositoryPage{Repositories: []gatewayapi.CodingRepositoryItem{}}
	if params.Query != nil && *params.Query != "" {
		if page > 20 {
			writeError(w, r, newAPIError(http.StatusBadRequest, "search_limit", "Narrow your repository search", nil))
			return
		}
		var found *github.RepositoriesSearchResult
		found, response, err = identity.client.Search.Repositories(r.Context(), *params.Query+" in:name fork:true", &github.SearchOptions{ListOptions: github.ListOptions{Page: page, PerPage: 50}})
		if found != nil {
			repos = found.Repositories
			result.Limited = found.GetIncompleteResults() || found.GetTotal() > 1000
		}
	} else {
		repos, response, err = identity.client.Repositories.ListByAuthenticatedUser(r.Context(), &github.RepositoryListByAuthenticatedUserOptions{Sort: "updated", ListOptions: github.ListOptions{Page: page, PerPage: 50}})
	}
	if err != nil {
		writeError(w, r, newAPIError(http.StatusBadGateway, "github_failed", "Could not list GitHub repositories", err))
		return
	}
	for _, repo := range repos {
		result.Repositories = append(result.Repositories, gatewayapi.CodingRepositoryItem{Id: repo.GetID(), Name: repo.GetFullName(), Private: repo.GetPrivate()})
	}
	if response.NextPage > 0 {
		result.NextPage = &response.NextPage
	}
	writeJSON(w, http.StatusOK, result)
}

// newCodingRepository creates a credential-free bare repository for one trusted
// operation. Agent configuration and executables never enter this directory.
func newCodingRepository(ctx context.Context, repository, token string) (*codingRepository, error) {
	owner, name, ok := strings.Cut(repository, "/")
	if !ok || owner == "" || name == "" || strings.ContainsAny(repository, "\\\n\r :@?#") || strings.Contains(name, "/") {
		return nil, errors.New("invalid GitHub repository")
	}
	dir, err := os.MkdirTemp("", "agentz-git-")
	if err != nil {
		return nil, err
	}
	repo := &codingRepository{dir: dir, url: "https://github.com/" + repository + ".git", token: token}
	if _, err := repo.run(ctx, false, "init", "--bare", "."); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	return repo, nil
}

func (repo *codingRepository) run(ctx context.Context, remote bool, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	options := []string{"--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true"}
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + repo.dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_ATTR_NOSYSTEM=1", "LC_ALL=C"}
	if remote {
		options = append(options, "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false")
		env = append(env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader", "GIT_CONFIG_VALUE_0=Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+repo.token)))
	}
	cmd := exec.CommandContext(ctx, "git", append(options, args...)...)
	cmd.Dir, cmd.Env = repo.dir, env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", err
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, (64<<20)+1))
	if readErr != nil || len(out) > 64<<20 {
		cmd.Process.Kill()
	}
	err = cmd.Wait()
	if err != nil || readErr != nil || len(out) > 64<<20 {
		return "", fmt.Errorf("git %s failed; refresh the checkout and verify repository access", args[0])
	}
	return strings.TrimRight(string(out), "\r\n"), nil
}

func (repo *codingRepository) importBundle(ctx context.Context, bundle []byte) error {
	if len(bundle) > 64<<20 {
		return errors.New("repository transfer exceeds 64 MiB")
	}
	file := filepath.Join(repo.dir, "input.bundle")
	if err := os.WriteFile(file, bundle, 0600); err != nil {
		return err
	}
	defer os.Remove(file)
	if _, err := repo.run(ctx, false, "bundle", "verify", file); err != nil {
		return err
	}
	if _, err := repo.run(ctx, false, "fetch", "--no-tags", "--no-recurse-submodules", file, "+refs/heads/*:refs/heads/*", "+refs/agentz/export:refs/agentz/export"); err != nil {
		return err
	}
	_, err := repo.run(ctx, false, "fsck", "--strict", "--no-reflogs")
	return err
}

func (repo *codingRepository) exportBundle(ctx context.Context) ([]byte, error) {
	file := filepath.Join(repo.dir, "output.bundle")
	defer os.Remove(file)
	if _, err := repo.run(ctx, false, "bundle", "create", file, "--branches"); err != nil {
		return nil, err
	}
	stat, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if stat.Size() > 64<<20 {
		return nil, errors.New("repository transfer exceeds 64 MiB")
	}
	return os.ReadFile(file)
}

func (repo *codingRepository) fetchBundle(ctx context.Context) ([]byte, error) {
	_, err := repo.run(ctx, true, "fetch", "--no-tags", repo.url, "+refs/heads/*:refs/heads/*")
	if err != nil {
		return nil, err
	}
	return repo.exportBundle(ctx)
}
