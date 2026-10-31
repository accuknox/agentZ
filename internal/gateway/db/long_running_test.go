//go:build integration

package gatewaydb_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	db "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestLongRunningStorage uses a disposable database to exercise real locking and constraints.
// AGENTZ_TEST_POSTGRES_DSN must allow database creation on a test PostgreSQL server.
func TestLongRunningStorage(t *testing.T) {
	dsn := os.Getenv("AGENTZ_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set AGENTZ_TEST_POSTGRES_DSN to run PostgreSQL integration checks")
	}
	ctx := t.Context()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := "agentz_test_" + uuid.New().String()[:8]
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		if err != nil {
			t.Error(err)
		}
	}()
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	sources := []string{filepath.Join("..", "..", "..", "web", "db", "schema.sql"), "schema.sql"}
	for _, source := range sources {
		sql, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatal(err)
		}
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must := func(ok bool, label string) {
		t.Helper()
		if !ok {
			t.Fatal(label)
		}
		t.Log(label)
	}
	fixture, err := os.ReadFile(filepath.Join("testdata", "long_running.sql"))
	check(err)
	fixtures := strings.SplitN(string(fixture), "-- stage\n", 3)
	_, err = pool.Exec(ctx, fixtures[0])
	check(err)
	q := db.New(pool)
	request := db.GatewayReserveLongRunningChatParams{
		ID:          uuid.New(),
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		OwnerID:     "lr-a",
		Request:     []byte(`{"agent":"agent"}`),
		SessionID:   "ses_lr_test",
	}
	receipt, err := q.GatewayReserveLongRunningChat(ctx, request)
	check(err)
	root, err := q.GatewayGetChatSession(ctx, db.GatewayGetChatSessionParams{
		WorkspaceID: request.WorkspaceID,
		AgentName:   request.AgentName,
		SessionID:   receipt.SessionID,
	})
	check(err)
	must(root.LongRunning && root.OwnerID.String == "lr-a" && root.ProactiveIntervalSeconds.Int32 == 1800,
		"atomic owner reservation and default cadence")
	must(root.NextCheckAt.Time.After(time.Now().Add(29*time.Minute)), "first check is delayed")
	request.SessionID = "ses_lr_retry_unused"
	retry, err := q.GatewayReserveLongRunningChat(ctx, request)
	check(err)
	must(retry.SessionID == receipt.SessionID, "creation retry adopts canonical session")
	request.OwnerID = "lr-b"
	_, err = q.GatewayReserveLongRunningChat(ctx, request)
	must(err == pgx.ErrNoRows, "foreign owner cannot adopt intent")
	request.OwnerID = "lr-a"
	request.Request = []byte(`{"agent":"other"}`)
	_, err = q.GatewayReserveLongRunningChat(ctx, request)
	must(err == pgx.ErrNoRows, "conflicting creation request rejected")
	request.ID = uuid.New()
	request.WorkspaceID = "lr-coding"
	_, err = q.GatewayReserveLongRunningChat(ctx, request)
	must(err == pgx.ErrNoRows, "Coding creation rejected by authoritative workspace")
	_, err = pool.Exec(ctx, fixtures[1])
	check(err)
	input := []byte(`{"text":"Automatic check","attachments":[]}`)
	pending, err := q.GatewayEnqueueProactiveChecks(ctx, input)
	check(err)
	must(len(pending) == 0, "unconfirmed native creation cannot enqueue work")
	visible, err := q.GatewayListChatSessions(ctx, db.GatewayListChatSessionsParams{
		WorkspaceID:        "lr-general",
		AgentNames:         []string{"agent"},
		ViewerID:           pgtype.Text{String: "lr-a", Valid: true},
		PageSize:           50,
		ParticipantUserIds: []string{},
	})
	check(err)
	must(len(visible) == 1 && visible[0].SessionID == "ses_ordinary", "pending creation is withheld from the inbox")
	_, err = q.GatewayFinishChatCreation(ctx, db.GatewayFinishChatCreationParams{
		ID:          receipt.ID,
		WorkspaceID: "lr-general",
		OwnerID:     "lr-a",
		State:       "created",
	})
	check(err)
	var wg sync.WaitGroup
	var mu sync.Mutex
	failures := make(chan error, 12)
	count := 0
	for range 12 {
		wg.Go(func() {
			rows, e := q.GatewayEnqueueProactiveChecks(ctx, input)
			if e != nil {
				failures <- e
				return
			}
			mu.Lock()
			count += len(rows)
			mu.Unlock()
		})
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		check(err)
	}
	must(count == 1, "12 concurrent replicas coalesce one due check")
	rows, err := q.GatewayEnqueueProactiveChecks(ctx, input)
	check(err)
	must(len(rows) == 0, "outstanding check prevents catch-up burst")
	background, err := q.GatewayListChatBackground(ctx, db.GatewayListChatBackgroundParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	})
	check(err)
	must(len(background) == 1, "one internal input")
	internal := background[0]
	must(internal.AuthorID == "lr-a" && internal.Origin == db.ChatInputOriginProactive && internal.PartID.Valid,
		"internal origin and stable part identity")
	human, err := q.GatewayCreateChatInput(ctx, db.GatewayCreateChatInputParams{
		ID:             uuid.New(),
		WorkspaceID:    "lr-general",
		AgentName:      "agent",
		SessionID:      "ses_lr_test",
		OrganizationID: "lr-org",
		AuthorID:       "lr-a",
		AuthorName:     "Alice",
		Directory:      "/home/agentz",
		Content:        []byte(`{"text":"Human work","attachments":[]}`),
		Delivery:       "queue",
	})
	check(err)
	head, err := q.GatewayHeadChatInput(ctx, db.GatewayHeadChatInputParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	})
	check(err)
	must(head.ID == human.ID, "human queued work precedes older automatic checks")
	heads, err := q.GatewayPendingChatInputs(ctx)
	check(err)
	must(len(heads) == 1 && heads[0].ID == human.ID, "worker and admission selectors agree on human priority")
	_, err = q.GatewayUpdateChatInput(ctx, db.GatewayUpdateChatInputParams{
		ID:       human.ID,
		Revision: human.Revision,
		State:    "removed",
	})
	check(err)
	for _, actor := range []string{"lr-a", "lr-b"} {
		inbox, err := q.GatewayListChatSessions(ctx, db.GatewayListChatSessionsParams{
			WorkspaceID:        "lr-general",
			AgentNames:         []string{"agent"},
			ViewerID:           pgtype.Text{String: actor, Valid: true},
			PageSize:           50,
			ParticipantUserIds: []string{},
		})
		check(err)
		want := 1
		if actor == "lr-a" {
			want = 2
		}
		must(len(inbox) == want, "inbox visibility for "+actor)
	}
	_, err = pool.Exec(ctx, fixtures[2])
	check(err)
	_, err = q.GatewayUpdateProactivity(ctx, db.GatewayUpdateProactivityParams{
		WorkspaceID:     "lr-general",
		AgentName:       "agent",
		SessionID:       "ses_lr_test",
		OwnerID:         pgtype.Text{String: "lr-b", Valid: true},
		Paused:          true,
		IntervalSeconds: pgtype.Int4{Int32: 1800, Valid: true},
	})
	must(err == pgx.ErrNoRows, "foreign owner cannot pause")
	_, err = q.GatewayUpdateProactivity(ctx, db.GatewayUpdateProactivityParams{
		WorkspaceID:     "lr-general",
		AgentName:       "agent",
		SessionID:       "ses_lr_test",
		OwnerID:         pgtype.Text{String: "lr-a", Valid: true},
		Paused:          true,
		IntervalSeconds: pgtype.Int4{Int32: 600, Valid: true},
	})
	check(err)
	background, err = q.GatewayListChatBackground(ctx, db.GatewayListChatBackgroundParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	})
	check(err)
	canceled := background[0].CompletedAt.Valid && background[0].Outcome.ChatBackgroundOutcome == db.ChatBackgroundOutcomeCanceled
	must(canceled, "pause cancels a failed unadmitted automatic check")
	rows, err = q.GatewayEnqueueProactiveChecks(ctx, input)
	check(err)
	must(len(rows) == 0, "paused root does not enqueue")
	_, err = q.GatewayUpdateProactivity(ctx, db.GatewayUpdateProactivityParams{
		WorkspaceID:     "lr-general",
		AgentName:       "agent",
		SessionID:       "ses_lr_test",
		OwnerID:         pgtype.Text{String: "lr-a", Valid: true},
		IntervalSeconds: pgtype.Int4{Int32: 60, Valid: true},
	})
	check(err)
	_, err = pool.Exec(ctx, fixtures[1])
	check(err)
	rows, err = q.GatewayEnqueueProactiveChecks(ctx, input)
	check(err)
	must(len(rows) == 1, "resumed root admits one future check")
	_, err = q.GatewayCompleteBackgroundInput(ctx, db.GatewayCompleteBackgroundInputParams{
		ID: rows[0].ID,
		Outcome: db.NullChatBackgroundOutcome{
			ChatBackgroundOutcome: db.ChatBackgroundOutcomeQuiet,
			Valid:                 true,
		},
	})
	check(err)
	root, err = q.GatewayGetChatSession(ctx, db.GatewayGetChatSessionParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	})
	check(err)
	must(root.NextCheckAt.Time.After(time.Now().Add(59*time.Second)), "completion schedules fixed delay")

	reportRequest := db.GatewayPrepareWorkflowReportParams{
		RunUid:         "run-test",
		Namespace:      "lr-general",
		RunName:        "release",
		WorkspaceID:    "lr-general",
		AgentName:      "agent",
		SessionID:      "ses_lr_test",
		OwnerID:        "lr-a",
		Generation:     root.Generation,
		RequestedPhase: "Succeeded",
		StatusMessage:  "Done",
		Result:         []byte(`{"kind":"update","text":"Release passed"}`),
		PayloadHash:    "first-result",
	}
	report, err := q.GatewayPrepareWorkflowReport(ctx, reportRequest)
	check(err)
	retryReport, err := q.GatewayPrepareWorkflowReport(ctx, reportRequest)
	check(err)
	must(report.RunUid == retryReport.RunUid, "exact report retry retains one receipt")
	reportRequest.PayloadHash = "different-result"
	_, err = q.GatewayPrepareWorkflowReport(ctx, reportRequest)
	must(err == pgx.ErrNoRows, "conflicting report cannot replace prepared content")
	var deliveredIDs []uuid.UUID
	var reportMu sync.Mutex
	reportErrors := make(chan error, 12)
	for range 12 {
		wg.Go(func() {
			ready, err := q.GatewayActivateWorkflowReport(ctx, db.GatewayActivateWorkflowReportParams{
				RunUid:  report.RunUid,
				Content: []byte(`{"text":"Release passed","attachments":[]}`),
			})
			if err != nil {
				reportErrors <- err
				return
			}
			reportMu.Lock()
			deliveredIDs = append(deliveredIDs, ready.ChatInputID.Bytes)
			reportMu.Unlock()
		})
	}
	wg.Wait()
	close(reportErrors)
	for err := range reportErrors {
		check(err)
	}
	must(len(deliveredIDs) == 12, "all replicas reconcile the same report")
	for _, id := range deliveredIDs {
		must(id == deliveredIDs[0], "report activation creates one context input")
	}

	check(q.GatewayRecoverChatInputs(ctx, db.GatewayRecoverChatInputsParams{WorkspaceID: "lr-general", AgentName: "agent", SessionID: "ses_lr_test"}))
	workflowInput, err := q.GatewayGetChatInput(ctx, db.GatewayGetChatInputParams{ID: deliveredIDs[0], WorkspaceID: "lr-general", AgentName: "agent", SessionID: "ses_lr_test"})
	check(err)
	must(workflowInput.State == "queued", "Stop leaves explicit workflow delivery queued")
	_, err = q.GatewayFailBackgroundInput(ctx, db.GatewayFailBackgroundInputParams{ID: workflowInput.ID, Error: "Permanent admission failure"})
	check(err)
	reportRequest.RunUid = "run-after-failure"
	reportRequest.PayloadHash = "next-result"
	_, err = q.GatewayPrepareWorkflowReport(ctx, reportRequest)
	check(err)
	nextReport, err := q.GatewayActivateWorkflowReport(ctx, db.GatewayActivateWorkflowReportParams{RunUid: reportRequest.RunUid, Content: []byte(`{"text":"Next release update","attachments":[]}`)})
	check(err)
	head, err = q.GatewayHeadChatInput(ctx, db.GatewayHeadChatInputParams{WorkspaceID: "lr-general", AgentName: "agent", SessionID: "ses_lr_test"})
	check(err)
	must(head.ID == nextReport.ChatInputID.Bytes, "completed background failures cannot block later context")
	heads, err = q.GatewayPendingChatInputs(ctx)
	check(err)
	must(len(heads) == 1 && heads[0].ID == nextReport.ChatInputID.Bytes, "worker excludes completed background inputs")
	listener, err := pgx.ConnectConfig(ctx, config.ConnConfig)
	check(err)
	defer listener.Close(ctx)
	_, err = listener.Exec(ctx, "LISTEN agentz_chat_sessions")
	check(err)
	check(q.GatewayNotifyChatInputs(ctx, db.GatewayNotifyChatInputsParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   pgtype.Text{String: "ses_lr_test", Valid: true},
	}))
	notificationCtx, cancelNotification := context.WithTimeout(ctx, time.Second)
	notification, err := listener.WaitForNotification(notificationCtx)
	cancelNotification()
	check(err)
	must(notification.Payload == "lr-general/lr-a", "private queue invalidation is owner-scoped")
	deleted, err := q.GatewayDeletePrivateChat(ctx, db.GatewayDeletePrivateChatParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	})
	check(err)
	must(deleted.Deleting && deleted.Generation == 1, "deletion creates generation barrier")
	_, err = q.GatewayUpdateProactivity(ctx, db.GatewayUpdateProactivityParams{
		WorkspaceID:     "lr-general",
		AgentName:       "agent",
		SessionID:       "ses_lr_test",
		OwnerID:         pgtype.Text{String: "lr-a", Valid: true},
		IntervalSeconds: pgtype.Int4{Int32: 60, Valid: true},
	})
	must(err == pgx.ErrNoRows, "stale settings cannot restore deleted root")
	check(q.GatewayFinishPrivateChatCleanup(ctx, db.GatewayFinishPrivateChatCleanupParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	}))
	repair, err := q.GatewayPrivateChatRoots(ctx, "")
	check(err)
	must(len(repair) == 0, "completed cleanup retains its tombstone without repeated native disposal")
	_, err = q.GatewayGetChatSession(ctx, db.GatewayGetChatSessionParams{
		WorkspaceID: "lr-general",
		AgentName:   "agent",
		SessionID:   "ses_lr_test",
	})
	check(err)
}
