package extauth

import (
	"net/http"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func newMCPHandler() http.Handler {
	server := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "agentz-extauth",
		Version: "v0.0.1",
	}, nil)

	return mcpsdk.NewStreamableHTTPHandler(func(*http.Request) *mcpsdk.Server {
		return server
	}, nil)
}
