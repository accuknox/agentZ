package api

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

type silentExitError struct {
	code int
}

func (e silentExitError) Error() string {
	return ""
}

func (e silentExitError) ExitCode() int {
	return e.code
}

func (e silentExitError) Silent() bool {
	return true
}

func apiExit(code int) error {
	return silentExitError{code: code}
}

func newClient(c *cli.Command) (*gatewayapi.ClientWithResponses, error) {
	client, err := gatewayapi.NewClientWithResponses(c.String("base-url"))
	if err != nil {
		return nil, writeAPIExit(c, "invalid_base_url", err.Error())
	}
	return client, nil
}

func writer(c *cli.Command) io.Writer {
	if c.Root().Writer != nil {
		return c.Root().Writer
	}
	return os.Stdout
}

func requiredArg(c *cli.Command, name string) (string, error) {
	val := c.StringArg(name)
	if val != "" {
		return val, nil
	}
	return "", writeAPIExit(c, "invalid_argument", name+" is required")
}

func writeRawJSON(w io.Writer, body []byte) error {
	if _, err := w.Write(body); err != nil {
		return err
	}
	if len(body) == 0 || body[len(body)-1] == '\n' {
		return nil
	}
	_, err := fmt.Fprintln(w)
	return err
}

func writeAPIError(w io.Writer, code string, message string) error {
	return json.NewEncoder(w).Encode(gatewayapi.Error{
		Code:    code,
		Message: message,
	})
}

func writeAPIExit(c *cli.Command, code string, message string) error {
	if err := writeAPIError(writer(c), code, message); err != nil {
		return err
	}
	return apiExit(1)
}

func writeGatewayBody(c *cli.Command, body []byte, ok bool) error {
	if err := writeRawJSON(writer(c), body); err != nil {
		return err
	}
	if ok {
		return nil
	}
	return apiExit(1)
}
