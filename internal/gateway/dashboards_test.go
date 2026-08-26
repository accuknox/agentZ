package gateway

import (
	"testing"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestValidateDashboardWidget(t *testing.T) {
	t.Parallel()
	series := []gatewayapi.DashboardSeries{{Name: "requests", Label: "Requests", Aggregation: gatewayapi.Sum}}
	columns := []gatewayapi.DashboardTableColumn{{Name: "status", Label: "Status", Type: gatewayapi.DashboardTableColumnTypeText, Sortable: true}}
	emptySeries := []gatewayapi.DashboardSeries{}
	emptyColumns := []gatewayapi.DashboardTableColumn{}
	thresholds := []gatewayapi.DashboardGaugeThreshold{}
	minimum, maximum := float64(0), float64(100)
	tests := []struct {
		name    string
		widget  gatewayapi.DashboardWidgetDefinition
		wantErr bool
	}{
		{name: "temporal line", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Full, Kind: gatewayapi.Line, Mode: gatewayapi.Temporal, Series: series, Columns: emptyColumns, Thresholds: thresholds}},
		{name: "latest pie", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Half, Kind: gatewayapi.Pie, Mode: gatewayapi.Latest, Series: series, Columns: emptyColumns, Thresholds: thresholds}},
		{name: "table", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Third, Kind: gatewayapi.Table, Mode: gatewayapi.Temporal, Series: emptySeries, Columns: columns, Thresholds: thresholds}},
		{name: "gauge", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Full, Kind: gatewayapi.Gauge, Mode: gatewayapi.Latest, Series: series, Columns: emptyColumns, Thresholds: thresholds, Minimum: &minimum, Maximum: &maximum}},
		{name: "latest line", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Full, Kind: gatewayapi.Line, Mode: gatewayapi.Latest, Series: series, Columns: emptyColumns, Thresholds: thresholds}, wantErr: true},
		{name: "pie with columns", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Full, Kind: gatewayapi.Pie, Mode: gatewayapi.Latest, Series: series, Columns: columns, Thresholds: thresholds}, wantErr: true},
		{name: "table with series", widget: gatewayapi.DashboardWidgetDefinition{Name: "widget", Title: "Widget", Width: gatewayapi.Full, Kind: gatewayapi.Table, Mode: gatewayapi.Latest, Series: series, Columns: columns, Thresholds: thresholds}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDashboardWidget(test.widget)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateDashboardWidget() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestValidateDashboardRecords(t *testing.T) {
	t.Parallel()
	text := "ready"
	number := 3.0
	tests := []struct {
		name    string
		widget  gatewayapi.DashboardWidgetDefinition
		records []gatewayapi.DashboardDataRecord
		wantErr bool
	}{
		{
			name:    "time series",
			widget:  gatewayapi.DashboardWidgetDefinition{Kind: gatewayapi.Line, Series: []gatewayapi.DashboardSeries{{Name: "value"}}},
			records: []gatewayapi.DashboardDataRecord{{Values: &[]float64{4}}},
		},
		{
			name:    "typed table cells",
			widget:  gatewayapi.DashboardWidgetDefinition{Kind: gatewayapi.Table, Columns: []gatewayapi.DashboardTableColumn{{Type: gatewayapi.DashboardTableColumnTypeText}, {Type: gatewayapi.DashboardTableColumnTypeNumber}}},
			records: []gatewayapi.DashboardDataRecord{{Cells: &[]gatewayapi.DashboardCell{{Text: &text}, {Number: &number}}}},
		},
		{
			name:    "wrong series count",
			widget:  gatewayapi.DashboardWidgetDefinition{Kind: gatewayapi.Line, Series: []gatewayapi.DashboardSeries{{Name: "first"}, {Name: "second"}}},
			records: []gatewayapi.DashboardDataRecord{{Values: &[]float64{4}}},
			wantErr: true,
		},
		{
			name:    "ambiguous cell",
			widget:  gatewayapi.DashboardWidgetDefinition{Kind: gatewayapi.Table, Columns: []gatewayapi.DashboardTableColumn{{Type: gatewayapi.DashboardTableColumnTypeText}}},
			records: []gatewayapi.DashboardDataRecord{{Cells: &[]gatewayapi.DashboardCell{{Text: &text, Number: &number}}}},
			wantErr: true,
		},
		{
			name:    "multiple gauge records",
			widget:  gatewayapi.DashboardWidgetDefinition{Kind: gatewayapi.Gauge, Series: []gatewayapi.DashboardSeries{{Name: "value"}}},
			records: []gatewayapi.DashboardDataRecord{{Values: &[]float64{4}}, {Values: &[]float64{5}}},
			wantErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDashboardRecords(test.widget, test.records)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateDashboardRecords() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestDashboardBucketSeconds(t *testing.T) {
	t.Parallel()
	tests := []struct {
		period time.Duration
		points int32
		want   int32
	}{
		{period: time.Hour, points: 240, want: 30},
		{period: 24 * time.Hour, points: 240, want: 900},
		{period: 7 * 24 * time.Hour, points: 240, want: 3600},
		{period: 30 * 24 * time.Hour, points: 240, want: 10800},
	}
	for _, test := range tests {
		t.Run(test.period.String(), func(t *testing.T) {
			if got := dashboardBucketSeconds(test.period, test.points); got != test.want {
				t.Fatalf("dashboardBucketSeconds() = %d, want %d", got, test.want)
			}
		})
	}
}

func BenchmarkValidateDashboardRecords(b *testing.B) {
	values := []float64{1, 2, 3, 4, 5}
	records := make([]gatewayapi.DashboardDataRecord, 100)
	for i := range records {
		records[i].Values = &values
	}
	widget := gatewayapi.DashboardWidgetDefinition{
		Kind:   gatewayapi.Line,
		Series: []gatewayapi.DashboardSeries{{Name: "s0"}, {Name: "s1"}, {Name: "s2"}, {Name: "s3"}, {Name: "s4"}},
	}
	b.ReportAllocs()
	for b.Loop() {
		if err := validateDashboardRecords(widget, records); err != nil {
			b.Fatal(err)
		}
	}
}
