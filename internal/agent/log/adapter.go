package log

import (
	"fmt"
	"log/slog"
	"os"
)

type slogAdapter struct{}

func newSlogAdapter() *slogAdapter {
	return &slogAdapter{}
}

func (l *slogAdapter) Debug(args ...any) {
	slog.Debug(fmt.Sprint(args...))
}

func (l *slogAdapter) Debugf(format string, args ...any) {
	slog.Debug(format, args...)
}

func (l *slogAdapter) Info(args ...any) {
	slog.Info(fmt.Sprint(args...))
}

func (l *slogAdapter) Infof(format string, args ...any) {
	slog.Info(format, args...)
}

func (l *slogAdapter) Warn(args ...any) {
	slog.Warn(fmt.Sprint(args...))
}

func (l *slogAdapter) Warnf(format string, args ...any) {
	slog.Warn(format, args...)
}

func (l *slogAdapter) Error(args ...any) {
	slog.Error(fmt.Sprint(args...))
}

func (l *slogAdapter) Errorf(format string, args ...any) {
	slog.Error(format, args...)
}

func (l *slogAdapter) Fatal(args ...any) {
	slog.Error(fmt.Sprint(args...))
	os.Exit(1)
}

func (l *slogAdapter) Fatalf(format string, args ...any) {
	slog.Error(format, args...)
	os.Exit(1)
}
