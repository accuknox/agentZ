/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package filesystem serves confined access to an agent workspace.
package filesystem

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const (
	maxBodyBytes    = 8 << 20
	maxContentBytes = 1 << 20
	maxTextRunes    = 200_000
)

var (
	errInvalidEntryType = errors.New("invalid entry type")
	errUnsupportedMedia = errors.New("unsupported media type")
)

// Config configures the workspace filesystem server.
type Config struct {
	Addr string
	Root string
}

type service struct {
	root *os.Root
	mu   sync.Mutex
}

type failure struct {
	status  int
	code    string
	message string
	cause   error
	current *gatewayapi.AgentFileMetadata
}

// Serve starts the workspace filesystem server and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	root, err := os.OpenRoot(cfg.Root)
	if err != nil {
		return fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	s := &service{root: root}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(
			ctx, "starting workspace filesystem server",
			slog.String("addr", cfg.Addr),
			slog.String("root", cfg.Root),
		)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		if err := srv.Close(); err != nil {
			return fmt.Errorf("close filesystem server: %w", err)
		}
		err = <-errCh
	case err = <-errCh:
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve filesystem http: %w", err)
	}
	return nil
}

func (s *service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /file", s.readFile)
	mux.HandleFunc("POST /file", s.createFile)
	mux.HandleFunc("PUT /file", s.writeFile)
	mux.HandleFunc("GET /stat", s.stat)
	mux.HandleFunc("GET /raw", s.readRaw)
	mux.HandleFunc("POST /directory", s.createDirectory)
	mux.HandleFunc("POST /rename", s.rename)
	mux.HandleFunc("DELETE /entry", s.deleteEntry)
	mux.HandleFunc("GET /skill", s.listSkills)
	mux.HandleFunc("DELETE /skill", s.deleteSkills)
	mux.HandleFunc("POST /skill/export", s.exportSkills)
	mux.HandleFunc("POST /skill/import", s.importSkills)
	return mux
}

func (s *service) readFile(w http.ResponseWriter, r *http.Request) {
	name, ferr := requestPath(r)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	file, ferr := s.text(name)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	writeJSON(w, http.StatusOK, file)
}

func (s *service) createFile(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateAgentFileRequest
	if ferr := decodeBody(w, r, &req); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	if ferr := checkPath(req.Path); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	parent := path.Dir(req.Path)
	if parent != "." {
		if err := s.root.MkdirAll(parent, 0o700); err != nil {
			writeFailure(w, r, pathFailure(err))
			return
		}
	}

	f, err := s.root.OpenFile(req.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	if err := f.Close(); err != nil {
		writeFailure(w, r, internalFailure("close created file", err))
		return
	}

	meta, err := s.metadata(req.Path)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	writeJSON(w, http.StatusCreated, meta)
}

func (s *service) writeFile(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.WriteAgentFileRequest
	if ferr := decodeBody(w, r, &req); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	if ferr := checkPath(req.Path); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	if req.ExpectedVersion == "" {
		writeFailure(w, r, badRequest("expected_version is required", nil))
		return
	}
	if len(req.Content) > maxContentBytes {
		writeFailure(w, r, requestTooLarge())
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	meta, err := s.metadata(req.Path)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	overwrite := req.Overwrite != nil && *req.Overwrite
	if !overwrite && meta.Version != req.ExpectedVersion {
		writeFailure(w, r, versionConflict(meta))
		return
	}

	info, err := s.root.Stat(req.Path)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	tmp := path.Join(path.Dir(req.Path), "."+path.Base(req.Path)+".agentz-"+rand.Text())
	f, err := s.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	removeTmp := true
	defer func() {
		if !removeTmp {
			return
		}
		err := s.root.Remove(tmp)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.ErrorContext(
				r.Context(), "remove temporary file",
				slog.String("path", req.Path),
				slog.Any("err", err),
			)
		}
	}()

	_, writeErr := io.WriteString(f, req.Content)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		writeFailure(w, r, internalFailure("write temporary file", err))
		return
	}

	if !overwrite {
		exchanged, err := exchangeFiles(s.root, tmp, req.Path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeFailure(w, r, pathFailure(err))
				return
			}
			writeFailure(w, r, internalFailure("replace file atomically", err))
			return
		}

		currentPath := req.Path
		if exchanged {
			currentPath = tmp
		}
		current, err := s.metadata(currentPath)
		if err != nil {
			if !exchanged {
				writeFailure(w, r, pathFailure(err))
				return
			}
			restored, restoreErr := exchangeFiles(s.root, tmp, req.Path)
			if restoreErr == nil && !restored {
				restoreErr = errors.New("atomic file exchange unavailable during restore")
			}
			if restoreErr != nil {
				removeTmp = false
			}
			writeFailure(
				w,
				r,
				internalFailure(
					"validate replaced file",
					errors.Join(err, restoreErr),
				),
			)
			return
		}
		current.Path = req.Path
		if current.Version != req.ExpectedVersion {
			if exchanged {
				restored, restoreErr := exchangeFiles(s.root, tmp, req.Path)
				if restoreErr == nil && !restored {
					restoreErr = errors.New("atomic file exchange unavailable during restore")
				}
				if restoreErr != nil {
					removeTmp = false
					writeFailure(
						w,
						r,
						internalFailure("restore version-conflicted file", restoreErr),
					)
					return
				}
			}
			writeFailure(w, r, versionConflict(current))
			return
		}
		if !exchanged {
			if err := s.root.Rename(tmp, req.Path); err != nil {
				writeFailure(w, r, pathFailure(err))
				return
			}
		}
	}
	if overwrite {
		if err := s.root.Rename(tmp, req.Path); err != nil {
			writeFailure(w, r, pathFailure(err))
			return
		}
	}

	meta, err = s.metadata(req.Path)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *service) stat(w http.ResponseWriter, r *http.Request) {
	name, ferr := requestPath(r)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	meta, err := s.metadata(name)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *service) readRaw(w http.ResponseWriter, r *http.Request) {
	name, ferr := requestPath(r)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	f, err := s.root.Open(name)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	if !info.Mode().IsRegular() {
		writeFailure(w, r, invalidEntryType())
		return
	}

	w.Header().Set("Content-Type", mediaType(name))
	http.ServeContent(w, r, path.Base(name), info.ModTime(), f)
}

func (s *service) createDirectory(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateAgentDirectoryRequest
	if ferr := decodeBody(w, r, &req); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	if ferr := checkPath(req.Path); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.root.Mkdir(req.Path, 0o700); err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	meta, err := s.metadata(req.Path)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	writeJSON(w, http.StatusCreated, meta)
}

func (s *service) rename(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.RenameAgentEntryRequest
	if ferr := decodeBody(w, r, &req); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	if ferr := checkPath(req.Path); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	if ferr := checkPath(req.Target); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.root.Stat(req.Path); err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	_, err := s.root.Lstat(req.Target)
	if err == nil {
		writeFailure(w, r, entryExists())
		return
	}
	if !errors.Is(err, os.ErrNotExist) {
		writeFailure(w, r, pathFailure(err))
		return
	}
	if err := s.root.Rename(req.Path, req.Target); err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	meta, err := s.metadata(req.Target)
	if err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *service) deleteEntry(w http.ResponseWriter, r *http.Request) {
	name, ferr := requestPath(r)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.root.Lstat(name); err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	if err := s.root.RemoveAll(name); err != nil {
		writeFailure(w, r, pathFailure(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *service) text(name string) (gatewayapi.AgentFile, *failure) {
	f, err := s.root.Open(name)
	if err != nil {
		return gatewayapi.AgentFile{}, pathFailure(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return gatewayapi.AgentFile{}, pathFailure(err)
	}
	if !info.Mode().IsRegular() {
		return gatewayapi.AgentFile{}, invalidEntryType()
	}

	hash := sha256.New()
	prefix, err := io.ReadAll(io.LimitReader(io.TeeReader(f, hash), maxTextRunes*utf8.UTFMax+1))
	if err != nil {
		return gatewayapi.AgentFile{}, internalFailure("read file", err)
	}
	end := 0
	for range maxTextRunes {
		if end == len(prefix) {
			break
		}
		r, size := utf8.DecodeRune(prefix[end:])
		if r == utf8.RuneError && size == 1 {
			return gatewayapi.AgentFile{}, unsupportedMedia()
		}
		if r == 0 {
			return gatewayapi.AgentFile{}, unsupportedMedia()
		}
		end += size
	}
	if _, err := io.Copy(hash, f); err != nil {
		return gatewayapi.AgentFile{}, internalFailure("hash file", err)
	}

	return gatewayapi.AgentFile{
		Content:    string(prefix[:end]),
		MediaType:  mediaType(name),
		ModifiedAt: info.ModTime(),
		Path:       name,
		Size:       info.Size(),
		Truncated:  int64(end) < info.Size(),
		Type:       gatewayapi.AgentFileTypeFile,
		Version:    hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

func (s *service) metadata(name string) (gatewayapi.AgentFileMetadata, error) {
	f, err := s.root.Open(name)
	if err != nil {
		return gatewayapi.AgentFileMetadata{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return gatewayapi.AgentFileMetadata{}, err
	}

	if info.IsDir() {
		return gatewayapi.AgentFileMetadata{
			MediaType:  "",
			ModifiedAt: info.ModTime(),
			Path:       name,
			Size:       info.Size(),
			Type:       gatewayapi.AgentFileTypeDirectory,
			Version:    fmt.Sprintf("%x-%x", info.ModTime().UnixNano(), info.Size()),
		}, nil
	}
	if !info.Mode().IsRegular() {
		return gatewayapi.AgentFileMetadata{}, errInvalidEntryType
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return gatewayapi.AgentFileMetadata{}, err
	}
	return gatewayapi.AgentFileMetadata{
		MediaType:  mediaType(name),
		ModifiedAt: info.ModTime(),
		Path:       name,
		Size:       info.Size(),
		Type:       gatewayapi.AgentFileTypeFile,
		Version:    hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

func requestPath(r *http.Request) (string, *failure) {
	name := r.URL.Query().Get("path")
	if ferr := checkPath(name); ferr != nil {
		return "", ferr
	}
	return name, nil
}

func checkPath(name string) *failure {
	if name == "" || len(name) > 4096 || path.IsAbs(name) || strings.ContainsRune(name, 0) {
		return invalidPath()
	}
	for part := range strings.SplitSeq(name, "/") {
		if part == "" || part == "." || part == ".." {
			return invalidPath()
		}
	}
	return nil
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) *failure {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			return requestTooLarge()
		}
		return badRequest("request body is invalid", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return badRequest("request body must contain one json object", err)
	}
	return nil
}

func mediaType(name string) string {
	if value := mime.TypeByExtension(path.Ext(name)); value != "" {
		return value
	}
	return "application/octet-stream"
}

func pathFailure(err error) *failure {
	switch {
	case errors.Is(err, errInvalidEntryType):
		return invalidEntryType()
	case errors.Is(err, os.ErrNotExist):
		return &failure{status: http.StatusNotFound, code: "not_found", message: "entry not found", cause: err}
	case errors.Is(err, os.ErrExist):
		return entryExists()
	case errors.Is(err, os.ErrPermission):
		return &failure{status: http.StatusForbidden, code: "permission_denied", message: "permission denied", cause: err}
	default:
		return invalidPathWithCause(err)
	}
}

func invalidPath() *failure {
	return invalidPathWithCause(nil)
}

func invalidPathWithCause(err error) *failure {
	return &failure{
		status:  http.StatusBadRequest,
		code:    "invalid_path",
		message: "path is invalid",
		cause:   err,
	}
}

func invalidEntryType() *failure {
	return &failure{
		status:  http.StatusBadRequest,
		code:    "invalid_entry_type",
		message: "entry is not a regular file",
		cause:   errInvalidEntryType,
	}
}

func unsupportedMedia() *failure {
	return &failure{
		status:  http.StatusUnsupportedMediaType,
		code:    "unsupported_media_type",
		message: "file is not utf-8 text",
		cause:   errUnsupportedMedia,
	}
}

func entryExists() *failure {
	return &failure{
		status:  http.StatusConflict,
		code:    "entry_exists",
		message: "entry already exists",
		cause:   os.ErrExist,
	}
}

func versionConflict(current gatewayapi.AgentFileMetadata) *failure {
	return &failure{
		status:  http.StatusConflict,
		code:    "file_version_conflict",
		message: "file changed since it was read",
		current: &current,
	}
}

func requestTooLarge() *failure {
	return &failure{
		status:  http.StatusRequestEntityTooLarge,
		code:    "request_too_large",
		message: "request exceeds the maximum allowed size",
	}
}

func badRequest(message string, err error) *failure {
	return &failure{
		status:  http.StatusBadRequest,
		code:    "invalid_request",
		message: message,
		cause:   err,
	}
}

func internalFailure(message string, err error) *failure {
	return &failure{
		status:  http.StatusInternalServerError,
		code:    "internal_error",
		message: message,
		cause:   err,
	}
}

func writeFailure(w http.ResponseWriter, r *http.Request, ferr *failure) {
	if ferr.status >= http.StatusInternalServerError {
		slog.ErrorContext(
			r.Context(), "filesystem request failed",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.String("code", ferr.code),
			slog.Any("err", ferr.cause),
		)
	}
	if ferr.current != nil {
		writeJSON(w, ferr.status, gatewayapi.AgentFileConflict{
			Code:    gatewayapi.FileVersionConflict,
			Current: *ferr.current,
			Message: ferr.message,
		})
		return
	}
	writeJSON(w, ferr.status, gatewayapi.Error{
		Code:    ferr.code,
		Message: ferr.message,
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("encode filesystem response", slog.Any("err", err))
	}
}
