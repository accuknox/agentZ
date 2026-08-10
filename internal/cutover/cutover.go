// Package cutover migrates legacy Tenant state into Default Workspaces.
package cutover

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	baoapi "github.com/openbao/openbao/api/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	cutoverdb "github.com/accuknox/agentz/internal/cutover/db"
	internalmcp "github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	defaultWorkspaceName = "Default"
	checkpointPlanned    = "planned"
	checkpointOpenBao    = "openbao"
	checkpointS3         = "s3"
	checkpointKubernetes = "kubernetes"
	checkpointVerified   = "verified"
	checkpointSQL        = "sql"
	checkpointActivated  = "activated"
	cutoverLockID        = int64(0x41475a435554)
)

// Config contains the explicit operator inputs for one cutover run.
type Config struct {
	PostgresDSN      string
	Kubeconfig       string
	OpenBaoAddress   string
	OpenBaoMountPath string
	OpenBaoToken     string
	S3Endpoint       string
	S3Region         string
	S3Bucket         string
	S3AccessKeyID    string
	S3SecretKey      string
	BackupManifest   string
	MaintenanceMode  bool
	Commit           bool
	WorkspaceTimeout time.Duration
}

// BackupManifest records independently verified backups for every cutover store.
type BackupManifest struct {
	PostgreSQL BackupEvidence `json:"postgresql"`
	Kubernetes BackupEvidence `json:"kubernetes"`
	OpenBao    BackupEvidence `json:"openbao"`
	S3         BackupEvidence `json:"s3"`
}

// BackupEvidence identifies one verified backup without exposing credentials.
type BackupEvidence struct {
	Location string `json:"location"`
	SHA256   string `json:"sha256"`
	Verified bool   `json:"verified"`
}

// Report is the deterministic all-store inventory produced by dry-run and commit modes.
type Report struct {
	Mode      string            `json:"mode"`
	Generated time.Time         `json:"generated_at"`
	Tenants   []TenantInventory `json:"tenants"`
}

// TenantInventory is the complete migration plan and verification basis for one Tenant.
type TenantInventory struct {
	Organization OrganizationInventory `json:"organization"`
	Workspace    WorkspaceInventory    `json:"workspace"`
	PostgreSQL   PostgreSQLInventory   `json:"postgresql"`
	Kubernetes   KubernetesInventory   `json:"kubernetes"`
	OpenBao      []ObjectInventory     `json:"openbao"`
	S3           []ObjectInventory     `json:"s3"`
	Checkpoint   string                `json:"checkpoint"`
	Hash         string                `json:"hash"`
}

// OrganizationInventory records preserved Better Auth identity and the active
// member selected to own migrated user-created resources.
type OrganizationInventory struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Slug            string            `json:"slug"`
	MigrationUserID string            `json:"migration_user_id"`
	Members         []MemberInventory `json:"members"`
}

// MemberInventory records preserved identity row counts without secret material.
type MemberInventory struct {
	MemberID     string `json:"member_id"`
	UserID       string `json:"user_id"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	Disabled     bool   `json:"disabled"`
	Superadmin   bool   `json:"superadmin"`
	AccountCount int32  `json:"account_count"`
	SessionCount int32  `json:"session_count"`
}

// WorkspaceInventory records the deterministic Default Workspace identity.
type WorkspaceInventory struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Slug                   string `json:"slug"`
	SourceTenantName       string `json:"source_tenant_name"`
	OrganizationTenantName string `json:"organization_tenant_name"`
	SourceNamespace        string `json:"source_namespace"`
	TargetNamespace        string `json:"target_namespace"`
}

// PostgreSQLInventory records scoped rows and exact API-key rewrites.
type PostgreSQLInventory struct {
	Counts      cutoverdb.CountNamespaceRowsRow `json:"counts"`
	Agents      []string                        `json:"agents"`
	AgentOwners []AgentOwnerInventory           `json:"agent_owners"`
	Workflows   []WorkflowInventory             `json:"workflows"`
	APIKeys     []APIKeyInventory               `json:"api_keys"`
}

// AgentOwnerInventory records the ownership rows created during activation.
type AgentOwnerInventory struct {
	AgentName     string `json:"agent_name"`
	CreatorUserID string `json:"creator_user_id"`
	OwnerUserID   string `json:"owner_user_id"`
}

// WorkflowInventory identifies one workflow target.
type WorkflowInventory struct {
	Agent string `json:"agent"`
	Name  string `json:"name"`
}

// APIKeyInventory records a key rewrite without recording key material.
type APIKeyInventory struct {
	ID            string                  `json:"id"`
	ConfigID      string                  `json:"config_id"`
	Name          string                  `json:"name"`
	Enabled       bool                    `json:"enabled"`
	CreatorUserID string                  `json:"creator_user_id"`
	MaterialHash  string                  `json:"material_hash"`
	Targets       []APIKeyTargetInventory `json:"targets"`
}

// APIKeyTargetInventory is one generated Workspace-bound key target.
type APIKeyTargetInventory struct {
	Type         string `json:"type"`
	AgentName    string `json:"agent_name"`
	WorkflowName string `json:"workflow_name,omitempty"`
}

// KubernetesInventory records every copied AgentZ object and persistent claim.
type KubernetesInventory struct {
	Objects []KubernetesObjectInventory `json:"objects"`
	PVCs    []PVCInventory              `json:"persistent_volume_claims"`
}

// KubernetesObjectInventory identifies one object and its transformed payload hash.
type KubernetesObjectInventory struct {
	Kind    string          `json:"kind"`
	Name    string          `json:"name"`
	Desired json.RawMessage `json:"desired"`
	SHA256  string          `json:"sha256"`
}

// PVCInventory records storage identity and requested capacity.
type PVCInventory struct {
	Name    string `json:"name"`
	Storage string `json:"storage"`
}

// ObjectInventory records a credential or immutable object without its contents.
type ObjectInventory struct {
	Path   string `json:"path"`
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256"`
}

type legacyPermissions struct {
	OpenCode []string `json:"opencode"`
	Webhook  []string `json:"webhook"`
}

type stores struct {
	pool *pgxpool.Pool
	db   *cutoverdb.Queries
	k8s  ctrlclient.Client
	bao  *baoapi.KVv2
	s3   *s3.Client
}

// Run inventories every Tenant and optionally commits the resumable cutover.
func Run(ctx context.Context, cfg Config) (Report, error) {
	if err := validateConfig(cfg); err != nil {
		return Report{}, err
	}
	manifestHash, err := verifyBackupManifest(cfg.BackupManifest)
	if err != nil {
		return Report{}, err
	}
	clients, err := openStores(ctx, cfg)
	if err != nil {
		return Report{}, err
	}
	defer clients.pool.Close()

	if cfg.Commit {
		conn, err := clients.pool.Acquire(ctx)
		if err != nil {
			return Report{}, fmt.Errorf("acquire cutover PostgreSQL connection: %w", err)
		}
		lockDB := cutoverdb.New(conn)
		locked, err := lockDB.TryLock(ctx, cutoverLockID)
		if err != nil {
			conn.Release()
			return Report{}, fmt.Errorf("acquire cutover lock: %w", err)
		}
		if !locked {
			conn.Release()
			return Report{}, errors.New("another cutover process holds the PostgreSQL lock")
		}
		defer func() {
			_, _ = lockDB.Unlock(context.Background(), cutoverLockID)
			conn.Release()
		}()
	}

	report := Report{Mode: "dry-run", Generated: time.Now().UTC(), Tenants: []TenantInventory{}}
	if cfg.Commit {
		report.Mode = "commit"
	}
	var tenants agentzv1alpha1.TenantList
	if err := clients.k8s.List(ctx, &tenants); err != nil {
		return Report{}, fmt.Errorf("list Tenants: %w", err)
	}
	slices.SortFunc(tenants.Items, func(a, b agentzv1alpha1.Tenant) int {
		return strings.Compare(a.Spec.OrganizationID, b.Spec.OrganizationID)
	})
	seen := make(map[string]struct{}, len(tenants.Items))
	for i := range tenants.Items {
		seen[tenants.Items[i].Spec.OrganizationID] = struct{}{}
		inventory, err := inventoryTenant(ctx, cfg, clients, &tenants.Items[i])
		if err != nil {
			return Report{}, err
		}
		if cfg.Commit {
			inventory, err = commitTenant(ctx, cfg, clients, manifestHash, inventory)
			if err != nil {
				return Report{}, err
			}
		}
		report.Tenants = append(report.Tenants, inventory)
	}
	states, err := clients.db.ListStates(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("list durable cutovers: %w", err)
	}
	for _, state := range states {
		if _, ok := seen[state.OrganizationID]; ok {
			continue
		}
		var inventory TenantInventory
		if err := json.Unmarshal(state.Inventory, &inventory); err != nil {
			return Report{}, fmt.Errorf("decode durable cutover inventory: %w", err)
		}
		inventory.Checkpoint = state.Checkpoint
		if cfg.Commit {
			inventory, err = commitTenant(ctx, cfg, clients, manifestHash, inventory)
			if err != nil {
				return Report{}, err
			}
		}
		report.Tenants = append(report.Tenants, inventory)
	}
	return report, nil
}

func validateConfig(cfg Config) error {
	if cfg.PostgresDSN == "" || cfg.Kubeconfig == "" || cfg.OpenBaoAddress == "" ||
		cfg.OpenBaoMountPath == "" || cfg.OpenBaoToken == "" || cfg.S3Endpoint == "" ||
		cfg.S3Region == "" || cfg.S3Bucket == "" || cfg.S3AccessKeyID == "" ||
		cfg.S3SecretKey == "" || cfg.BackupManifest == "" {
		return errors.New("PostgreSQL, Kubernetes, OpenBao, S3, and backup configuration are required")
	}
	if !cfg.MaintenanceMode {
		return errors.New("cutover requires verified maintenance mode")
	}
	if cfg.WorkspaceTimeout <= 0 {
		return errors.New("workspace timeout must be positive")
	}
	return nil
}

func verifyBackupManifest(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read backup manifest: %w", err)
	}
	var manifest BackupManifest
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&manifest); err != nil {
		return "", fmt.Errorf("decode backup manifest: %w", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return "", errors.New("backup manifest must contain exactly one JSON value")
	}
	entries := []BackupEvidence{
		manifest.PostgreSQL,
		manifest.Kubernetes,
		manifest.OpenBao,
		manifest.S3,
	}
	for _, entry := range entries {
		_, err := hex.DecodeString(entry.SHA256)
		if !entry.Verified || entry.Location == "" || err != nil || len(entry.SHA256) != 64 {
			return "", errors.New("every store requires a location and verified SHA-256 backup")
		}
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func openStores(ctx context.Context, cfg Config) (stores, error) {
	pool, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return stores{}, fmt.Errorf("open PostgreSQL: %w", err)
	}
	kubeConfig, err := clientcmd.BuildConfigFromFlags("", cfg.Kubeconfig)
	if err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("load kubeconfig: %w", err)
	}
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("register Kubernetes scheme: %w", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("register AgentZ scheme: %w", err)
	}
	if err := ciliumv2.AddToScheme(scheme); err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("register Cilium scheme: %w", err)
	}
	k8s, err := ctrlclient.New(kubeConfig, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("create Kubernetes client: %w", err)
	}
	bao, err := baoapi.NewClient(&baoapi.Config{Address: cfg.OpenBaoAddress})
	if err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("create OpenBao client: %w", err)
	}
	bao.SetToken(cfg.OpenBaoToken)
	awsCfg, err := awsconfig.LoadDefaultConfig(
		ctx,
		awsconfig.WithRegion(cfg.S3Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			cfg.S3AccessKeyID,
			cfg.S3SecretKey,
			"",
		)),
	)
	if err != nil {
		pool.Close()
		return stores{}, fmt.Errorf("load S3 configuration: %w", err)
	}
	s3Client := s3.NewFromConfig(awsCfg, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(cfg.S3Endpoint)
		options.UsePathStyle = true
	})
	return stores{
		pool: pool,
		db:   cutoverdb.New(pool),
		k8s:  k8s,
		bao:  bao.KVv2(cfg.OpenBaoMountPath),
		s3:   s3Client,
	}, nil
}

func inventoryTenant(ctx context.Context, cfg Config, clients stores, tenant *agentzv1alpha1.Tenant) (TenantInventory, error) {
	organization, err := clients.db.GetOrganization(ctx, tenant.Spec.OrganizationID)
	if err != nil {
		return TenantInventory{}, fmt.Errorf("get Organisation %q: %w", tenant.Spec.OrganizationID, err)
	}
	members, err := clients.db.ListMembers(ctx, tenant.Spec.OrganizationID)
	if err != nil {
		return TenantInventory{}, fmt.Errorf("list Organisation %q members: %w", tenant.Spec.OrganizationID, err)
	}
	sourceNamespace := tenant.Status.Namespace
	if sourceNamespace == "" {
		sourceNamespace = tenant.Name
	}
	migrationUserID := ""
	for _, member := range members {
		if !member.DisabledAt.Valid && member.Superadmin {
			migrationUserID = member.UserID
			break
		}
	}
	if migrationUserID == "" {
		for _, member := range members {
			if !member.DisabledAt.Valid {
				migrationUserID = member.UserID
				break
			}
		}
	}
	if migrationUserID == "" {
		return TenantInventory{}, fmt.Errorf("Tenant %q has no active Organisation member", tenant.Name)
	}
	sum := sha256.Sum256([]byte(tenant.Spec.OrganizationID))
	suffix := hex.EncodeToString(sum[:])
	workspaceID := "workspace-default-" + suffix[:32]
	workspace := WorkspaceInventory{
		ID:               workspaceID,
		Name:             defaultWorkspaceName,
		Slug:             "default-" + suffix[:8],
		SourceTenantName: tenant.Name,
		OrganizationTenantName: agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeOrganisation,
			tenant.Spec.OrganizationID,
		),
		SourceNamespace: sourceNamespace,
		TargetNamespace: agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeWorkspace,
			workspaceID,
		),
	}
	memberInventory := make([]MemberInventory, 0, len(members))
	for _, member := range members {
		memberInventory = append(memberInventory, MemberInventory{
			MemberID:     member.MemberID,
			UserID:       member.UserID,
			Name:         member.Name,
			Email:        member.Email,
			Disabled:     member.DisabledAt.Valid,
			Superadmin:   member.Superadmin,
			AccountCount: member.AccountCount,
			SessionCount: member.SessionCount,
		})
	}
	postgres, err := inventoryPostgreSQL(
		ctx,
		clients.db,
		tenant.Spec.OrganizationID,
		sourceNamespace,
		migrationUserID,
	)
	if err != nil {
		return TenantInventory{}, err
	}
	kubernetes, err := inventoryKubernetes(ctx, cfg, clients.k8s, sourceNamespace, workspace.TargetNamespace, migrationUserID)
	if err != nil {
		return TenantInventory{}, err
	}
	openBao, err := inventoryOpenBao(ctx, clients.bao, sourceNamespace)
	if err != nil {
		return TenantInventory{}, err
	}
	s3Objects, err := inventoryS3(ctx, clients.s3, cfg.S3Bucket, sourceNamespace)
	if err != nil {
		return TenantInventory{}, err
	}
	inventory := TenantInventory{
		Organization: OrganizationInventory{
			ID: organization.ID, Name: organization.Name, Slug: organization.Slug,
			MigrationUserID: migrationUserID, Members: memberInventory,
		},
		Workspace:  workspace,
		PostgreSQL: postgres,
		Kubernetes: kubernetes,
		OpenBao:    openBao,
		S3:         s3Objects,
		Checkpoint: checkpointPlanned,
	}
	inventory.Hash, err = inventoryHash(inventory)
	if err != nil {
		return TenantInventory{}, err
	}
	state, err := clients.db.GetState(ctx, tenant.Spec.OrganizationID)
	if err == nil {
		if state.Checkpoint == checkpointSQL || state.Checkpoint == checkpointActivated {
			if err := json.Unmarshal(state.Inventory, &inventory); err != nil {
				return TenantInventory{}, fmt.Errorf("decode durable cutover inventory: %w", err)
			}
		}
		inventory.Checkpoint = state.Checkpoint
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return TenantInventory{}, fmt.Errorf("get cutover checkpoint: %w", err)
	}
	return inventory, nil
}

func inventoryPostgreSQL(ctx context.Context, db *cutoverdb.Queries, organizationID, namespace, owner string) (PostgreSQLInventory, error) {
	counts, err := db.CountNamespaceRows(ctx, namespace)
	if err != nil {
		return PostgreSQLInventory{}, fmt.Errorf("count PostgreSQL namespace rows: %w", err)
	}
	agents, err := db.ListAgents(ctx, namespace)
	if err != nil {
		return PostgreSQLInventory{}, fmt.Errorf("list PostgreSQL Agents: %w", err)
	}
	workflows, err := db.ListWorkflows(ctx, namespace)
	if err != nil {
		return PostgreSQLInventory{}, fmt.Errorf("list PostgreSQL Workflows: %w", err)
	}
	keys, err := db.ListLegacyAPIKeys(ctx, organizationID)
	if err != nil {
		return PostgreSQLInventory{}, fmt.Errorf("list legacy API keys: %w", err)
	}
	agentNames := make([]string, 0, len(agents))
	agentOwners := make([]AgentOwnerInventory, 0, len(agents))
	for _, agent := range agents {
		agentNames = append(agentNames, agent.AgentName)
		agentOwners = append(agentOwners, AgentOwnerInventory{
			AgentName: agent.AgentName, CreatorUserID: owner, OwnerUserID: owner,
		})
	}
	workflowInventory := make([]WorkflowInventory, 0, len(workflows))
	for _, workflow := range workflows {
		workflowInventory = append(workflowInventory, WorkflowInventory{
			Agent: workflow.AgentName,
			Name:  workflow.WorkflowName,
		})
	}
	keyInventory := make([]APIKeyInventory, 0, len(keys))
	for _, key := range keys {
		if !key.Name.Valid || !key.Enabled.Valid {
			return PostgreSQLInventory{}, fmt.Errorf("legacy API key %q is incomplete", key.ID)
		}
		targets, err := legacyAPIKeyTargets(key.ConfigID, key.Permissions, agentNames, workflowInventory)
		if err != nil {
			return PostgreSQLInventory{}, fmt.Errorf("plan API key %q: %w", key.ID, err)
		}
		material := sha256.Sum256([]byte(key.Key))
		keyInventory = append(keyInventory, APIKeyInventory{
			ID: key.ID, ConfigID: key.ConfigID, Name: key.Name.String, Enabled: key.Enabled.Bool,
			CreatorUserID: owner,
			MaterialHash:  hex.EncodeToString(material[:]), Targets: targets,
		})
	}
	return PostgreSQLInventory{
		Counts: counts, Agents: agentNames, AgentOwners: agentOwners,
		Workflows: workflowInventory, APIKeys: keyInventory,
	}, nil
}

func legacyAPIKeyTargets(configID string, raw pgtype.Text, agents []string, workflows []WorkflowInventory) ([]APIKeyTargetInventory, error) {
	if !raw.Valid {
		return nil, errors.New("legacy permissions are missing")
	}
	var permissions legacyPermissions
	if err := json.Unmarshal([]byte(raw.String), &permissions); err != nil {
		return nil, fmt.Errorf("decode legacy permissions: %w", err)
	}
	var values []string
	var targetType string
	switch configID {
	case "agent-api-key":
		values = permissions.OpenCode
		targetType = "agent"
	case "webhook-api-key":
		values = permissions.Webhook
		targetType = "workflow"
	default:
		return nil, fmt.Errorf("unsupported Better Auth API-key config %q", configID)
	}
	if len(values) == 0 {
		return nil, errors.New("legacy API key has no permissions")
	}
	targets := []APIKeyTargetInventory{}
	for _, value := range values {
		if value == "all" {
			if targetType == "agent" {
				for _, agent := range agents {
					targets = append(targets, APIKeyTargetInventory{Type: targetType, AgentName: agent})
				}
			} else {
				for _, workflow := range workflows {
					targets = append(targets, APIKeyTargetInventory{
						Type: targetType, AgentName: workflow.Agent, WorkflowName: workflow.Name,
					})
				}
			}
			continue
		}
		parts := strings.Split(value, ":")
		if targetType == "agent" && len(parts) == 2 && parts[0] == "agent" {
			targets = append(targets, APIKeyTargetInventory{Type: targetType, AgentName: parts[1]})
			continue
		}
		if targetType == "workflow" && len(parts) == 3 && parts[0] == "workflow" {
			targets = append(targets, APIKeyTargetInventory{
				Type: targetType, AgentName: parts[1], WorkflowName: parts[2],
			})
			continue
		}
		return nil, fmt.Errorf("invalid legacy permission %q", value)
	}
	slices.SortFunc(targets, func(a, b APIKeyTargetInventory) int {
		return strings.Compare(a.AgentName+"\x00"+a.WorkflowName, b.AgentName+"\x00"+b.WorkflowName)
	})
	targets = slices.Compact(targets)
	return targets, nil
}

func inventoryKubernetes(ctx context.Context, cfg Config, k8s ctrlclient.Client, source, target, owner string) (KubernetesInventory, error) {
	objects, err := desiredKubernetesObjects(ctx, cfg, k8s, source, target, owner)
	if err != nil {
		return KubernetesInventory{}, err
	}
	var pvcs corev1.PersistentVolumeClaimList
	if err := k8s.List(ctx, &pvcs, ctrlclient.InNamespace(source)); err != nil {
		return KubernetesInventory{}, fmt.Errorf("list source PVCs: %w", err)
	}
	pvcInventory := make([]PVCInventory, 0, len(pvcs.Items))
	for _, pvc := range pvcs.Items {
		pvcInventory = append(pvcInventory, PVCInventory{
			Name: pvc.Name, Storage: pvc.Spec.Resources.Requests.Storage().String(),
		})
	}
	slices.SortFunc(pvcInventory, func(a, b PVCInventory) int { return strings.Compare(a.Name, b.Name) })
	return KubernetesInventory{Objects: objects, PVCs: pvcInventory}, nil
}

func desiredKubernetesObjects(ctx context.Context, cfg Config, k8s ctrlclient.Client, source, target, owner string) ([]KubernetesObjectInventory, error) {
	objects := []KubernetesObjectInventory{}
	add := func(kind, name string, value any) error {
		raw, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("marshal %s %q: %w", kind, name, err)
		}
		sum := sha256.Sum256(raw)
		objects = append(objects, KubernetesObjectInventory{
			Kind: kind, Name: name, Desired: raw, SHA256: hex.EncodeToString(sum[:]),
		})
		return nil
	}
	var skills agentzv1alpha1.SkillList
	if err := k8s.List(ctx, &skills, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list Skills: %w", err)
	}
	for i := range skills.Items {
		item := &skills.Items[i]
		item.Spec.CreatorUserID = owner
		item.Spec.StoragePath = (skill.Config{Bucket: cfg.S3Bucket}).StoragePath(
			target,
			item.Name,
			item.Spec.Version,
		)
		if err := add("Skill", item.Name, item.Spec); err != nil {
			return nil, err
		}
	}
	var providers agentzv1alpha1.InferenceProviderList
	if err := k8s.List(ctx, &providers, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list InferenceProviders: %w", err)
	}
	for i := range providers.Items {
		providers.Items[i].Spec.CreatorUserID = owner
		if err := add("InferenceProvider", providers.Items[i].Name, providers.Items[i].Spec); err != nil {
			return nil, err
		}
	}
	var mcps agentzv1alpha1.MCPConnectionList
	if err := k8s.List(ctx, &mcps, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list MCPConnections: %w", err)
	}
	for i := range mcps.Items {
		item := &mcps.Items[i]
		item.Spec.CreatorUserID = owner
		if item.Spec.Auth != nil && item.Spec.Auth.Bearer != nil && item.Spec.Auth.Bearer.SecretRef != nil {
			item.Spec.Auth.Bearer.SecretRef.Path = internalmcp.SecretPath(target, item.Name)
		}
		if item.Spec.Auth != nil && item.Spec.Auth.OAuth != nil && item.Spec.Auth.OAuth.SecretRef != nil {
			item.Spec.Auth.OAuth.SecretRef.Path = internalmcp.SecretPath(target, item.Name)
		}
		if err := add("MCPConnection", item.Name, item.Spec); err != nil {
			return nil, err
		}
	}
	var pools agentzv1alpha1.InferencePoolList
	if err := k8s.List(ctx, &pools, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list InferencePools: %w", err)
	}
	for i := range pools.Items {
		item := &pools.Items[i]
		item.Spec.CreatorUserID = owner
		for j := range item.Spec.Members {
			item.Spec.Members[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if err := add("InferencePool", item.Name, item.Spec); err != nil {
			return nil, err
		}
	}
	var sandboxes agentzv1alpha1.SandboxList
	if err := k8s.List(ctx, &sandboxes, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list Sandboxes: %w", err)
	}
	for i := range sandboxes.Items {
		item := &sandboxes.Items[i]
		item.Spec.CreatorUserID = owner
		for j := range item.Spec.Skills {
			item.Spec.Skills[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		for j := range item.Spec.MCPConnectionRefs {
			item.Spec.MCPConnectionRefs[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		for j := range item.Spec.Inference.Models {
			item.Spec.Inference.Models[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		item.Spec.Inference.DefaultModel.Scope = agentzv1alpha1.ResourceScopeWorkspace
		if item.Spec.Inference.SmallModel != nil {
			item.Spec.Inference.SmallModel.Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if item.Spec.Inference.AttachmentModel != nil {
			item.Spec.Inference.AttachmentModel.Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if err := add("Sandbox", item.Name, item.Spec); err != nil {
			return nil, err
		}
	}
	var agents agentzv1alpha1.AgentList
	if err := k8s.List(ctx, &agents, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list Agents: %w", err)
	}
	for i := range agents.Items {
		item := &agents.Items[i]
		item.Spec.SandboxRef.Scope = agentzv1alpha1.ResourceScopeWorkspace
		for j := range item.Spec.Skills {
			item.Spec.Skills[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if err := add("Agent", item.Name, item.Spec); err != nil {
			return nil, err
		}
	}
	var secrets agentzv1alpha1.SecretList
	if err := k8s.List(ctx, &secrets, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list Secrets: %w", err)
	}
	for i := range secrets.Items {
		if err := add("Secret", secrets.Items[i].Name, secrets.Items[i].Spec); err != nil {
			return nil, err
		}
	}
	var schedules agentzv1alpha1.WorkflowScheduleList
	if err := k8s.List(ctx, &schedules, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list WorkflowSchedules: %w", err)
	}
	for i := range schedules.Items {
		if err := add("WorkflowSchedule", schedules.Items[i].Name, schedules.Items[i].Spec); err != nil {
			return nil, err
		}
	}
	var runs agentzv1alpha1.WorkflowRunList
	if err := k8s.List(ctx, &runs, ctrlclient.InNamespace(source)); err != nil {
		return nil, fmt.Errorf("list WorkflowRuns: %w", err)
	}
	for i := range runs.Items {
		value := struct {
			Spec   agentzv1alpha1.WorkflowRunSpec   `json:"spec"`
			Status agentzv1alpha1.WorkflowRunStatus `json:"status"`
		}{Spec: runs.Items[i].Spec, Status: runs.Items[i].Status}
		if err := add("WorkflowRun", runs.Items[i].Name, value); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(objects, func(a, b KubernetesObjectInventory) int {
		return strings.Compare(a.Kind+"\x00"+a.Name, b.Kind+"\x00"+b.Name)
	})
	return objects, nil
}

func inventoryOpenBao(ctx context.Context, kv *baoapi.KVv2, namespace string) ([]ObjectInventory, error) {
	list, err := kv.Scan(ctx, namespace)
	if err != nil {
		var responseErr *baoapi.ResponseError
		if errors.As(err, &responseErr) && responseErr.StatusCode == 404 {
			return []ObjectInventory{}, nil
		}
		return nil, fmt.Errorf("inventory OpenBao prefix %q: %w", namespace, err)
	}
	if list == nil {
		return []ObjectInventory{}, nil
	}
	objects := make([]ObjectInventory, 0, len(list.Keys))
	for _, key := range list.Keys {
		path := namespace + "/" + strings.TrimPrefix(key, "/")
		secret, err := kv.Get(ctx, path)
		if err != nil {
			return nil, fmt.Errorf("read OpenBao path %q: %w", path, err)
		}
		raw, err := json.Marshal(secret.Data)
		if err != nil {
			return nil, fmt.Errorf("hash OpenBao path %q: %w", path, err)
		}
		sum := sha256.Sum256(raw)
		objects = append(objects, ObjectInventory{
			Path: strings.TrimPrefix(key, "/"), SHA256: hex.EncodeToString(sum[:]),
		})
	}
	slices.SortFunc(objects, func(a, b ObjectInventory) int { return strings.Compare(a.Path, b.Path) })
	return objects, nil
}

func inventoryS3(ctx context.Context, client *s3.Client, bucket, namespace string) ([]ObjectInventory, error) {
	prefix := namespace + "/"
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket), Prefix: aws.String(prefix),
	})
	objects := []ObjectInventory{}
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list S3 prefix %q: %w", prefix, err)
		}
		for _, object := range page.Contents {
			if object.Key == nil || strings.HasSuffix(*object.Key, "/") {
				continue
			}
			result, err := client.GetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String(bucket), Key: object.Key,
			})
			if err != nil {
				return nil, fmt.Errorf("read S3 object %q: %w", *object.Key, err)
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, result.Body)
			closeErr := result.Body.Close()
			if err := errors.Join(copyErr, closeErr); err != nil {
				return nil, fmt.Errorf("hash S3 object %q: %w", *object.Key, err)
			}
			objects = append(objects, ObjectInventory{
				Path: strings.TrimPrefix(*object.Key, prefix),
				Size: aws.ToInt64(object.Size), SHA256: hex.EncodeToString(hash.Sum(nil)),
			})
		}
	}
	slices.SortFunc(objects, func(a, b ObjectInventory) int { return strings.Compare(a.Path, b.Path) })
	return objects, nil
}

func inventoryHash(inventory TenantInventory) (string, error) {
	inventory.Hash = ""
	inventory.Checkpoint = ""
	raw, err := json.Marshal(inventory)
	if err != nil {
		return "", fmt.Errorf("marshal inventory: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func commitTenant(ctx context.Context, cfg Config, clients stores, backupHash string, inventory TenantInventory) (TenantInventory, error) {
	state, err := clients.db.GetState(ctx, inventory.Organization.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := createPlan(ctx, clients.pool, inventory, backupHash); err != nil {
			return inventory, err
		}
		state, err = clients.db.GetState(ctx, inventory.Organization.ID)
	}
	if err != nil {
		return inventory, fmt.Errorf("get cutover state: %w", err)
	}
	if state.InventoryHash != inventory.Hash || state.BackupManifestHash != backupHash {
		return inventory, errors.New("durable cutover plan differs from current inventory or backup manifest")
	}
	inventory.Checkpoint = state.Checkpoint
	if state.Checkpoint == checkpointActivated {
		return inventory, nil
	}
	if state.Checkpoint == checkpointPlanned {
		if err := copyOpenBao(ctx, clients.bao, inventory); err != nil {
			return inventory, err
		}
		if err := advance(ctx, clients.db, inventory, backupHash, checkpointPlanned, checkpointOpenBao); err != nil {
			return inventory, err
		}
		inventory.Checkpoint = checkpointOpenBao
	}
	if inventory.Checkpoint == checkpointOpenBao {
		if err := copyS3(ctx, clients.s3, cfg.S3Bucket, inventory); err != nil {
			return inventory, err
		}
		if err := advance(ctx, clients.db, inventory, backupHash, checkpointOpenBao, checkpointS3); err != nil {
			return inventory, err
		}
		inventory.Checkpoint = checkpointS3
	}
	if inventory.Checkpoint == checkpointS3 {
		if err := copyKubernetes(ctx, cfg, clients.k8s, inventory); err != nil {
			return inventory, err
		}
		if err := advance(ctx, clients.db, inventory, backupHash, checkpointS3, checkpointKubernetes); err != nil {
			return inventory, err
		}
		inventory.Checkpoint = checkpointKubernetes
	}
	if inventory.Checkpoint == checkpointKubernetes {
		if err := verifyExternalStores(ctx, cfg, clients, inventory); err != nil {
			return inventory, err
		}
		rows, err := clients.db.MarkVerified(ctx, cutoverdb.MarkVerifiedParams{
			OrganizationID:     inventory.Organization.ID,
			InventoryHash:      inventory.Hash,
			BackupManifestHash: backupHash,
		})
		if err != nil || rows != 1 {
			return inventory, fmt.Errorf("mark cutover verified: rows=%d: %w", rows, err)
		}
		inventory.Checkpoint = checkpointVerified
	}
	if inventory.Checkpoint == checkpointVerified {
		if err := activateSQL(ctx, clients.pool, inventory, backupHash); err != nil {
			return inventory, err
		}
		inventory.Checkpoint = checkpointSQL
	}
	if inventory.Checkpoint == checkpointSQL {
		if err := deleteLegacyExternalState(ctx, cfg, clients, inventory); err != nil {
			return inventory, err
		}
		if err := finishCutover(ctx, clients.pool, inventory, backupHash); err != nil {
			return inventory, err
		}
		inventory.Checkpoint = checkpointActivated
	}
	return inventory, nil
}

func createPlan(ctx context.Context, pool *pgxpool.Pool, inventory TenantInventory, backupHash string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin cutover plan: %w", err)
	}
	defer tx.Rollback(ctx)
	db := cutoverdb.New(tx)
	if err := db.CreateWorkspace(ctx, cutoverdb.CreateWorkspaceParams{
		ID: inventory.Workspace.ID, OrganizationID: inventory.Organization.ID,
		Slug: inventory.Workspace.Slug, Namespace: inventory.Workspace.TargetNamespace,
	}); err != nil {
		return fmt.Errorf("create Default Workspace plan: %w", err)
	}
	err = db.EnsureSystemRoles(ctx, cutoverdb.EnsureSystemRolesParams{
		OrganizationID: inventory.Organization.ID,
		WorkspaceID:    inventory.Workspace.ID,
		OwnerUserID:    inventory.Organization.MigrationUserID,
	})
	if err != nil {
		return fmt.Errorf("assign cutover system roles: %w", err)
	}
	raw, err := json.Marshal(inventory)
	if err != nil {
		return fmt.Errorf("marshal durable inventory: %w", err)
	}
	if err := db.CreateState(ctx, cutoverdb.CreateStateParams{
		OrganizationID:     inventory.Organization.ID,
		SourceNamespace:    inventory.Workspace.SourceNamespace,
		WorkspaceID:        inventory.Workspace.ID,
		TargetNamespace:    inventory.Workspace.TargetNamespace,
		OwnerUserID:        inventory.Organization.MigrationUserID,
		InventoryHash:      inventory.Hash,
		BackupManifestHash: backupHash,
		Inventory:          raw,
	}); err != nil {
		return fmt.Errorf("create durable cutover plan: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cutover plan: %w", err)
	}
	return nil
}

func advance(ctx context.Context, db *cutoverdb.Queries, inventory TenantInventory, backupHash, expected, next string) error {
	rows, err := db.SetCheckpoint(ctx, cutoverdb.SetCheckpointParams{
		NextCheckpoint: next, OrganizationID: inventory.Organization.ID,
		ExpectedCheckpoint: expected, InventoryHash: inventory.Hash,
		BackupManifestHash: backupHash,
	})
	if err != nil || rows != 1 {
		return fmt.Errorf("advance cutover from %s to %s: rows=%d: %w", expected, next, rows, err)
	}
	return nil
}

func copyOpenBao(ctx context.Context, kv *baoapi.KVv2, inventory TenantInventory) error {
	for _, object := range inventory.OpenBao {
		source := inventory.Workspace.SourceNamespace + "/" + object.Path
		target := inventory.Workspace.TargetNamespace + "/" + object.Path
		secret, err := kv.Get(ctx, source)
		if err != nil {
			return fmt.Errorf("read OpenBao path %q: %w", source, err)
		}
		if _, err := kv.Put(ctx, target, secret.Data); err != nil {
			return fmt.Errorf("copy OpenBao path %q: %w", target, err)
		}
	}
	return nil
}

func copyS3(ctx context.Context, client *s3.Client, bucket string, inventory TenantInventory) error {
	for _, object := range inventory.S3 {
		source := inventory.Workspace.SourceNamespace + "/" + object.Path
		target := inventory.Workspace.TargetNamespace + "/" + object.Path
		_, err := client.CopyObject(ctx, &s3.CopyObjectInput{
			Bucket:     aws.String(bucket),
			CopySource: aws.String(url.PathEscape(bucket + "/" + source)),
			Key:        aws.String(target),
		})
		if err != nil {
			return fmt.Errorf("copy S3 object %q: %w", source, err)
		}
	}
	return nil
}

func copyKubernetes(ctx context.Context, cfg Config, k8s ctrlclient.Client, inventory TenantInventory) error {
	tenant := &agentzv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{Name: inventory.Workspace.OrganizationTenantName},
		Spec: agentzv1alpha1.TenantSpec{
			OrganizationID: inventory.Organization.ID,
		},
	}
	if err := k8s.Create(ctx, tenant); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("create Organisation Tenant: %w", err)
	}
	tenantDeadline := time.Now().Add(cfg.WorkspaceTimeout)
	for {
		if err := k8s.Get(ctx, ctrlclient.ObjectKey{Name: tenant.Name}, tenant); err != nil {
			return fmt.Errorf("get Organisation Tenant: %w", err)
		}
		if tenant.Spec.OrganizationID != inventory.Organization.ID {
			return errors.New("Organisation Tenant identity conflicts with the cutover plan")
		}
		ready := apimeta.FindStatusCondition(
			tenant.Status.Conditions,
			agentzv1alpha1.TenantConditionReady,
		)
		if ready != nil && ready.Status == metav1.ConditionTrue &&
			ready.ObservedGeneration == tenant.Generation &&
			tenant.Status.ObservedGeneration == tenant.Generation {
			break
		}
		if time.Now().After(tenantDeadline) {
			return errors.New("timed out waiting for Organisation Tenant readiness")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	workspace := &agentzv1alpha1.Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: inventory.Workspace.TargetNamespace},
		Spec: agentzv1alpha1.WorkspaceSpec{
			WorkspaceID:         inventory.Workspace.ID,
			OrganizationID:      inventory.Organization.ID,
			ProvisioningAttempt: 1,
		},
	}
	if err := k8s.Create(ctx, workspace); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("create Default Workspace resource: %w", err)
	}
	deadline := time.Now().Add(cfg.WorkspaceTimeout)
	for {
		if err := k8s.Get(ctx, ctrlclient.ObjectKey{Name: workspace.Name}, workspace); err != nil {
			return fmt.Errorf("get Default Workspace resource: %w", err)
		}
		if workspace.Status.State == agentzv1alpha1.WorkspaceStateReady {
			break
		}
		if workspace.Status.State == agentzv1alpha1.WorkspaceStateFailed {
			return errors.New("Default Workspace controller reported a failed state")
		}
		if time.Now().After(deadline) {
			return errors.New("timed out waiting for Default Workspace readiness")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	source := inventory.Workspace.SourceNamespace
	target := inventory.Workspace.TargetNamespace
	owner := inventory.Organization.MigrationUserID
	create := func(object ctrlclient.Object) error {
		object.SetNamespace(target)
		object.SetResourceVersion("")
		object.SetUID("")
		object.SetGeneration(0)
		object.SetCreationTimestamp(metav1.Time{})
		object.SetDeletionTimestamp(nil)
		object.SetDeletionGracePeriodSeconds(nil)
		object.SetManagedFields(nil)
		object.SetOwnerReferences(nil)
		object.SetFinalizers(nil)
		if err := k8s.Create(ctx, object); err != nil && !apierrors.IsAlreadyExists(err) {
			return err
		}
		return nil
	}
	var skills agentzv1alpha1.SkillList
	if err := k8s.List(ctx, &skills, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range skills.Items {
		item := skills.Items[i].DeepCopy()
		item.Spec.CreatorUserID = owner
		item.Spec.StoragePath = (skill.Config{Bucket: cfg.S3Bucket}).StoragePath(target, item.Name, item.Spec.Version)
		if err := create(item); err != nil {
			return fmt.Errorf("copy Skill %q: %w", item.Name, err)
		}
	}
	var providers agentzv1alpha1.InferenceProviderList
	if err := k8s.List(ctx, &providers, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range providers.Items {
		item := providers.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.InferenceProviderStatus{}
		item.Spec.CreatorUserID = owner
		if err := create(item); err != nil {
			return fmt.Errorf("copy InferenceProvider %q: %w", item.Name, err)
		}
	}
	var mcps agentzv1alpha1.MCPConnectionList
	if err := k8s.List(ctx, &mcps, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range mcps.Items {
		item := mcps.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.MCPConnectionStatus{}
		item.Spec.CreatorUserID = owner
		if item.Spec.Auth != nil && item.Spec.Auth.Bearer != nil && item.Spec.Auth.Bearer.SecretRef != nil {
			item.Spec.Auth.Bearer.SecretRef.Path = internalmcp.SecretPath(target, item.Name)
		}
		if item.Spec.Auth != nil && item.Spec.Auth.OAuth != nil && item.Spec.Auth.OAuth.SecretRef != nil {
			item.Spec.Auth.OAuth.SecretRef.Path = internalmcp.SecretPath(target, item.Name)
		}
		if err := create(item); err != nil {
			return fmt.Errorf("copy MCPConnection %q: %w", item.Name, err)
		}
	}
	var pools agentzv1alpha1.InferencePoolList
	if err := k8s.List(ctx, &pools, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range pools.Items {
		item := pools.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.InferencePoolStatus{}
		item.Spec.CreatorUserID = owner
		for j := range item.Spec.Members {
			item.Spec.Members[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if err := create(item); err != nil {
			return fmt.Errorf("copy InferencePool %q: %w", item.Name, err)
		}
	}
	var sandboxes agentzv1alpha1.SandboxList
	if err := k8s.List(ctx, &sandboxes, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range sandboxes.Items {
		item := sandboxes.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.SandboxStatus{}
		item.Spec.CreatorUserID = owner
		for j := range item.Spec.Skills {
			item.Spec.Skills[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		for j := range item.Spec.MCPConnectionRefs {
			item.Spec.MCPConnectionRefs[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		for j := range item.Spec.Inference.Models {
			item.Spec.Inference.Models[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		item.Spec.Inference.DefaultModel.Scope = agentzv1alpha1.ResourceScopeWorkspace
		if item.Spec.Inference.SmallModel != nil {
			item.Spec.Inference.SmallModel.Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if item.Spec.Inference.AttachmentModel != nil {
			item.Spec.Inference.AttachmentModel.Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if err := create(item); err != nil {
			return fmt.Errorf("copy Sandbox %q: %w", item.Name, err)
		}
	}
	var agents agentzv1alpha1.AgentList
	if err := k8s.List(ctx, &agents, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range agents.Items {
		item := agents.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.AgentStatus{}
		item.Spec.SandboxRef.Scope = agentzv1alpha1.ResourceScopeWorkspace
		for j := range item.Spec.Skills {
			item.Spec.Skills[j].Scope = agentzv1alpha1.ResourceScopeWorkspace
		}
		if err := create(item); err != nil {
			return fmt.Errorf("copy Agent %q: %w", item.Name, err)
		}
	}
	var secrets agentzv1alpha1.SecretList
	if err := k8s.List(ctx, &secrets, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range secrets.Items {
		item := secrets.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.SecretStatus{}
		if err := create(item); err != nil {
			return fmt.Errorf("copy Secret %q: %w", item.Name, err)
		}
	}
	var schedules agentzv1alpha1.WorkflowScheduleList
	if err := k8s.List(ctx, &schedules, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range schedules.Items {
		item := schedules.Items[i].DeepCopy()
		item.Status = agentzv1alpha1.WorkflowScheduleStatus{}
		if err := create(item); err != nil {
			return fmt.Errorf("copy WorkflowSchedule %q: %w", item.Name, err)
		}
	}
	var runs agentzv1alpha1.WorkflowRunList
	if err := k8s.List(ctx, &runs, ctrlclient.InNamespace(source)); err != nil {
		return err
	}
	for i := range runs.Items {
		item := runs.Items[i].DeepCopy()
		status := item.Status
		item.Status = agentzv1alpha1.WorkflowRunStatus{}
		if err := create(item); err != nil {
			return fmt.Errorf("copy WorkflowRun %q: %w", item.Name, err)
		}
		created := &agentzv1alpha1.WorkflowRun{}
		if err := k8s.Get(ctx, ctrlclient.ObjectKey{Namespace: target, Name: item.Name}, created); err != nil {
			return fmt.Errorf("get copied WorkflowRun %q: %w", item.Name, err)
		}
		created.Status = status
		if err := k8s.Status().Update(ctx, created); err != nil && !apierrors.IsConflict(err) {
			return fmt.Errorf("restore WorkflowRun %q status: %w", item.Name, err)
		}
	}
	return nil
}

func verifyExternalStores(ctx context.Context, cfg Config, clients stores, inventory TenantInventory) error {
	openBao, err := inventoryOpenBao(ctx, clients.bao, inventory.Workspace.TargetNamespace)
	if err != nil {
		return err
	}
	if !slices.Equal(openBao, inventory.OpenBao) {
		return errors.New("OpenBao target inventory does not match the verified source inventory")
	}
	s3Objects, err := inventoryS3(ctx, clients.s3, cfg.S3Bucket, inventory.Workspace.TargetNamespace)
	if err != nil {
		return err
	}
	if !slices.Equal(s3Objects, inventory.S3) {
		return errors.New("S3 target inventory does not match the verified source inventory")
	}
	kubernetes, err := inventoryKubernetes(
		ctx,
		cfg,
		clients.k8s,
		inventory.Workspace.TargetNamespace,
		inventory.Workspace.TargetNamespace,
		inventory.Organization.MigrationUserID,
	)
	if err != nil {
		return err
	}
	if !slices.EqualFunc(
		kubernetes.Objects,
		inventory.Kubernetes.Objects,
		func(a, b KubernetesObjectInventory) bool {
			return a.Kind == b.Kind && a.Name == b.Name && a.SHA256 == b.SHA256
		},
	) {
		return errors.New("Kubernetes target object inventory does not match the transformed source inventory")
	}
	if !slices.Equal(kubernetes.PVCs, inventory.Kubernetes.PVCs) {
		return errors.New("Kubernetes target PVC inventory does not match the source inventory")
	}
	var policy ciliumv2.CiliumNetworkPolicy
	if err := clients.k8s.Get(ctx, ctrlclient.ObjectKey{
		Namespace: inventory.Workspace.TargetNamespace,
		Name:      agentzv1alpha1.WorkspaceIsolationPolicyName,
	}, &policy); err != nil {
		return fmt.Errorf("verify Workspace network policy: %w", err)
	}
	var workspace agentzv1alpha1.Workspace
	if err := clients.k8s.Get(ctx, ctrlclient.ObjectKey{Name: inventory.Workspace.TargetNamespace}, &workspace); err != nil {
		return fmt.Errorf("verify Workspace controller state: %w", err)
	}
	if workspace.Status.State != agentzv1alpha1.WorkspaceStateReady ||
		workspace.Status.ObservedGeneration != workspace.Generation {
		return errors.New("Workspace controller has not verified the current generation")
	}
	return nil
}

func activateSQL(ctx context.Context, pool *pgxpool.Pool, inventory TenantInventory, backupHash string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin SQL activation: %w", err)
	}
	defer tx.Rollback(ctx)
	db := cutoverdb.New(tx)
	current, err := db.CountNamespaceRows(ctx, inventory.Workspace.SourceNamespace)
	if err != nil {
		return fmt.Errorf("recount source SQL rows: %w", err)
	}
	if current != inventory.PostgreSQL.Counts {
		return errors.New("PostgreSQL source changed after inventory")
	}
	args := cutoverdb.CopyAgentsParams{
		SourceNamespace: inventory.Workspace.SourceNamespace,
		TargetNamespace: inventory.Workspace.TargetNamespace,
	}
	if _, err := db.CopyAgents(ctx, args); err != nil {
		return fmt.Errorf("copy Agent SQL roots: %w", err)
	}
	workflowArgs := cutoverdb.CopyWorkflowsParams(args)
	if _, err := db.CopyWorkflows(ctx, workflowArgs); err != nil {
		return fmt.Errorf("copy Workflows: %w", err)
	}
	if _, err := db.CopyWorkflowNodes(ctx, cutoverdb.CopyWorkflowNodesParams(args)); err != nil {
		return fmt.Errorf("copy Workflow nodes: %w", err)
	}
	if _, err := db.CopyWorkflowTools(ctx, cutoverdb.CopyWorkflowToolsParams(args)); err != nil {
		return fmt.Errorf("copy Workflow tools: %w", err)
	}
	if _, err := db.CopyWorkflowSkills(ctx, cutoverdb.CopyWorkflowSkillsParams(args)); err != nil {
		return fmt.Errorf("copy Workflow Skills: %w", err)
	}
	if _, err := db.CopyWorkflowEdges(ctx, cutoverdb.CopyWorkflowEdgesParams(args)); err != nil {
		return fmt.Errorf("copy Workflow edges: %w", err)
	}
	move := cutoverdb.MoveProcessEventsParams(args)
	if _, err := db.MoveProcessEvents(ctx, move); err != nil {
		return fmt.Errorf("move process telemetry: %w", err)
	}
	if _, err := db.MoveFileEvents(ctx, cutoverdb.MoveFileEventsParams(args)); err != nil {
		return fmt.Errorf("move file telemetry: %w", err)
	}
	if _, err := db.MoveNetworkEvents(ctx, cutoverdb.MoveNetworkEventsParams(args)); err != nil {
		return fmt.Errorf("move network telemetry: %w", err)
	}
	if _, err := db.MoveTraces(ctx, cutoverdb.MoveTracesParams(args)); err != nil {
		return fmt.Errorf("move traces: %w", err)
	}
	if _, err := db.MoveTraceSessions(ctx, cutoverdb.MoveTraceSessionsParams(args)); err != nil {
		return fmt.Errorf("move trace sessions: %w", err)
	}
	if _, err := db.MoveTraceSpans(ctx, cutoverdb.MoveTraceSpansParams(args)); err != nil {
		return fmt.Errorf("move trace spans: %w", err)
	}
	if _, err := db.MoveMCPInvocations(ctx, cutoverdb.MoveMCPInvocationsParams(args)); err != nil {
		return fmt.Errorf("move MCP invocations: %w", err)
	}
	if _, err := db.MoveMCPLastCalled(ctx, cutoverdb.MoveMCPLastCalledParams(args)); err != nil {
		return fmt.Errorf("move MCP recency: %w", err)
	}
	if _, err := db.EnsureAgentOwners(ctx, cutoverdb.EnsureAgentOwnersParams{
		OrganizationID:  inventory.Organization.ID,
		WorkspaceID:     inventory.Workspace.ID,
		OwnerUserID:     inventory.Organization.MigrationUserID,
		TargetNamespace: inventory.Workspace.TargetNamespace,
	}); err != nil {
		return fmt.Errorf("assign Agent owners: %w", err)
	}
	_, err = db.SetDefaultWorkspaceContexts(ctx, cutoverdb.SetDefaultWorkspaceContextsParams{
		OrganizationID: inventory.Organization.ID,
		WorkspaceID:    pgtype.Text{String: inventory.Workspace.ID, Valid: true},
		Route: fmt.Sprintf(
			"/orgs/%s/workspaces/%s",
			inventory.Organization.Slug,
			inventory.Workspace.Slug,
		),
	})
	if err != nil {
		return fmt.Errorf("set Default Workspace navigation contexts: %w", err)
	}
	for _, key := range inventory.PostgreSQL.APIKeys {
		rows, err := db.EnsureAPIKeyScope(ctx, cutoverdb.EnsureAPIKeyScopeParams{
			OrganizationID: inventory.Organization.ID,
			WorkspaceID:    inventory.Workspace.ID,
			OwnerUserID:    inventory.Organization.MigrationUserID,
			ApiKeyID:       key.ID,
		})
		if err != nil || rows != 1 {
			return fmt.Errorf("scope API key %q: rows=%d: %w", key.ID, rows, err)
		}
		for _, target := range key.Targets {
			rows, err := db.EnsureAPIKeyTarget(ctx, cutoverdb.EnsureAPIKeyTargetParams{
				ApiKeyID:     key.ID,
				TargetType:   cutoverdb.ApiKeyTargetType(target.Type),
				AgentName:    target.AgentName,
				WorkflowName: target.WorkflowName,
			})
			if err != nil || rows != 1 {
				return fmt.Errorf("scope API key %q target: rows=%d: %w", key.ID, rows, err)
			}
		}
		verification, err := db.GetAPIKeyVerification(ctx, key.ID)
		if err != nil {
			return fmt.Errorf("verify API key %q: %w", key.ID, err)
		}
		material := sha256.Sum256([]byte(verification.Key))
		if hex.EncodeToString(material[:]) != key.MaterialHash ||
			verification.ReferenceID != inventory.Organization.ID ||
			!verification.Enabled.Valid || verification.Enabled.Bool != key.Enabled ||
			verification.WorkspaceID != inventory.Workspace.ID ||
			verification.CreatorUserID != inventory.Organization.MigrationUserID ||
			verification.TargetCount != int32(len(key.Targets)) {
			return fmt.Errorf("API key %q verification differs from the cutover inventory", key.ID)
		}
	}
	target, err := db.CountNamespaceRows(ctx, inventory.Workspace.TargetNamespace)
	if err != nil {
		return fmt.Errorf("verify target SQL rows: %w", err)
	}
	if target != inventory.PostgreSQL.Counts {
		return errors.New("PostgreSQL target counts differ from source inventory")
	}
	if _, err := db.DeleteSourceWorkflows(ctx, inventory.Workspace.SourceNamespace); err != nil {
		return fmt.Errorf("delete source Workflows: %w", err)
	}
	if _, err := db.DeleteSourceAgents(ctx, inventory.Workspace.SourceNamespace); err != nil {
		return fmt.Errorf("delete source Agents: %w", err)
	}
	rows, err := db.SetCheckpoint(ctx, cutoverdb.SetCheckpointParams{
		NextCheckpoint:     checkpointSQL,
		OrganizationID:     inventory.Organization.ID,
		ExpectedCheckpoint: checkpointVerified,
		InventoryHash:      inventory.Hash,
		BackupManifestHash: backupHash,
	})
	if err != nil || rows != 1 {
		return fmt.Errorf("checkpoint SQL activation: rows=%d: %w", rows, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit SQL activation: %w", err)
	}
	return nil
}

func finishCutover(ctx context.Context, pool *pgxpool.Pool, inventory TenantInventory, backupHash string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin cutover finalization: %w", err)
	}
	defer tx.Rollback(ctx)
	db := cutoverdb.New(tx)
	rows, err := db.MarkActivated(ctx, cutoverdb.MarkActivatedParams{
		OrganizationID:     inventory.Organization.ID,
		InventoryHash:      inventory.Hash,
		BackupManifestHash: backupHash,
	})
	if err != nil || rows != 1 {
		return fmt.Errorf("mark cutover activated: rows=%d: %w", rows, err)
	}
	after, err := json.Marshal([]map[string]string{
		{"field": "state", "value": "Default Workspace activated; legacy Tenant removed"},
	})
	if err != nil {
		return fmt.Errorf("marshal cutover audit: %w", err)
	}
	if err := db.CreateAuditEvent(ctx, cutoverdb.CreateAuditEventParams{
		ID:             "audit-" + uuid.NewString(),
		OrganizationID: inventory.Organization.ID,
		WorkspaceID:    pgtype.Text{String: inventory.Workspace.ID, Valid: true},
		After:          after,
	}); err != nil {
		return fmt.Errorf("record cutover audit: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cutover finalization: %w", err)
	}
	return nil
}

func deleteLegacyExternalState(ctx context.Context, cfg Config, clients stores, inventory TenantInventory) error {
	for _, object := range inventory.OpenBao {
		path := inventory.Workspace.SourceNamespace + "/" + object.Path
		if err := clients.bao.DeleteMetadata(ctx, path); err != nil {
			return fmt.Errorf("delete source OpenBao path %q: %w", path, err)
		}
	}
	objects := make([]types.ObjectIdentifier, 0, len(inventory.S3))
	for _, object := range inventory.S3 {
		objects = append(objects, types.ObjectIdentifier{
			Key: aws.String(inventory.Workspace.SourceNamespace + "/" + object.Path),
		})
	}
	for len(objects) > 0 {
		end := min(len(objects), 1000)
		result, err := clients.s3.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(cfg.S3Bucket),
			Delete: &types.Delete{Objects: objects[:end], Quiet: aws.Bool(true)},
		})
		if err != nil {
			return fmt.Errorf("delete source S3 objects: %w", err)
		}
		if len(result.Errors) > 0 {
			return fmt.Errorf(
				"delete source S3 object %q: %s",
				aws.ToString(result.Errors[0].Key),
				aws.ToString(result.Errors[0].Message),
			)
		}
		objects = objects[end:]
	}
	var tenant agentzv1alpha1.Tenant
	err := clients.k8s.Get(ctx, ctrlclient.ObjectKey{
		Name: inventory.Workspace.SourceTenantName,
	}, &tenant)
	if err == nil && tenant.Name != inventory.Workspace.OrganizationTenantName {
		if err := clients.k8s.Delete(ctx, &tenant); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete source Tenant: %w", err)
		}
	} else if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("get source Tenant for deletion: %w", err)
	}
	if inventory.Workspace.SourceNamespace == inventory.Workspace.OrganizationTenantName {
		namespace := ctrlclient.InNamespace(inventory.Workspace.SourceNamespace)
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.Skill{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source Skills: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.InferenceProvider{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source InferenceProviders: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.MCPConnection{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source MCPConnections: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.InferencePool{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source InferencePools: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.Sandbox{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source Sandboxes: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.Agent{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source Agents: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.Secret{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source Secrets: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.WorkflowSchedule{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source WorkflowSchedules: %w", err)
		}
		if err := clients.k8s.DeleteAllOf(ctx, &agentzv1alpha1.WorkflowRun{}, namespace); err != nil {
			return fmt.Errorf("delete migrated source WorkflowRuns: %w", err)
		}
		return nil
	}
	var namespace corev1.Namespace
	err = clients.k8s.Get(ctx, ctrlclient.ObjectKey{Name: inventory.Workspace.SourceNamespace}, &namespace)
	if err == nil {
		if err := clients.k8s.Delete(ctx, &namespace); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete source Namespace: %w", err)
		}
	} else if !apierrors.IsNotFound(err) {
		return fmt.Errorf("get source Namespace for deletion: %w", err)
	}
	return nil
}
