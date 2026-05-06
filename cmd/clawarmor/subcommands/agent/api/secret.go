package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var secretCmd = &cli.Command{
	Name:  "secret",
	Usage: "Manage session secrets",
	Commands: []*cli.Command{
		secretListCmd,
		secretPutCmd,
		secretDeleteCmd,
	},
}

var secretListCmd = &cli.Command{
	Name:    "list",
	Aliases: []string{"ls"},
	Usage:   "List secret keys for a session",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		&cli.IntFlag{
			Name:  "limit",
			Usage: "Maximum number of secrets to return",
			Value: 50,
		},
		&cli.StringFlag{
			Name:   "page-token",
			Usage:  "Pagination token from a previous list response",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredArg(c, "session-id")
		if err != nil {
			return err
		}

		id, err := uuid.Parse(sessionID)
		if err != nil {
			return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		params := gatewayapi.ListSecretsParams{}
		if c.Int("limit") != 0 {
			limit := gatewayapi.LimitQuery(c.Int("limit"))
			params.Limit = &limit
		}

		if c.String("page-token") != "" {
			//nolint:unconvert
			pageToken := gatewayapi.PageTokenQuery(c.String("page-token"))
			params.PageToken = &pageToken
		}

		res, err := client.ListSecretsWithResponse(ctx, id, &params)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}

var secretPutCmd = &cli.Command{
	Name:  "put",
	Usage: "Store or overwrite secrets for a session",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		&cli.StringSliceFlag{
			Name:     "secret",
			Usage:    "Secret as key=value; may be repeated",
			Required: true,
			Config:   cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredArg(c, "session-id")
		if err != nil {
			return err
		}

		id, err := uuid.Parse(sessionID)
		if err != nil {
			return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		rawSecrets := c.StringSlice("secret")
		secrets := make([]gatewayapi.SecretEntry, 0, len(rawSecrets))
		for _, raw := range rawSecrets {
			key, value, ok := strings.Cut(raw, "=")
			if !ok {
				return writeAPIExit(c, "invalid_argument", "secret must be in key=value format")
			}
			secrets = append(secrets, gatewayapi.SecretEntry{
				Key:   key,
				Value: value,
			})
		}

		res, err := client.PutSecretWithResponse(ctx, id, gatewayapi.PutSecretsRequest{
			Secrets: secrets,
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON201 != nil)
	},
}

var secretDeleteCmd = &cli.Command{
	Name:  "delete",
	Usage: "Delete secrets for a session",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		&cli.StringSliceFlag{
			Name:     "key",
			Usage:    "Secret key to delete; may be repeated",
			Required: true,
			Config:   cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredArg(c, "session-id")
		if err != nil {
			return err
		}

		id, err := uuid.Parse(sessionID)
		if err != nil {
			return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		keys := c.StringSlice("key")
		if len(keys) == 0 {
			return writeAPIExit(c, "invalid_argument", "at least one key is required")
		}

		res, err := client.DeleteSecretWithResponse(ctx, id, gatewayapi.DeleteSecretsRequest{
			Keys: keys,
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.StatusCode() == 204)
	},
}
