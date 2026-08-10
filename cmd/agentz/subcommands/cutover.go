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

package subcommands

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/urfave/cli/v3"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/accuknox/agentz/internal/cutover"
)

// CutoverCmd inventories and migrates legacy Tenants into Default Workspaces.
var CutoverCmd = &cli.Command{
	Name:  "cutover",
	Usage: "Migrate legacy Tenants into Default Workspaces",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:    "postgres-dsn",
			Usage:   "PostgreSQL connection string",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_POSTGRES_DSN"),
		},
		&cli.StringFlag{
			Name:    "kubeconfig",
			Usage:   "Kubernetes client configuration",
			Value:   clientcmd.RecommendedHomeFile,
			Sources: cli.EnvVars("AGENTZ_CUTOVER_KUBECONFIG"),
		},
		&cli.StringFlag{
			Name:    "openbao-address",
			Usage:   "OpenBao API address",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_OPENBAO_ADDRESS"),
		},
		&cli.StringFlag{
			Name:    "openbao-mount",
			Usage:   "OpenBao KV v2 mount path",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_OPENBAO_MOUNT"),
		},
		&cli.StringFlag{
			Name:    "openbao-token",
			Usage:   "OpenBao operator token",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_OPENBAO_TOKEN"),
		},
		&cli.StringFlag{
			Name:    "s3-endpoint",
			Usage:   "S3 API endpoint",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_S3_ENDPOINT"),
		},
		&cli.StringFlag{
			Name:    "s3-region",
			Usage:   "S3 region",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_S3_REGION"),
		},
		&cli.StringFlag{
			Name:    "s3-bucket",
			Usage:   "Immutable Skill bucket",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_S3_BUCKET"),
		},
		&cli.StringFlag{
			Name:    "s3-access-key-id",
			Usage:   "S3 access key ID",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_S3_ACCESS_KEY_ID"),
		},
		&cli.StringFlag{
			Name:    "s3-secret-key",
			Usage:   "S3 secret access key",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_S3_SECRET_KEY"),
		},
		&cli.StringFlag{
			Name:    "backup-manifest",
			Usage:   "Verified all-store backup manifest",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_BACKUP_MANIFEST"),
		},
		&cli.BoolFlag{
			Name:    "maintenance-mode",
			Usage:   "Confirm that all AgentZ writers are stopped",
			Sources: cli.EnvVars("AGENTZ_CUTOVER_MAINTENANCE_MODE"),
		},
		&cli.BoolFlag{
			Name:  "commit",
			Usage: "Apply the reported cutover plan",
		},
		&cli.DurationFlag{
			Name:  "workspace-timeout",
			Usage: "Maximum wait for each Default Workspace",
			Value: 15 * time.Minute,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		report, err := cutover.Run(ctx, cutover.Config{
			PostgresDSN:      c.String("postgres-dsn"),
			Kubeconfig:       c.String("kubeconfig"),
			OpenBaoAddress:   c.String("openbao-address"),
			OpenBaoMountPath: c.String("openbao-mount"),
			OpenBaoToken:     c.String("openbao-token"),
			S3Endpoint:       c.String("s3-endpoint"),
			S3Region:         c.String("s3-region"),
			S3Bucket:         c.String("s3-bucket"),
			S3AccessKeyID:    c.String("s3-access-key-id"),
			S3SecretKey:      c.String("s3-secret-key"),
			BackupManifest:   c.String("backup-manifest"),
			MaintenanceMode:  c.Bool("maintenance-mode"),
			Commit:           c.Bool("commit"),
			WorkspaceTimeout: c.Duration("workspace-timeout"),
		})
		if err != nil {
			return err
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	},
}
