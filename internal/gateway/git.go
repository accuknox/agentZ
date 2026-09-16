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
	"iter"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/go-github/v91/github"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
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
	configured := s.cfg.CodingGitHubClientID != "" && s.cfg.CodingGitHubClientSecret != ""
	if err != nil || len(key) != 32 || !configured {
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
		values := url.Values{
			"client_id":     {s.cfg.CodingGitHubClientID},
			"client_secret": {s.cfg.CodingGitHubClientSecret},
			"grant_type":    {"refresh_token"},
			"refresh_token": {refresh},
		}
		req, err := http.NewRequestWithContext(
			ctx,
			http.MethodPost,
			"https://github.com/login/oauth/access_token",
			strings.NewReader(values.Encode()),
		)
		if err != nil {
			return identity, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		client := &http.Client{
			Timeout:       30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		}
		resp, err := client.Do(req)
		if err != nil {
			return identity, errors.New("could not refresh GitHub authorization")
		}
		defer resp.Body.Close()
		var token codingTokenResponse
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&token)
		validToken := token.AccessToken != "" && token.RefreshToken != "" &&
			token.ExpiresIn > 0 && token.RefreshIn > 0
		if err != nil || resp.StatusCode != http.StatusOK || !validToken {
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
			ExpiresAt: pgtype.Timestamptz{
				Time:  time.Now().Add(time.Duration(token.ExpiresIn) * time.Second),
				Valid: true,
			},
			RefreshExpiresAt: pgtype.Timestamptz{
				Time:  time.Now().Add(time.Duration(token.RefreshIn) * time.Second),
				Valid: true,
			},
		})
		if err != nil {
			return identity, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return identity, err
	}
	identity.client, err = github.NewClient(
		github.WithAuthToken(identity.token),
		github.WithHTTPClient(&http.Client{Timeout: 30 * time.Second}),
	)
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

// repositories yields repositories both the app and user can publish to.
// Public repository metadata alone does not establish installation access.
func (identity codingIdentity) repositories(ctx context.Context) iter.Seq2[*github.Repository, error] {
	return func(yield func(*github.Repository, error) bool) {
		opts := &github.ListOptions{PerPage: 100}
		for installation, err := range identity.client.Apps.ListUserInstallationsIter(ctx, opts) {
			if err != nil {
				yield(nil, err)
				return
			}
			permissions := installation.GetPermissions()
			writable := permissions.GetContents() == "write" &&
				permissions.GetPullRequests() == "write" &&
				permissions.GetWorkflows() == "write"
			if installation.SuspendedAt != nil || !writable {
				continue
			}
			for repo, err := range identity.client.Apps.ListUserReposIter(ctx, installation.GetID(), opts) {
				if err != nil {
					yield(nil, err)
					return
				}
				if repo.GetArchived() || repo.GetDisabled() || !repo.GetPermissions().GetPush() {
					continue
				}
				if !yield(repo, nil) {
					return
				}
			}
		}
	}
}

func (identity codingIdentity) repository(ctx context.Context, id int64) (*github.Repository, error) {
	for repo, err := range identity.repositories(ctx) {
		if err != nil {
			return nil, fmt.Errorf("check GitHub repository access: %w", err)
		}
		if repo.GetID() == id {
			return repo, nil
		}
	}
	return nil, apiutil.NewError(
		http.StatusForbidden, "repository_access",
		"Repository is not writable through the Coding GitHub App. Check repository access and Contents, Workflows, and Pull requests write permissions in GitHub installation settings.",
		nil,
	)
}

// ListCodingRepositories lists repositories using only the caller's installation access.
func (s *Service) ListCodingRepositories(w http.ResponseWriter, r *http.Request, params gatewayapi.ListCodingRepositoriesParams) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	identity, err := s.codingIdentity(r.Context(), access.claims.UserID)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "github_failed", err.Error(), err))
		return
	}
	page := 1
	if params.Page != nil {
		page = *params.Page
	}
	query := ""
	if params.Query != nil {
		query = strings.ToLower(strings.TrimSpace(*params.Query))
	}
	result := gatewayapi.CodingRepositoryPage{Repositories: []gatewayapi.CodingRepositoryItem{}}
	seen := make(map[int64]bool)
	for repo, err := range identity.repositories(r.Context()) {
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadGateway, "github_failed",
				"Could not list repositories accessible to the Coding GitHub App", err,
			))
			return
		}
		if seen[repo.GetID()] || !strings.Contains(strings.ToLower(repo.GetFullName()), query) {
			continue
		}
		seen[repo.GetID()] = true
		result.Repositories = append(result.Repositories, gatewayapi.CodingRepositoryItem{
			Id: repo.GetID(), Name: repo.GetFullName(), Private: repo.GetPrivate(),
		})
	}
	slices.SortFunc(result.Repositories, func(a, b gatewayapi.CodingRepositoryItem) int {
		return strings.Compare(a.Name, b.Name)
	})
	// Bound the page before multiplying so arbitrary API input cannot overflow.
	start := len(result.Repositories)
	if page > 0 && page-1 <= len(result.Repositories)/50 {
		start = (page - 1) * 50
	}
	end := start + min(50, len(result.Repositories)-start)
	if end < len(result.Repositories) {
		result.NextPage = new(page + 1)
	}
	result.Repositories = result.Repositories[start:end]
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// newCodingRepository creates a credential-free bare repository for one trusted
// operation. Agent configuration and executables never enter this directory.
func newCodingRepository(ctx context.Context, repository, token string) (*codingRepository, error) {
	owner, name, ok := strings.Cut(repository, "/")
	invalidName := strings.ContainsAny(repository, "\\\n\r :@?#") ||
		strings.Contains(name, "/")
	if !ok || owner == "" || name == "" || invalidName {
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
	options := []string{
		"--no-pager",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		// This repository lasts one operation. Background repacking can remove
		// pack indexes while the next import verifies them.
		"-c",
		"maintenance.auto=false",
		"-c",
		"credential.helper=",
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.file.allow=always",
		"-c",
		"submodule.recurse=false",
		"-c",
		"fetch.fsckObjects=true",
		"-c",
		"transfer.fsckObjects=true",
	}
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + repo.dir,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ATTR_NOSYSTEM=1",
		"LC_ALL=C",
	}
	if remote {
		options = append(options, "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false")
		credentials := base64.StdEncoding.EncodeToString(
			[]byte("x-access-token:" + repo.token),
		)
		env = append(
			env,
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader",
			"GIT_CONFIG_VALUE_0=Authorization: Basic "+credentials,
		)
	}
	cmd := exec.CommandContext(ctx, "git", append(options, args...)...)
	cmd.Dir, cmd.Env = repo.dir, env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", err
	}
	// Drain both pipes before Wait. Retain only bounded diagnostics, since
	// GitHub and repository objects can contribute arbitrary error output.
	diagnostics := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(io.LimitReader(stderr, 16<<10))
		_, _ = io.Copy(io.Discard, stderr)
		diagnostics <- strings.TrimSpace(string(data))
	}()
	out, readErr := io.ReadAll(io.LimitReader(stdout, (64<<20)+1))
	if readErr != nil || len(out) > 64<<20 {
		cmd.Process.Kill()
	}
	detail := <-diagnostics
	err = cmd.Wait()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if len(out) > 64<<20 {
		return "", errors.New("git output exceeds 64 MiB")
	}
	if readErr != nil {
		return "", fmt.Errorf("read Git output: %w", readErr)
	}
	if err != nil {
		if repo.token != "" {
			credentials := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + repo.token))
			redact := strings.NewReplacer(
				repo.token, "[REDACTED]", credentials, "[REDACTED]",
			)
			detail = redact.Replace(detail)
		}
		if detail == "" {
			return "", fmt.Errorf("git failed: %w", err)
		}
		return "", fmt.Errorf("git failed: %s: %w", detail[:min(len(detail), 8<<10)], err)
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
	_, err := repo.run(
		ctx,
		false,
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		file,
		"+refs/heads/*:refs/heads/*",
		"+refs/agentz/export:refs/agentz/export",
	)
	if err != nil {
		return err
	}
	_, err = repo.run(ctx, false, "fsck", "--strict", "--no-reflogs")
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
