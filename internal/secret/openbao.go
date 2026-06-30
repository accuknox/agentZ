package secret

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"

	baoapi "github.com/openbao/openbao/api/v2"
)

type kvReaderWriter interface {
	Get(context.Context, string) (*baoapi.KVSecret, error)
	Put(context.Context, string, map[string]any, ...baoapi.KVOption) (*baoapi.KVSecret, error)
}

// ReadField loads one JSON-encoded field from an OpenBao KV record.
func ReadField[T any](ctx context.Context, kv *baoapi.KVv2, path, key string) (T, error) {
	return readField[T](ctx, kv, path, key)
}

func readField[T any](ctx context.Context, kv kvReaderWriter, path, key string) (T, error) {
	var out T

	secret, err := kv.Get(ctx, path)
	if err != nil {
		return out, fmt.Errorf("read openbao secret %q: %w", path, err)
	}
	if secret == nil || secret.Data == nil {
		return out, fmt.Errorf("openbao secret %q is missing data", path)
	}

	raw, ok := secret.Data[key]
	if !ok {
		return out, fmt.Errorf("openbao secret %q is missing key %q", path, key)
	}

	payload, err := fieldPayload(raw)
	if err != nil {
		return out, fmt.Errorf(
			"decode openbao secret %q key %q: %w",
			path,
			key,
			err,
		)
	}
	if err := json.Unmarshal(payload, &out); err != nil {
		return out, fmt.Errorf(
			"unmarshal openbao secret %q key %q: %w",
			path,
			key,
			err,
		)
	}
	return out, nil
}

// WriteField stores one JSON-encoded field in an OpenBao KV record.
func WriteField(ctx context.Context, kv *baoapi.KVv2, path, key string, value any) error {
	return writeField(ctx, kv, path, key, value)
}

func writeField(ctx context.Context, kv kvReaderWriter, path, key string, value any) error {
	current, err := kv.Get(ctx, path)
	if err != nil {
		return fmt.Errorf("read openbao secret %q before write: %w", path, err)
	}

	data := map[string]any{}
	if current != nil && current.Data != nil {
		maps.Copy(data, current.Data)
	}

	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal openbao secret %q key %q: %w", path, key, err)
	}
	data[key] = string(payload)

	if _, err := kv.Put(ctx, path, data); err != nil {
		return fmt.Errorf("write openbao secret %q: %w", path, err)
	}
	return nil
}

func fieldPayload(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case string:
		return []byte(value), nil
	case []byte:
		return value, nil
	case map[string]any:
		return json.Marshal(value)
	default:
		return nil, fmt.Errorf("unsupported secret payload type %T", raw)
	}
}
