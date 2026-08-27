package v1alpha1

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type dashboardQuotaChange struct {
	name   string
	change func(*agentzv1alpha1.Tenant)
}

func TestValidatorRejectsAgentCountDecrease(t *testing.T) {
	t.Parallel()

	oldTenant := tenantWithQuota("tenant", "1")
	newTenant := oldTenant.DeepCopy()
	newTenant.Spec.AgentQuota.Count--

	_, err := (&Validator{}).ValidateUpdate(context.Background(), oldTenant, newTenant)
	if err == nil {
		t.Fatal("ValidateUpdate() accepted an Agent count decrease")
	}
}

func TestValidatorRejectsDashboardQuotaRemovalAndDecrease(t *testing.T) {
	t.Parallel()

	oldTenant := tenantWithQuota("tenant", "1")
	tests := []dashboardQuotaChange{
		{name: "removed", change: func(tenant *agentzv1alpha1.Tenant) {
			tenant.Spec.DashboardQuota = nil
		}},
		{name: "count", change: func(tenant *agentzv1alpha1.Tenant) {
			tenant.Spec.DashboardQuota.Query.ConcurrentRequests--
		}},
		{name: "quantity", change: func(tenant *agentzv1alpha1.Tenant) {
			tenant.Spec.DashboardQuota.Publish.RequestBytes = resource.MustParse("128Ki")
		}},
		{name: "duration", change: func(tenant *agentzv1alpha1.Tenant) {
			tenant.Spec.DashboardQuota.Query.Timeout.Duration--
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			updated := oldTenant.DeepCopy()
			test.change(updated)
			issues := validateDashboardQuota(oldTenant, updated)
			if len(issues) == 0 {
				t.Fatal("validateDashboardQuota() accepted a quota reduction")
			}
		})
	}
}

func TestValidatorRejectsNonPositiveDashboardQuota(t *testing.T) {
	t.Parallel()

	tenant := tenantWithQuota("tenant", "1")
	tenant.Spec.DashboardQuota.Publish.TemporalRecordsPerDay = 0
	issues := validateDashboardQuota(nil, tenant)
	if len(issues) == 0 {
		t.Fatal("validateDashboardQuota() accepted a zero limit")
	}
}

func TestValidatorChecksOnlyQuotaReductionsAgainstUsage(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	tenantName := "tenant"
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name: "workspace",
			Labels: map[string]string{
				agentzv1alpha1.TenantOrganizationIDLabel: tenantName,
			},
		}},
		&agentzv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
			Spec: agentzv1alpha1.AgentSpec{Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("750m"),
					corev1.ResourceMemory: resource.MustParse("800Mi"),
				},
			}},
		},
	).Build()
	validator := &Validator{reader: reader}

	oldTenant := tenantWithQuota(tenantName, "1")
	reduced := oldTenant.DeepCopy()
	reduced.Spec.AgentQuota.Resources.CPU = resource.MustParse("500m")
	issues := validator.validateAgentQuota(context.Background(), oldTenant, reduced)
	if len(issues) == 0 {
		t.Fatal("validateAgentQuota() accepted a CPU quota below current usage")
	}

	previouslyOverQuota := tenantWithQuota(tenantName, "500m")
	increased := previouslyOverQuota.DeepCopy()
	increased.Spec.AgentQuota.Resources.CPU = resource.MustParse("600m")
	issues = validator.validateAgentQuota(
		context.Background(),
		previouslyOverQuota,
		increased,
	)
	if len(issues) != 0 {
		t.Fatalf("validateAgentQuota() rejected a non-decreasing quota: %v", issues)
	}
}

func tenantWithQuota(name, cpu string) *agentzv1alpha1.Tenant {
	return &agentzv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: agentzv1alpha1.TenantSpec{
			OrganizationID: "organization",
			AgentQuota: &agentzv1alpha1.AgentQuota{
				Count: 2,
				Resources: agentzv1alpha1.ComputeResources{
					CPU:    resource.MustParse(cpu),
					Memory: resource.MustParse("1600Mi"),
				},
				Defaults: agentzv1alpha1.AgentDefaults{
					Resources: agentzv1alpha1.ComputeResources{
						CPU:    resource.MustParse("200m"),
						Memory: resource.MustParse("400Mi"),
					},
					QoSClass: corev1.PodQOSGuaranteed,
				},
			},
			DashboardQuota: &agentzv1alpha1.DashboardQuota{
				DashboardsPerAgent:  25,
				WidgetsPerDashboard: 24,
				Publish: agentzv1alpha1.DashboardPublishQuota{
					RequestBytes:              resource.MustParse("256Ki"),
					RecordsPerRequest:         100,
					RequestsPerMinutePerAgent: 30,
					AcceptedBytesPerDay:       resource.MustParse("64Mi"),
					TemporalRecordsPerDay:     50_000,
					RetainedTemporalRecords:   1_500_000,
					LatestBytesPerAgent:       resource.MustParse("64Mi"),
				},
				Query: agentzv1alpha1.DashboardQueryQuota{
					RequestsPerMinutePerUser: 30,
					ReturnedCellsPerHour:     5_000_000,
					ConcurrentRequests:       4,
					CellsPerRequest:          50_000,
					ResponseBytes:            resource.MustParse("2Mi"),
					PointsPerSeries:          500,
					Timeout:                  metav1.Duration{Duration: 5 * time.Second},
				},
			},
		},
	}
}
