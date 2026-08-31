CREATE TABLE project_snapshots (
  project_id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  retained_from_sequence bigint NOT NULL DEFAULT 1 CHECK (retained_from_sequence > 0),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE project_events (
  event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_snapshots(project_id) ON DELETE RESTRICT,
  project_sequence bigint NOT NULL CHECK (project_sequence > 0),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, project_sequence),
  CHECK (jsonb_typeof(envelope) = 'object')
);

CREATE INDEX project_events_replay_idx ON project_events (project_id, project_sequence);
