package sinjector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

const (
	// PlaceholderPrefix marks an env secret reference in proxied requests.
	PlaceholderPrefix = "clawarmor:resolve:env:"
	maxSecretNameLen  = 128
)

type secretResolver interface {
	resolve(context.Context, string) (string, error)
}

func replacePlaceholders(ctx context.Context, src string, res secretResolver) (string, bool) {
	if !strings.Contains(src, PlaceholderPrefix) {
		return src, false
	}

	var out strings.Builder
	changed := false
	for len(src) > 0 {
		idx := strings.Index(src, PlaceholderPrefix)
		if idx < 0 {
			out.WriteString(src)
			break
		}

		out.WriteString(src[:idx])
		nameStart := idx + len(PlaceholderPrefix)
		if nameStart >= len(src) || !isSecretNameFirstByte(src[nameStart]) {
			slog.WarnContext(ctx, "invalid secret placeholder", slog.String("reason", "bad first byte"))
			out.WriteString(src[idx : idx+len(PlaceholderPrefix)])
			src = src[idx+len(PlaceholderPrefix):]
			continue
		}
		nameEnd := nameStart
		for nameEnd < len(src) && nameEnd-nameStart < maxSecretNameLen {
			if !isSecretNameByte(src[nameEnd]) {
				break
			}
			nameEnd++
		}
		if nameEnd-nameStart == maxSecretNameLen && nameEnd < len(src) && isSecretNameByte(src[nameEnd]) {
			slog.WarnContext(ctx, "secret placeholder name is too long")
			out.WriteString(src[idx : idx+len(PlaceholderPrefix)])
			src = src[idx+len(PlaceholderPrefix):]
			continue
		}
		if nameEnd < len(src) && !isPlaceholderDelimiter(src[nameEnd]) {
			slog.WarnContext(ctx, "invalid secret placeholder delimiter", slog.String("name", src[nameStart:nameEnd]))
			out.WriteString(src[idx : idx+len(PlaceholderPrefix)])
			src = src[idx+len(PlaceholderPrefix):]
			continue
		}

		name := src[nameStart:nameEnd]
		value, err := res.resolve(ctx, name)
		if err != nil {
			slog.WarnContext(ctx, "failed to resolve secret", slog.String("name", name), slog.Any("err", err))
			out.WriteString(src[idx:nameEnd])
			src = src[nameEnd:]
			continue
		}
		if err := validateSecretValue(value); err != nil {
			slog.WarnContext(ctx, "secret value is invalid", slog.String("name", name), slog.Any("err", err))
			out.WriteString(src[idx:nameEnd])
			src = src[nameEnd:]
			continue
		}
		out.WriteString(value)
		changed = true
		src = src[nameEnd:]
	}

	return out.String(), changed
}

func replacePath(ctx context.Context, path string, res secretResolver) (string, bool) {
	if !strings.Contains(path, PlaceholderPrefix) {
		return path, false
	}

	var out strings.Builder
	changed := false
	for len(path) > 0 {
		idx := strings.Index(path, PlaceholderPrefix)
		if idx < 0 {
			out.WriteString(path)
			break
		}

		out.WriteString(path[:idx])
		nameStart := idx + len(PlaceholderPrefix)
		if nameStart >= len(path) || !isSecretNameFirstByte(path[nameStart]) {
			slog.WarnContext(ctx, "invalid secret placeholder in path", slog.String("reason", "bad first byte"))
			out.WriteString(path[idx : idx+len(PlaceholderPrefix)])
			path = path[idx+len(PlaceholderPrefix):]
			continue
		}
		nameEnd := nameStart
		for nameEnd < len(path) && nameEnd-nameStart < maxSecretNameLen {
			if !isSecretNameByte(path[nameEnd]) {
				break
			}
			nameEnd++
		}
		if nameEnd-nameStart == maxSecretNameLen && nameEnd < len(path) && isSecretNameByte(path[nameEnd]) {
			slog.WarnContext(ctx, "secret placeholder name is too long in path")
			out.WriteString(path[idx : idx+len(PlaceholderPrefix)])
			path = path[idx+len(PlaceholderPrefix):]
			continue
		}
		if nameEnd < len(path) && !isPlaceholderDelimiter(path[nameEnd]) {
			slog.WarnContext(ctx, "invalid secret placeholder delimiter in path", slog.String("name", path[nameStart:nameEnd]))
			out.WriteString(path[idx : idx+len(PlaceholderPrefix)])
			path = path[idx+len(PlaceholderPrefix):]
			continue
		}

		name := path[nameStart:nameEnd]
		value, err := res.resolve(ctx, name)
		if err != nil {
			slog.WarnContext(ctx, "failed to resolve path secret", slog.String("name", name), slog.Any("err", err))
			out.WriteString(path[idx:nameEnd])
			path = path[nameEnd:]
			continue
		}
		if err := validateSecretValue(value); err != nil {
			slog.WarnContext(ctx, "secret value is invalid in path", slog.String("name", name), slog.Any("err", err))
			out.WriteString(path[idx:nameEnd])
			path = path[nameEnd:]
			continue
		}
		if err := validatePathSecret(value); err != nil {
			slog.WarnContext(ctx, "secret value is unsafe for url path", slog.String("name", name), slog.Any("err", err))
			out.WriteString(path[idx:nameEnd])
			path = path[nameEnd:]
			continue
		}
		out.WriteString(value)
		changed = true
		path = path[nameEnd:]
	}

	return out.String(), changed
}

func validatePathSecret(value string) error {
	if strings.Contains(value, "..") || strings.ContainsAny(value, "/\\?#") {
		return fmt.Errorf("secret is unsafe for url path")
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] == 0x7f {
			return fmt.Errorf("secret is unsafe for url path")
		}
	}
	return nil
}

func validateSecretValue(value string) error {
	if strings.ContainsAny(value, "\r\n\x00") {
		return errBadSecret
	}
	return nil
}

func isSecretNameFirstByte(b byte) bool {
	return b == '_' || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func isSecretNameByte(b byte) bool {
	return b == '_' ||
		(b >= '0' && b <= '9') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= 'a' && b <= 'z')
}

func isPlaceholderDelimiter(b byte) bool {
	if b <= ' ' {
		return true
	}
	return strings.ContainsRune("\"'`,;:./\\?&=#[]{}()<>", rune(b))
}
