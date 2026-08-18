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

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/gateway/filesystem"
)

// FilesystemCmd serves confined access to an agent workspace.
var FilesystemCmd = &cli.Command{
	Name:     "filesystem",
	Usage:    "Agent workspace filesystem",
	Commands: []*cli.Command{filesystemServeCmd},
}

var filesystemServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the workspace filesystem server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: ":4097",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "root",
			Usage: "Workspace root",
			Value: "/home/agentz",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return filesystem.Serve(
			ctx,
			filesystem.Config{
				Addr: c.String("addr"),
				Root: c.String("root"),
			},
		)
	},
}
