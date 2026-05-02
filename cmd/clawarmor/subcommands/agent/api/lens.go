package api

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var listTracesCmd = &cli.Command{
	Name:  "list-traces",
	Usage: "List trace summaries",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		limitFlag("Maximum number of traces to return"),
		pageTokenFlag("Pagination token from a previous list-traces response"),
		&cli.StringFlag{
			Name:   "started-after",
			Usage:  "Inclusive trace start lower bound in RFC3339 format",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.StringFlag{
			Name:   "started-before",
			Usage:  "Inclusive trace start upper bound in RFC3339 format",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredSessionUUID(c)
		if err != nil {
			return err
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		params := gatewayapi.ListTracesParams{
			SessionId: sessionID,
		}
		setLimitAndPageToken(c, &params.Limit, &params.PageToken)
		startedAfter, err := optionalTime(c, "started-after")
		if err != nil {
			return err
		}
		if startedAfter != nil {
			params.StartedAfter = startedAfter
		}
		startedBefore, err := optionalTime(c, "started-before")
		if err != nil {
			return err
		}
		if startedBefore != nil {
			params.StartedBefore = startedBefore
		}

		res, err := client.ListTracesWithResponse(ctx, &params)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}
		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}

var listSpansCmd = &cli.Command{
	Name:  "list-spans",
	Usage: "List spans for a trace",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.StringArg{
			Name:   "trace-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		limitFlag("Maximum number of spans to return"),
		pageTokenFlag("Pagination token from a previous list-spans response"),
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredSessionUUID(c)
		if err != nil {
			return err
		}
		traceID, err := requiredArg(c, "trace-id")
		if err != nil {
			return err
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		params := gatewayapi.ListSpansParams{
			SessionId: sessionID,
			TraceId:   traceID,
		}
		setLimitAndPageToken(c, &params.Limit, &params.PageToken)

		res, err := client.ListSpansWithResponse(ctx, &params)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}
		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}

var getSpanDetailCmd = &cli.Command{
	Name:  "get-span-detail",
	Usage: "Get span detail with correlated observability",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.StringArg{
			Name:   "trace-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.StringArg{
			Name:   "span-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredSessionUUID(c)
		if err != nil {
			return err
		}
		traceID, err := requiredArg(c, "trace-id")
		if err != nil {
			return err
		}
		spanID, err := requiredArg(c, "span-id")
		if err != nil {
			return err
		}
		client, err := newClient(c)
		if err != nil {
			return err
		}

		res, err := client.GetSpanDetailWithResponse(ctx, &gatewayapi.GetSpanDetailParams{
			SessionId: sessionID,
			TraceId:   traceID,
			SpanId:    spanID,
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}
		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}

var listProcessObservabilityCmd = observabilityCmd(
	"list-process-observability",
	"List process observability events",
	func(ctx context.Context, client *gatewayapi.ClientWithResponses, params observabilityParams) ([]byte, bool, error) {
		res, err := client.ListProcessObservabilityWithResponse(ctx, &gatewayapi.ListProcessObservabilityParams{
			SessionId:       params.sessionID,
			Limit:           params.limit,
			PageToken:       params.pageToken,
			EventTimeAfter:  params.eventTimeAfter,
			EventTimeBefore: params.eventTimeBefore,
			Action:          params.action,
		})
		if err != nil {
			return nil, false, err
		}
		return res.Body, res.JSON200 != nil, nil
	},
)

var listFileObservabilityCmd = observabilityCmd(
	"list-file-observability",
	"List file observability events",
	func(ctx context.Context, client *gatewayapi.ClientWithResponses, params observabilityParams) ([]byte, bool, error) {
		res, err := client.ListFileObservabilityWithResponse(ctx, &gatewayapi.ListFileObservabilityParams{
			SessionId:       params.sessionID,
			Limit:           params.limit,
			PageToken:       params.pageToken,
			EventTimeAfter:  params.eventTimeAfter,
			EventTimeBefore: params.eventTimeBefore,
			Action:          params.action,
		})
		if err != nil {
			return nil, false, err
		}
		return res.Body, res.JSON200 != nil, nil
	},
)

var listNetworkObservabilityCmd = observabilityCmd(
	"list-network-observability",
	"List network observability events",
	func(ctx context.Context, client *gatewayapi.ClientWithResponses, params observabilityParams) ([]byte, bool, error) {
		res, err := client.ListNetworkObservabilityWithResponse(ctx, &gatewayapi.ListNetworkObservabilityParams{
			SessionId:       params.sessionID,
			Limit:           params.limit,
			PageToken:       params.pageToken,
			EventTimeAfter:  params.eventTimeAfter,
			EventTimeBefore: params.eventTimeBefore,
			Action:          params.action,
		})
		if err != nil {
			return nil, false, err
		}
		return res.Body, res.JSON200 != nil, nil
	},
)

type observabilityParams struct {
	sessionID       uuid.UUID
	limit           *gatewayapi.LimitQuery
	pageToken       *gatewayapi.PageTokenQuery
	eventTimeAfter  *gatewayapi.EventTimeAfterQuery
	eventTimeBefore *gatewayapi.EventTimeBeforeQuery
	action          *gatewayapi.ActionQuery
}

func observabilityCmd(name string, usage string, call func(context.Context, *gatewayapi.ClientWithResponses, observabilityParams) ([]byte, bool, error)) *cli.Command {
	return &cli.Command{
		Name:  name,
		Usage: usage,
		Arguments: []cli.Argument{
			&cli.StringArg{
				Name:   "session-id",
				Config: cli.StringConfig{TrimSpace: true},
			},
		},
		Flags: []cli.Flag{
			limitFlag("Maximum number of events to return"),
			pageTokenFlag("Pagination token from a previous response"),
			&cli.StringFlag{
				Name:   "event-time-after",
				Usage:  "Inclusive event time lower bound in RFC3339 format",
				Config: cli.StringConfig{TrimSpace: true},
			},
			&cli.StringFlag{
				Name:   "event-time-before",
				Usage:  "Inclusive event time upper bound in RFC3339 format",
				Config: cli.StringConfig{TrimSpace: true},
			},
			&cli.StringFlag{
				Name:   "action",
				Usage:  "Observability action filter: Allowed or Blocked",
				Config: cli.StringConfig{TrimSpace: true},
			},
		},
		Action: func(ctx context.Context, c *cli.Command) error {
			params, err := readObservabilityParams(c)
			if err != nil {
				return err
			}
			client, err := newClient(c)
			if err != nil {
				return err
			}
			body, ok, err := call(ctx, client, params)
			if err != nil {
				return writeAPIExit(c, "gateway_request_failed", err.Error())
			}
			return writeGatewayBody(c, body, ok)
		},
	}
}

func readObservabilityParams(c *cli.Command) (observabilityParams, error) {
	sessionID, err := requiredSessionUUID(c)
	if err != nil {
		return observabilityParams{}, err
	}
	params := observabilityParams{
		sessionID: sessionID,
	}
	setLimitAndPageToken(c, &params.limit, &params.pageToken)
	eventTimeAfter, err := optionalTime(c, "event-time-after")
	if err != nil {
		return observabilityParams{}, err
	}
	params.eventTimeAfter = eventTimeAfter
	eventTimeBefore, err := optionalTime(c, "event-time-before")
	if err != nil {
		return observabilityParams{}, err
	}
	params.eventTimeBefore = eventTimeBefore
	if c.String("action") != "" {
		action := gatewayapi.ActionQuery(c.String("action"))
		params.action = &action
	}
	return params, nil
}

func limitFlag(usage string) cli.Flag {
	return &cli.IntFlag{
		Name:  "limit",
		Usage: usage,
		Value: 50,
	}
}

func pageTokenFlag(usage string) cli.Flag {
	return &cli.StringFlag{
		Name:   "page-token",
		Usage:  usage,
		Config: cli.StringConfig{TrimSpace: true},
	}
}

func setLimitAndPageToken(c *cli.Command, limit **gatewayapi.LimitQuery, pageToken **gatewayapi.PageTokenQuery) {
	if c.Int("limit") != 0 {
		val := gatewayapi.LimitQuery(c.Int("limit"))
		*limit = &val
	}
	if c.String("page-token") != "" {
		//nolint:unconvert
		val := gatewayapi.PageTokenQuery(c.String("page-token"))
		*pageToken = &val
	}
}

func requiredSessionUUID(c *cli.Command) (uuid.UUID, error) {
	sessionID, err := requiredArg(c, "session-id")
	if err != nil {
		return uuid.Nil, err
	}
	id, err := uuid.Parse(sessionID)
	if err != nil {
		return uuid.Nil, writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
	}
	return id, nil
}

func optionalTime(c *cli.Command, name string) (*time.Time, error) {
	raw := c.String(name)
	if raw == "" {
		return nil, nil
	}
	val, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return nil, writeAPIExit(c, "invalid_argument", name+" must be RFC3339")
	}
	return &val, nil
}
