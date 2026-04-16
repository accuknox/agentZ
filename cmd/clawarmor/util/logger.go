package util

import (
	"log/slog"
	"os"
)

func NewLogger(level, format string, withSource bool) *slog.Logger {
	var slogLvl slog.Level
	switch level {
	case "debug":
		slogLvl = slog.LevelDebug
	case "warn":
		slogLvl = slog.LevelWarn
	case "error":
		slogLvl = slog.LevelError
	default:
		slogLvl = slog.LevelInfo
	}

	if format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
			Level:     slogLvl,
			AddSource: withSource,
		}))
	}

	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level:     slogLvl,
		AddSource: withSource,
	}))
}
