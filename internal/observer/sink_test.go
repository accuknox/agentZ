package observer

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCollectorKeepsEventsUnaggregated(t *testing.T) {
	t.Parallel()

	c := &collector{}
	sessionID := uuid.MustParse("51047bae-702a-4115-bcde-95fff10593bb")
	now := time.Now().UTC()

	c.add(event{network: &networkEvent{
		sessionID:       sessionID,
		eventTime:       now,
		destinationIP:   "104.20.23.154",
		destinationPort: 443,
		protocol:        protocolTCP,
		action:          actionAllowed,
		source:          sourceHubble,
	}})
	c.add(event{network: &networkEvent{
		sessionID:       sessionID,
		eventTime:       now.Add(time.Millisecond),
		destinationIP:   "104.20.23.154",
		destinationPort: 443,
		protocol:        protocolTCP,
		action:          actionAllowed,
		source:          sourceHubble,
	}})

	b := c.flush()
	if len(b.networks) != 2 {
		t.Fatalf("len(networks) = %d, want 2", len(b.networks))
	}
}
