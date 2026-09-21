-- +goose Up
ALTER TABLE observer_network_events DROP CONSTRAINT observer_network_events_source_check;
ALTER TABLE observer_network_events ADD CONSTRAINT observer_network_events_source_check
  CHECK(source IN ('hubble', 'kubearmor-log', 'kubearmor-alert'));

-- +goose Down
DELETE FROM observer_network_events WHERE source IN ('kubearmor-log', 'kubearmor-alert');
ALTER TABLE observer_network_events DROP CONSTRAINT observer_network_events_source_check;
ALTER TABLE observer_network_events ADD CONSTRAINT observer_network_events_source_check CHECK(source = 'hubble');
