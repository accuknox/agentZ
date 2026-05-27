package gateway

import (
	"net/http"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
)

func (s *Service) SessionList(w http.ResponseWriter, r *http.Request, _ string, _ gatewayapi.SessionListParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionCreate(w http.ResponseWriter, r *http.Request, _ string, _ gatewayapi.SessionCreateParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionStatus(w http.ResponseWriter, r *http.Request, _ string, _ gatewayapi.SessionStatusParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionDelete(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionDeleteParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionGet(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionGetParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionUpdate(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionUpdateParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionAbort(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionAbortParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionChildren(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionChildrenParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionCommand(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionCommandParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionDiff(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionDiffParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionFork(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionForkParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionInit(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionInitParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionMessages(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionMessagesParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionPrompt(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionPromptParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionDeleteMessage(w http.ResponseWriter, r *http.Request, _ string, _ string, _ string, _ gatewayapi.SessionDeleteMessageParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionMessage(w http.ResponseWriter, r *http.Request, _ string, _ string, _ string, _ gatewayapi.SessionMessageParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) PartDelete(w http.ResponseWriter, r *http.Request, _ string, _ string, _ string, _ string, _ gatewayapi.PartDeleteParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) PartUpdate(w http.ResponseWriter, r *http.Request, _ string, _ string, _ string, _ string, _ gatewayapi.PartUpdateParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) PermissionRespond(w http.ResponseWriter, r *http.Request, _ string, _ string, _ string, _ gatewayapi.PermissionRespondParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionPromptAsync(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionPromptAsyncParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionRevert(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionRevertParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionUnshare(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionUnshareParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionShare(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionShareParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionShell(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionShellParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionSummarize(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionSummarizeParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionTodo(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionTodoParams) {
	s.handleOpenCodeProxy(w, r)
}

func (s *Service) SessionUnrevert(w http.ResponseWriter, r *http.Request, _ string, _ string, _ gatewayapi.SessionUnrevertParams) {
	s.handleOpenCodeProxy(w, r)
}
