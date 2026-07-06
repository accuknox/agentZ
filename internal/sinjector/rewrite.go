package sinjector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

const (
	// PlaceholderPrefix marks an env secret reference in proxied requests.
	PlaceholderPrefix = "agentz:resolve:env:"
	maxSecretNameLen  = 128
)

type secretResolver interface {
	resolve(context.Context, string) (resolvedSecret, error)
}

type resolvedSecret struct {
	value string
	hosts []string
}

type placeholderOptions struct {
	context string
	path    bool
}

func replacePlaceholders(ctx context.Context, src string, res secretResolver, target string) (string, bool) {
	return replaceSecretRefs(ctx, src, res, target, placeholderOptions{})
}

func replacePath(ctx context.Context, path string, res secretResolver, target string) (string, bool) {
	return replaceSecretRefs(ctx, path, res, target, placeholderOptions{
		context: " in path",
		path:    true,
	})
}

func replaceSecretRefs(ctx context.Context, src string, res secretResolver, target string, opts placeholderOptions) (string, bool) {
	if !strings.Contains(src, PlaceholderPrefix) {
		return src, false
	}

	var out strings.Builder
	var changed bool
	for len(src) > 0 {
		idx := strings.Index(src, PlaceholderPrefix)
		if idx < 0 {
			out.WriteString(src)
			break
		}

		out.WriteString(src[:idx])
		nameStart := idx + len(PlaceholderPrefix)
		if nameStart >= len(src) || !isSecretNameFirstByte(src[nameStart]) {
			slog.WarnContext(ctx, "invalid secret placeholder"+opts.context, slog.String("reason", "bad first byte"))
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
			slog.WarnContext(ctx, "secret placeholder name is too long"+opts.context)
			out.WriteString(src[idx : idx+len(PlaceholderPrefix)])
			src = src[idx+len(PlaceholderPrefix):]
			continue
		}
		if nameEnd < len(src) && !isPlaceholderDelimiter(src[nameEnd]) {
			slog.WarnContext(ctx, "invalid secret placeholder delimiter"+opts.context, slog.String("name", src[nameStart:nameEnd]))
			out.WriteString(src[idx : idx+len(PlaceholderPrefix)])
			src = src[idx+len(PlaceholderPrefix):]
			continue
		}

		name := src[nameStart:nameEnd]
		secret, err := res.resolve(ctx, name)
		if err != nil {
			slog.WarnContext(ctx, "failed to resolve secret"+opts.context, slog.String("name", name), slog.Any("err", err))
			out.WriteString(src[idx:nameEnd])
			src = src[nameEnd:]
			continue
		}
		if !SecretHostMatches(target, secret.hosts) {
			slog.WarnContext(ctx, "secret host mismatch"+opts.context, slog.String("name", name), slog.String("host", target))
			out.WriteString(src[idx:nameEnd])
			src = src[nameEnd:]
			continue
		}
		if err := validateSecretValue(secret.value); err != nil {
			slog.WarnContext(ctx, "secret value is invalid"+opts.context, slog.String("name", name), slog.Any("err", err))
			out.WriteString(src[idx:nameEnd])
			src = src[nameEnd:]
			continue
		}
		if opts.path {
			err = validatePathSecret(secret.value)
		}
		if err != nil {
			slog.WarnContext(ctx, "secret value is unsafe for url path", slog.String("name", name), slog.Any("err", err))
			out.WriteString(src[idx:nameEnd])
			src = src[nameEnd:]
			continue
		}
		out.WriteString(secret.value)
		changed = true
		src = src[nameEnd:]
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
