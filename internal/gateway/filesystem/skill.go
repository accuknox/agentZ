package filesystem

import (
	"archive/zip"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/skill"
)

const (
	mutableSkillsRoot  = ".agents/skills"
	maxSkillImportSize = 10 << 20
)

type archivedFile struct {
	name string
}

type committedSkill struct {
	name      string
	backup    string
	isCreated bool
}

func (s *service) listSkills(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 200 {
			writeFailure(w, r, badRequest("limit must be between 1 and 200", err))
			return
		}
		limit = value
	}
	var start string
	if raw := r.URL.Query().Get("page_token"); raw != "" {
		value, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || skill.ValidateName(string(value)) != nil {
			writeFailure(w, r, badRequest("page token is invalid", err))
			return
		}
		start = string(value)
	}

	entries, err := fs.ReadDir(s.root.FS(), mutableSkillsRoot)
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusOK, gatewayapi.ListMutableSkillsResponse{
			Skills: []gatewayapi.MutableSkillSummary{},
		})
		return
	}
	if err != nil {
		writeFailure(w, r, internalFailure("read mutable skills", err))
		return
	}
	items := make([]gatewayapi.MutableSkillSummary, 0, min(limit, len(entries)))
	var next string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || skill.ValidateName(name) != nil || name <= start {
			continue
		}
		if len(items) == limit {
			next = base64.RawURLEncoding.EncodeToString([]byte(items[len(items)-1].Name))
			break
		}
		var count int
		var size int64
		var modified time.Time
		err := fs.WalkDir(s.root.FS(), path.Join(mutableSkillsRoot, name), func(fpath string, item fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if item.IsDir() {
				return nil
			}
			info, err := item.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("mutable skill contains a non-regular file")
			}
			count++
			size += info.Size()
			if info.ModTime().After(modified) {
				modified = info.ModTime()
			}
			return nil
		})
		if err != nil {
			writeFailure(w, r, internalFailure("summarize mutable skill", err))
			return
		}
		var modifiedAt *time.Time
		if !modified.IsZero() {
			modifiedAt = &modified
		}
		items = append(items, gatewayapi.MutableSkillSummary{
			Name: name, FileCount: count, SizeBytes: size, ModifiedAt: modifiedAt,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListMutableSkillsResponse{
		Skills: items, NextPageToken: next,
	})
}

func (s *service) deleteSkills(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.DeleteSkillsRequest
	if ferr := decodeBody(w, r, &req); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	names, ferr := requestedSkills(req.SkillNames)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, name := range names {
		info, err := s.root.Stat(path.Join(mutableSkillsRoot, name))
		if err != nil || !info.IsDir() {
			writeFailure(w, r, pathFailure(err))
			return
		}
	}
	for _, name := range names {
		if err := s.root.RemoveAll(path.Join(mutableSkillsRoot, name)); err != nil {
			writeFailure(w, r, internalFailure("delete mutable skill", err))
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *service) exportSkills(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.ExportSkillsRequest
	if ferr := decodeBody(w, r, &req); ferr != nil {
		writeFailure(w, r, ferr)
		return
	}
	names, ferr := requestedSkills(req.SkillNames)
	if ferr != nil {
		writeFailure(w, r, ferr)
		return
	}

	files := make([]archivedFile, 0)
	for _, name := range names {
		root := path.Join(mutableSkillsRoot, name)
		info, err := s.root.Stat(root)
		if err != nil || !info.IsDir() {
			writeFailure(w, r, pathFailure(err))
			return
		}
		err = fs.WalkDir(s.root.FS(), root, func(filePath string, item fs.DirEntry, walkErr error) error {
			if walkErr != nil || item.IsDir() {
				return walkErr
			}
			info, err := item.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("mutable skill contains a non-regular file")
			}
			files = append(files, archivedFile{name: filePath})
			return nil
		})
		if err != nil {
			writeFailure(w, r, internalFailure("inspect mutable skill export", err))
			return
		}
	}
	slices.SortFunc(files, func(a, b archivedFile) int {
		return strings.Compare(a.name, b.name)
	})

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="skills.zip"`)
	if err := s.writeSkillArchive(w, files); err != nil {
		slog.ErrorContext(r.Context(), "stream mutable skill export", slog.Any("err", err))
	}
}

func (s *service) writeSkillArchive(w io.Writer, files []archivedFile) error {
	zw := zip.NewWriter(w)
	for _, archived := range files {
		name := strings.TrimPrefix(archived.name, mutableSkillsRoot+"/")
		src, err := s.root.Open(archived.name)
		if err != nil {
			return errors.Join(err, zw.Close())
		}
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		dst, err := zw.CreateHeader(h)
		if err != nil {
			return errors.Join(err, src.Close(), zw.Close())
		}
		_, copyErr := io.Copy(dst, src)
		closeErr := src.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			return errors.Join(err, zw.Close())
		}
	}
	return zw.Close()
}

func (s *service) importSkills(w http.ResponseWriter, r *http.Request) {
	var decisions []skill.Decision
	err := json.Unmarshal([]byte(r.Header.Get("X-Agentz-Skill-Decisions")), &decisions)
	if err != nil {
		writeFailure(w, r, badRequest("skill import decisions are invalid", err))
		return
	}
	bundle, err := skill.Parse("skills.zip", http.MaxBytesReader(w, r.Body, maxSkillImportSize+1))
	if err != nil {
		writeFailure(w, r, badRequest("skill import is invalid", err))
		return
	}
	if len(bundle.Skills) != len(decisions) || len(decisions) == 0 {
		writeFailure(w, r, badRequest("skill import decisions are incomplete", nil))
		return
	}

	actions := make(map[string]skill.DecisionAction, len(decisions))
	for _, decision := range decisions {
		destination := decision.Name
		if decision.Action == skill.DecisionRename {
			destination = decision.Rename
		}
		if err := skill.ValidateName(destination); err != nil {
			writeFailure(w, r, badRequest("skill import destination is invalid", err))
			return
		}
		if decision.Action != skill.DecisionCreate && decision.Action != skill.DecisionOverwrite && decision.Action != skill.DecisionRename {
			writeFailure(w, r, badRequest("skill import decision action is invalid", nil))
			return
		}
		if _, ok := actions[destination]; ok {
			writeFailure(w, r, badRequest("skill import destinations must be unique", nil))
			return
		}
		actions[destination] = decision.Action
	}
	for _, tree := range bundle.Skills {
		if _, ok := actions[tree.Name]; !ok {
			writeFailure(w, r, badRequest("skill import decisions do not match the archive", nil))
			return
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.root.MkdirAll(mutableSkillsRoot, 0o755); err != nil {
		writeFailure(w, r, internalFailure("create mutable skills root", err))
		return
	}
	stageID := rand.Text()
	backupID := rand.Text()
	defer func() {
		for _, tree := range bundle.Skills {
			stage := path.Join(mutableSkillsRoot, ".stage-"+stageID+"-"+tree.Name)
			backup := path.Join(mutableSkillsRoot, ".backup-"+backupID+"-"+tree.Name)
			if err := errors.Join(s.root.RemoveAll(stage), s.root.RemoveAll(backup)); err != nil {
				slog.ErrorContext(r.Context(), "remove mutable skill transaction", slog.Any("err", err))
			}
		}
	}()

	for _, tree := range bundle.Skills {
		root := path.Join(mutableSkillsRoot, ".stage-"+stageID+"-"+tree.Name)
		if err := s.root.Mkdir(root, 0o755); err != nil {
			writeFailure(w, r, internalFailure("create staged skill", err))
			return
		}
		for _, file := range tree.Files {
			name := path.Join(root, file.Path)
			if err := s.root.MkdirAll(path.Dir(name), 0o755); err != nil {
				writeFailure(w, r, internalFailure("create staged skill directory", err))
				return
			}
			dst, err := s.root.Create(name)
			if err != nil {
				writeFailure(w, r, internalFailure("write staged skill file", err))
				return
			}
			_, writeErr := dst.Write(file.Content)
			if err := errors.Join(writeErr, dst.Close()); err != nil {
				writeFailure(w, r, internalFailure("write staged skill file", err))
				return
			}
		}
		err := fs.WalkDir(s.root.FS(), root, func(name string, _ fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if os.Geteuid() == 0 {
				return s.root.Chown(name, 1000, 1000)
			}
			return nil
		})
		if err != nil {
			writeFailure(w, r, internalFailure("prepare staged skill", err))
			return
		}
	}

	for _, tree := range bundle.Skills {
		destination := path.Join(mutableSkillsRoot, tree.Name)
		_, err := s.root.Stat(destination)
		exists := err == nil
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			writeFailure(w, r, internalFailure("inspect mutable skill destination", err))
			return
		}
		action := actions[tree.Name]
		if action == skill.DecisionOverwrite && !exists {
			writeFailure(w, r, &failure{
				status: http.StatusConflict, code: "decision_conflict",
				message: "overwrite destination does not exist",
			})
			return
		}
		if action != skill.DecisionOverwrite && exists {
			writeFailure(w, r, &failure{
				status: http.StatusConflict, code: "decision_conflict",
				message: "create destination already exists",
			})
			return
		}
	}

	committed := make([]committedSkill, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		staged := path.Join(mutableSkillsRoot, ".stage-"+stageID+"-"+tree.Name)
		destination := path.Join(mutableSkillsRoot, tree.Name)
		saved := path.Join(mutableSkillsRoot, ".backup-"+backupID+"-"+tree.Name)
		action := actions[tree.Name]
		if action == skill.DecisionOverwrite {
			exchanged, err := exchangeFiles(s.root, staged, destination)
			if err == nil && exchanged {
				err = s.root.Rename(staged, saved)
				if err != nil {
					_, restoreErr := exchangeFiles(s.root, staged, destination)
					err = errors.Join(err, restoreErr)
				}
			}
			if err == nil && !exchanged {
				err = s.root.Rename(destination, saved)
				if err == nil {
					err = s.root.Rename(staged, destination)
					if err != nil {
						err = errors.Join(err, s.root.Rename(saved, destination))
					}
				}
			}
			if err != nil {
				err = errors.Join(err, s.rollbackSkills(committed))
				writeFailure(w, r, internalFailure("commit mutable skill overwrite", err))
				return
			}
			committed = append(committed, committedSkill{name: destination, backup: saved})
			continue
		}
		if err := s.root.Rename(staged, destination); err != nil {
			err = errors.Join(err, s.rollbackSkills(committed))
			writeFailure(w, r, internalFailure("commit mutable skill create", err))
			return
		}
		committed = append(committed, committedSkill{name: destination, isCreated: true})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *service) rollbackSkills(committed []committedSkill) error {
	var rollbackErr error
	for _, item := range slices.Backward(committed) {
		if item.isCreated {
			rollbackErr = errors.Join(rollbackErr, s.root.RemoveAll(item.name))
			continue
		}
		rollbackErr = errors.Join(rollbackErr, s.root.RemoveAll(item.name))
		rollbackErr = errors.Join(rollbackErr, s.root.Rename(item.backup, item.name))
	}
	return rollbackErr
}

func requestedSkills(raw []gatewayapi.SkillName) ([]string, *failure) {
	if err := skill.ValidateNames(raw); err != nil {
		return nil, badRequest("skill_names is invalid", err)
	}
	return raw, nil
}
