package log

import (
	"sync"

	a2alog "trpc.group/trpc-go/trpc-a2a-go/log"
	agentlog "trpc.group/trpc-go/trpc-agent-go/log"
)

var trpcLoggerOnce sync.Once

func SetupTRPCAgentLogger() {
	trpcLoggerOnce.Do(func() {
		lg := newSlogAdapter()
		agentlog.Default = lg
		agentlog.ContextDefault = lg
		a2alog.Default = lg
	})
}
