package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestValidateDashboardDefinition(t *testing.T) {
	t.Parallel()

	measure := "requests"
	aggregation := gatewayapi.Sum
	group := "service"
	columns := []string{"service", "requests"}
	sortBy := "requests"
	definition := gatewayapi.DashboardDefinition{
		Name: "service-health", Title: "Service health", Description: "Request health by service.",
		Dimensions: []gatewayapi.DashboardDimension{{Name: "service", Label: "Service"}},
		Measures:   []gatewayapi.DashboardMeasure{{Name: measure, Label: "Requests"}},
		Filters: []gatewayapi.DashboardFilter{{
			Id: "service_filter", Label: "Service", Field: "service", Multiple: true,
		}},
		Widgets: []gatewayapi.DashboardWidget{
			{Id: "requests", Title: "Requests", Kind: gatewayapi.DashboardWidgetLine, Width: gatewayapi.Full, Measure: &measure, Aggregation: &aggregation, GroupBy: &group},
			{Id: "services", Title: "Services", Kind: gatewayapi.DashboardWidgetTable, Width: gatewayapi.Full, Columns: &columns, SortBy: &sortBy},
		},
	}
	if err := validateDashboardDefinition(definition); err != nil {
		t.Fatalf("validate valid definition: %v", err)
	}

	t.Run("does not cap widgets", func(t *testing.T) {
		many := definition
		many.Widgets = make([]gatewayapi.DashboardWidget, 1000)
		for index := range many.Widgets {
			many.Widgets[index] = gatewayapi.DashboardWidget{
				Id:    fmt.Sprintf("widget_%04d", index),
				Title: "Requests", Kind: gatewayapi.DashboardWidgetMetric, Width: gatewayapi.Third,
				Measure: &measure, Aggregation: &aggregation,
			}
		}
		if err := validateDashboardDefinition(many); err != nil {
			t.Fatalf("validate definition with many widgets: %v", err)
		}
	})

	t.Run("rejects field type overlap", func(t *testing.T) {
		invalid := definition
		invalid.Measures = []gatewayapi.DashboardMeasure{{Name: "service", Label: "Service"}}
		if err := validateDashboardDefinition(invalid); err == nil || err.Error() != `field "service" cannot be both a dimension and measure` {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("rejects arbitrary table sort", func(t *testing.T) {
		invalid := definition
		unknown := "unknown"
		invalid.Widgets = []gatewayapi.DashboardWidget{{
			Id: "table", Title: "Table", Kind: gatewayapi.DashboardWidgetTable,
			Width: gatewayapi.Full, Columns: &columns, SortBy: &unknown,
		}}
		if err := validateDashboardDefinition(invalid); err == nil || err.Error() != `table widget "table" sort_by must reference one of its columns` {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("rejects unsupported aggregation", func(t *testing.T) {
		invalid := definition
		unsupported := gatewayapi.DashboardAggregation("median")
		invalid.Widgets = []gatewayapi.DashboardWidget{{
			Id: "metric", Title: "Metric", Kind: gatewayapi.DashboardWidgetMetric,
			Width: gatewayapi.Third, Measure: &measure, Aggregation: &unsupported,
		}}
		if err := validateDashboardDefinition(invalid); err == nil || err.Error() != `widget "metric" has unsupported aggregation "median"` {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestValidateDashboardRecords(t *testing.T) {
	t.Parallel()
	definition := gatewayapi.DashboardDefinition{
		Dimensions: []gatewayapi.DashboardDimension{{Name: "service", Label: "Service"}},
		Measures:   []gatewayapi.DashboardMeasure{{Name: "requests", Label: "Requests"}},
	}
	key := "api"
	req := gatewayapi.WriteDashboardDataRequest{
		Action: gatewayapi.Upsert,
		Records: []gatewayapi.DashboardDataRecord{{
			RecordKey: &key, ObservedAt: time.Now(),
			Dimensions: map[string]string{"service": "api"},
			Measures:   map[string]float64{"requests": 42},
		}},
	}
	encoded, err := validateDashboardRecords(definition, req)
	if err != nil {
		t.Fatalf("validate records: %v", err)
	}
	var records []dashboardRecordInput
	if err := json.Unmarshal(encoded, &records); err != nil {
		t.Fatalf("decode records: %v", err)
	}
	if len(records) != 1 || records[0].ID == "" || records[0].RecordKey == nil || *records[0].RecordKey != key {
		t.Fatalf("unexpected validated records: %#v", records)
	}

	t.Run("upsert requires stable key", func(t *testing.T) {
		invalid := req
		invalid.Records = []gatewayapi.DashboardDataRecord{{
			ObservedAt: time.Now(), Dimensions: map[string]string{}, Measures: map[string]float64{},
		}}
		_, err := validateDashboardRecords(definition, invalid)
		if err == nil || err.Error() != "record 0 requires record_key for upsert" {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("rejects undeclared fields", func(t *testing.T) {
		invalid := req
		invalid.Records = []gatewayapi.DashboardDataRecord{{
			RecordKey: &key, ObservedAt: time.Now(),
			Dimensions: map[string]string{"secret": "value"}, Measures: map[string]float64{},
		}}
		_, err := validateDashboardRecords(definition, invalid)
		if err == nil || err.Error() != `record 0 contains unknown dimension "secret"` {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestDashboardQueryFilters(t *testing.T) {
	t.Parallel()
	definition := gatewayapi.DashboardDefinition{Filters: []gatewayapi.DashboardFilter{{
		Id: "service_filter", Field: "service", Label: "Service", Multiple: true,
	}}}
	encoded, err := dashboardQueryFilters(
		definition,
		[]gatewayapi.DashboardQueryFilter{{FilterId: "service_filter", Values: []string{"api"}}},
	)
	if err != nil {
		t.Fatalf("encode filters: %v", err)
	}
	var filters []dashboardQueryFilter
	if err := json.Unmarshal(encoded, &filters); err != nil {
		t.Fatalf("decode filters: %v", err)
	}
	if len(filters) != 1 || filters[0].Field != "service" || len(filters[0].Values) != 1 || filters[0].Values[0] != "api" {
		t.Fatalf("unexpected filters: %#v", filters)
	}

	_, err = dashboardQueryFilters(
		definition,
		[]gatewayapi.DashboardQueryFilter{{FilterId: "unknown", Values: []string{"api"}}},
	)
	if err == nil || err.Error() != `unknown filter "unknown"` {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDashboardPostgresIntegration(t *testing.T) {
	dsn := os.Getenv("AGENTZ_DASHBOARD_TEST_DSN")
	if dsn == "" {
		t.Skip("AGENTZ_DASHBOARD_TEST_DSN is not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect to PostgreSQL: %v", err)
	}
	defer pool.Close()
	const (
		organizationID = "dashboard-test-org"
		workspaceID    = "dashboard-test-workspace"
		agentName      = "dashboard-test-agent"
		userID         = "dashboard-test-user"
		sessionID      = "dashboard-test-session"
	)
	dbQueries := gatewaydb.New(pool)
	fixture := gatewaydb.GatewayDeleteDashboardIntegrationFixtureParams{
		UserID: userID, OrganizationID: organizationID, WorkspaceID: workspaceID,
	}
	if err := dbQueries.GatewayDeleteDashboardIntegrationFixture(ctx, fixture); err != nil {
		t.Fatalf("clean integration fixture: %v", err)
	}
	defer func() {
		_ = dbQueries.GatewayDeleteDashboardIntegrationFixture(context.Background(), fixture)
	}()
	if err := dbQueries.GatewayCreateDashboardIntegrationFixture(ctx, gatewaydb.GatewayCreateDashboardIntegrationFixtureParams{
		SessionID: sessionID, OrganizationID: organizationID, OrganizationSlug: "dashboard-test",
		UserID: userID, UserEmail: "dashboard-test@example.test", WorkspaceID: workspaceID,
		WorkspaceSlug: "dashboard-test", WorkspaceNamespace: "ws-dashboard-test", AgentName: agentName,
	}); err != nil {
		t.Fatalf("seed integration fixture: %v", err)
	}

	measure := "requests"
	aggregation := gatewayapi.Sum
	group := "service"
	columns := []string{"service", "requests"}
	definition := gatewayapi.DashboardDefinition{
		Name: "service-health", Title: "Service health", Description: "Service request health.",
		Dimensions: []gatewayapi.DashboardDimension{{Name: "service", Label: "Service"}},
		Measures:   []gatewayapi.DashboardMeasure{{Name: measure, Label: "Requests"}},
		Filters: []gatewayapi.DashboardFilter{{
			Id: "service_filter", Label: "Service", Field: "service", Multiple: true,
		}},
		Widgets: []gatewayapi.DashboardWidget{
			{Id: "total", Title: "Total", Kind: gatewayapi.DashboardWidgetMetric, Width: gatewayapi.Third, Measure: &measure, Aggregation: &aggregation},
			{Id: "trend", Title: "Trend", Kind: gatewayapi.DashboardWidgetLine, Width: gatewayapi.Full, Measure: &measure, Aggregation: &aggregation, GroupBy: &group},
			{Id: "share", Title: "Share", Kind: gatewayapi.DashboardWidgetDonut, Width: gatewayapi.Half, Measure: &measure, Aggregation: &aggregation, GroupBy: &group},
			{Id: "table", Title: "Table", Kind: gatewayapi.DashboardWidgetTable, Width: gatewayapi.Half, Columns: &columns},
		},
	}
	service := &Service{db: pool, queries: dbQueries}
	authCtx := context.WithValue(ctx, authContextKey{}, requestAuth{
		actorType: requestActorSystem, actorID: "ws-dashboard-test:" + agentName,
		actorName: agentName, organizationID: organizationID, workspaceID: workspaceID,
	})
	definitionJSON, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("encode definition: %v", err)
	}
	createRequest := httptest.NewRequest(http.MethodPost, "/api/agent/dashboard-test-agent/dashboard", bytes.NewReader(definitionJSON)).WithContext(authCtx)
	createResponse := httptest.NewRecorder()
	service.CreateAgentDashboard(createResponse, createRequest, agentName, gatewayapi.CreateAgentDashboardParams{XAgentZSessionID: sessionID})
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create dashboard returned %d: %s", createResponse.Code, createResponse.Body.String())
	}

	now := time.Now().UTC().Truncate(time.Second)
	apiKey := "api"
	workerKey := "worker"
	writeBody := gatewayapi.WriteDashboardDataRequest{
		Action: gatewayapi.Upsert,
		Records: []gatewayapi.DashboardDataRecord{
			{RecordKey: &apiKey, ObservedAt: now.Add(-time.Minute), Dimensions: map[string]string{"service": "api"}, Measures: map[string]float64{"requests": 10}},
			{RecordKey: &workerKey, ObservedAt: now.Add(-30 * time.Second), Dimensions: map[string]string{"service": "worker"}, Measures: map[string]float64{"requests": 20}},
		},
	}
	writeJSON, err := json.Marshal(writeBody)
	if err != nil {
		t.Fatalf("encode write request: %v", err)
	}
	writeRequest := httptest.NewRequest(http.MethodPost, "/api/agent/dashboard-test-agent/dashboard/service-health/data", bytes.NewReader(writeJSON)).WithContext(authCtx)
	writeResponse := httptest.NewRecorder()
	service.WriteDashboardData(writeResponse, writeRequest, agentName, definition.Name, gatewayapi.WriteDashboardDataParams{XAgentZSessionID: sessionID})
	if writeResponse.Code != http.StatusOK {
		t.Fatalf("write dashboard data returned %d: %s", writeResponse.Code, writeResponse.Body.String())
	}

	stored, err := service.queries.GatewayGetAgentDashboard(ctx, gatewaydb.GatewayGetAgentDashboardParams{
		WorkspaceID: workspaceID, AgentName: agentName, Name: definition.Name,
	})
	if err != nil {
		t.Fatalf("load created dashboard: %v", err)
	}
	readTx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatalf("begin read transaction: %v", err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	readQueries := gatewaydb.New(readTx)
	timeRange := gatewayapi.DashboardTimeRange{From: now.Add(-time.Hour), To: now.Add(time.Minute)}
	filters := []byte("[]")
	if err := readQueries.GatewaySetDashboardQueryTimeout(ctx); err != nil {
		t.Fatalf("set dashboard query timeout: %v", err)
	}
	if _, err := readQueries.GatewayAcquireDashboardQuerySlot(ctx, workspaceID); err != nil {
		t.Fatalf("acquire dashboard query slot: %v", err)
	}
	options, err := readQueries.GatewayListDashboardFilterOptions(ctx, gatewaydb.GatewayListDashboardFilterOptionsParams{
		Field: "service", WorkspaceID: workspaceID, DashboardID: stored.ID,
		ObservedAfter:  pgtype.Timestamptz{Time: timeRange.From, Valid: true},
		ObservedBefore: pgtype.Timestamptz{Time: timeRange.To, Valid: true},
	})
	if err != nil || len(options) != 2 || options[0] != "api" || options[1] != "worker" {
		t.Fatalf("unexpected filter options: values=%v err=%v", options, err)
	}
	metric := gatewayapi.DashboardWidgetResult{Series: []gatewayapi.DashboardSeries{}, Points: []gatewayapi.DashboardPoint{}, Columns: []string{}, Rows: []gatewayapi.DashboardTableRow{}}
	if err := queryDashboardMetric(ctx, readQueries, workspaceID, stored.ID, definition.Widgets[0], timeRange, filters, &metric); err != nil {
		t.Fatalf("query metric: %v", err)
	}
	if metric.Total == nil || *metric.Total != 30 {
		t.Fatalf("unexpected metric total: %v", metric.Total)
	}
	serviceFilter, err := dashboardQueryFilters(definition, []gatewayapi.DashboardQueryFilter{{
		FilterId: "service_filter", Values: []string{"api"},
	}})
	if err != nil {
		t.Fatalf("encode service filter: %v", err)
	}
	filteredMetric := gatewayapi.DashboardWidgetResult{}
	if err := queryDashboardMetric(ctx, readQueries, workspaceID, stored.ID, definition.Widgets[0], timeRange, serviceFilter, &filteredMetric); err != nil {
		t.Fatalf("query filtered metric: %v", err)
	}
	if filteredMetric.Total == nil || *filteredMetric.Total != 10 {
		t.Fatalf("unexpected filtered metric total: %v", filteredMetric.Total)
	}
	isolatedMetric := gatewayapi.DashboardWidgetResult{}
	if err := queryDashboardMetric(ctx, readQueries, "another-workspace", stored.ID, definition.Widgets[0], timeRange, filters, &isolatedMetric); err != nil {
		t.Fatalf("query metric from another workspace: %v", err)
	}
	if isolatedMetric.Total == nil || *isolatedMetric.Total != 0 {
		t.Fatalf("unexpected cross-workspace metric total: %v", isolatedMetric.Total)
	}
	trend := gatewayapi.DashboardWidgetResult{Series: []gatewayapi.DashboardSeries{}, Points: []gatewayapi.DashboardPoint{}, Columns: []string{}, Rows: []gatewayapi.DashboardTableRow{}}
	if err := queryDashboardTimeSeries(ctx, readQueries, workspaceID, stored.ID, definition.Widgets[1], timeRange, filters, &trend); err != nil {
		t.Fatalf("query time series: %v", err)
	}
	if len(trend.Series) != 2 || len(trend.Points) == 0 {
		t.Fatalf("unexpected time series: %#v", trend)
	}
	donut := gatewayapi.DashboardWidgetResult{Series: []gatewayapi.DashboardSeries{}, Points: []gatewayapi.DashboardPoint{}, Columns: []string{}, Rows: []gatewayapi.DashboardTableRow{}}
	if err := queryDashboardDonut(ctx, readQueries, workspaceID, stored.ID, definition.Widgets[2], timeRange, filters, &donut); err != nil {
		t.Fatalf("query donut: %v", err)
	}
	if len(donut.Points) != 2 {
		t.Fatalf("unexpected donut: %#v", donut)
	}
	table := gatewayapi.DashboardWidgetResult{Series: []gatewayapi.DashboardSeries{}, Points: []gatewayapi.DashboardPoint{}, Columns: []string{}, Rows: []gatewayapi.DashboardTableRow{}}
	if err := queryDashboardTable(ctx, readQueries, workspaceID, stored.ID, definition, definition.Widgets[3], timeRange, filters, &table); err != nil {
		t.Fatalf("query table: %v", err)
	}
	if len(table.Rows) != 2 {
		t.Fatalf("unexpected table: %#v", table)
	}
	sortBy := "requests"
	descending := gatewayapi.DashboardSortDirectionDesc
	sortedWidget := definition.Widgets[3]
	sortedWidget.SortBy = &sortBy
	sortedWidget.SortDirection = &descending
	sortedTable := gatewayapi.DashboardWidgetResult{Columns: []string{}, Rows: []gatewayapi.DashboardTableRow{}}
	if err := queryDashboardTable(ctx, readQueries, workspaceID, stored.ID, definition, sortedWidget, timeRange, filters, &sortedTable); err != nil {
		t.Fatalf("query sorted table: %v", err)
	}
	if len(sortedTable.Rows) != 2 || sortedTable.Rows[0].Cells[0] != "worker" {
		t.Fatalf("unexpected sorted table: %#v", sortedTable)
	}
	if err := readTx.Commit(ctx); err != nil {
		t.Fatalf("commit reads: %v", err)
	}

	if _, err := dbQueries.GatewayExpireDashboardIntegrationRecords(ctx, stored.ID); err != nil {
		t.Fatalf("expire records: %v", err)
	}
	deleted, err := service.queries.GatewayDeleteExpiredDashboardRecords(ctx, 1000)
	if err != nil || deleted != 2 {
		t.Fatalf("delete expired records: deleted=%d err=%v", deleted, err)
	}
	auditEvents, err := dbQueries.GatewayCountDashboardIntegrationAuditEvents(ctx, organizationID)
	if err != nil || auditEvents != 2 {
		t.Fatalf("dashboard audit events: count=%d err=%v", auditEvents, err)
	}

	if _, err := dbQueries.GatewayMarkDashboardIntegrationSessionAsWorkflowRun(ctx, gatewaydb.GatewayMarkDashboardIntegrationSessionAsWorkflowRunParams{
		WorkspaceID: workspaceID, AgentName: agentName, SessionID: sessionID,
	}); err != nil {
		t.Fatalf("mark session as workflow run: %v", err)
	}
	workflowWriteRequest := httptest.NewRequest(http.MethodPost, "/api/agent/dashboard-test-agent/dashboard/service-health/data", bytes.NewReader(writeJSON)).WithContext(authCtx)
	workflowWriteResponse := httptest.NewRecorder()
	service.WriteDashboardData(workflowWriteResponse, workflowWriteRequest, agentName, definition.Name, gatewayapi.WriteDashboardDataParams{XAgentZSessionID: sessionID})
	if workflowWriteResponse.Code != http.StatusOK {
		t.Fatalf("workflow-run data write returned %d: %s", workflowWriteResponse.Code, workflowWriteResponse.Body.String())
	}
	forbiddenRequest := httptest.NewRequest(http.MethodPost, "/api/agent/dashboard-test-agent/dashboard", bytes.NewReader(definitionJSON)).WithContext(authCtx)
	forbiddenResponse := httptest.NewRecorder()
	service.CreateAgentDashboard(forbiddenResponse, forbiddenRequest, agentName, gatewayapi.CreateAgentDashboardParams{XAgentZSessionID: sessionID})
	if forbiddenResponse.Code != http.StatusForbidden {
		t.Fatalf("workflow-run definition mutation returned %d: %s", forbiddenResponse.Code, forbiddenResponse.Body.String())
	}
}
