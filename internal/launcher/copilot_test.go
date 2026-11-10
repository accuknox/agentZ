package launcher

import (
	"encoding/json"
	"io"
	"iter"
	"slices"
	"strings"
	"testing"

	"github.com/tmaxmax/go-sse"
)

type copilotStreamCase struct {
	name   string
	events []string
	output []string
	done   bool
}

// TestCopilotStream checks that restoring omitted output preserves the actual
// provider result, item order, and incomplete-stream semantics.
func TestCopilotStream(t *testing.T) {
	t.Parallel()
	first := `{"type":"message","id":"first","content":[]}`
	second := `{"type":"function_call","id":"second","arguments":"{}"}`
	cases := []copilotStreamCase{
		{
			name: "completed items retain their output indices",
			events: []string{
				`event: response.output_item.done` + "\n" + `data: {"output_index":1,"item":` + second + `}`,
				`event: response.output_item.done` + "\n" + `data: {"output_index":0,"item":` + first + `}`,
				`event: response.completed` + "\n" + `data: {"response":{"id":"real-id","output":[],"usage":{"output_tokens":7}},"sequence_number":3}`,
			},
			output: []string{first, second},
			done:   true,
		},
		{
			name: "provider completion remains authoritative",
			events: []string{
				`event: response.output_item.done` + "\n" + `data: {"output_index":0,"item":` + first + `}`,
				`event: response.completed` + "\n" + `data: {"response":{"id":"real-id","output":[` + second + `],"usage":{"output_tokens":7}},"sequence_number":3}`,
			},
			output: []string{second},
			done:   true,
		},
		{
			name: "interrupted output never becomes a completed response",
			events: []string{
				`event: response.output_item.done` + "\n" + `data: {"output_index":0,"item":` + first + `}`,
			},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			input := strings.Join(test.events, "\n\n") + "\n\n"
			body := io.NopCloser(strings.NewReader(input))
			next, stop := iter.Pull2(sse.Read(body, nil))
			stream := &copilotStream{
				ReadCloser: body,
				next:       next,
				stop:       stop,
				items:      make(map[int]json.RawMessage),
			}
			defer stream.Close()
			data, err := io.ReadAll(stream)
			if err != nil {
				t.Fatal(err)
			}
			done := false
			for frame, err := range sse.Read(strings.NewReader(string(data)), nil) {
				if err != nil {
					t.Fatal(err)
				}
				if frame.Type != "response.completed" {
					continue
				}
				done = true
				var event copilotOutput
				if err := json.Unmarshal([]byte(frame.Data), &event); err != nil {
					t.Fatal(err)
				}
				output := make([]string, 0, len(event.Response.Output))
				for _, item := range event.Response.Output {
					output = append(output, string(item))
				}
				if !slices.Equal(output, test.output) {
					t.Fatalf("output = %v, want %v", output, test.output)
				}
				fields := []string{`"id":"real-id"`, `"usage":{"output_tokens":7}`, `"sequence_number":3`}
				for _, field := range fields {
					if !strings.Contains(frame.Data, field) {
						t.Fatalf("completion lost %s: %s", field, frame.Data)
					}
				}
			}
			if done != test.done {
				t.Fatalf("completed = %t, want %t", done, test.done)
			}
		})
	}
}
