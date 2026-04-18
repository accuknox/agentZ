package log

import (
	"fmt"
	"log/slog"
	"os"
)

type slogAdapter struct{}

func (l *slogAdapter) Debug(args ...any) {
	slog.Debug(fmt.Sprint(args...))
}

func (l *slogAdapter) Debugf(format string, args ...any) {
	slog.Debug(fmt.Sprintf(format, args...))
}

func (l *slogAdapter) Info(args ...any) {
	slog.Info(fmt.Sprint(args...))
}

func (l *slogAdapter) Infof(format string, args ...any) {
	slog.Info(fmt.Sprintf(format, args...))
}

func (l *slogAdapter) Warn(args ...any) {
	slog.Warn(fmt.Sprint(args...))
}

func (l *slogAdapter) Warnf(format string, args ...any) {
	slog.Warn(fmt.Sprintf(format, args...))
}

func (l *slogAdapter) Error(args ...any) {
	slog.Error(fmt.Sprint(args...))
}

func (l *slogAdapter) Errorf(format string, args ...any) {
	slog.Error(fmt.Sprintf(format, args...))
}

func (l *slogAdapter) Fatal(args ...any) {
	slog.Error(fmt.Sprint(args...))
	os.Exit(1)
}

func (l *slogAdapter) Fatalf(format string, args ...any) {
	slog.Error(fmt.Sprintf(format, args...))
	os.Exit(1)
}
