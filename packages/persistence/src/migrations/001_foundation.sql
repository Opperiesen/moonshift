CREATE TABLE moonshift_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE aggregates (
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  project_id uuid,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (aggregate_type, aggregate_id),
  CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE audit_events (
  audit_event_id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  outcome text NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (aggregate_type, aggregate_id, aggregate_version),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  project_sequence bigint NOT NULL CHECK (project_sequence > 0),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLAIMED', 'PUBLISHED')),
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claim_token bigint NOT NULL DEFAULT 0 CHECK (claim_token >= 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, project_sequence),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX outbox_pending_idx ON outbox_events (created_at, event_id) WHERE status = 'PENDING';
CREATE INDEX outbox_claim_expiry_idx ON outbox_events (claim_expires_at, event_id)
  WHERE status = 'CLAIMED';

CREATE TABLE idempotency_records (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, idempotency_key),
  CHECK (jsonb_typeof(response) IN ('object', 'array', 'string', 'number', 'boolean', 'null'))
);

CREATE TABLE queue_items (
  queue_item_id uuid PRIMARY KEY,
  queue_name text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'CLAIMED', 'COMPLETED')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claim_token bigint NOT NULL DEFAULT 0 CHECK (claim_token >= 0),
  completed_at timestamptz,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX queue_available_idx ON queue_items (queue_name, available_at, queue_item_id)
  WHERE status = 'AVAILABLE';
CREATE INDEX queue_claim_expiry_idx ON queue_items (queue_name, claim_expires_at, queue_item_id)
  WHERE status = 'CLAIMED';

CREATE TABLE leases (
  lease_id uuid PRIMARY KEY,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0 AND fencing_token <= 9007199254740991),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (resource_type, resource_id, fencing_token)
);

CREATE UNIQUE INDEX leases_one_active_resource_idx ON leases (resource_type, resource_id)
  WHERE status = 'ACTIVE';

CREATE TABLE projection_checkpoints (
  projection_name text NOT NULL,
  project_id uuid NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (projection_name, project_id)
);

CREATE TABLE backend_event_projections (
  message_id uuid PRIMARY KEY,
  execution_id uuid,
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^sha256:[a-f0-9]{64}$'),
  accepted boolean NOT NULL,
  classification text NOT NULL CHECK (classification IN ('INTERNAL')),
  projection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(projection) = 'object'),
  CHECK (
    (accepted AND projection ? 'event' AND NOT projection ? 'raw') OR
    (NOT accepted AND projection ? 'reasonCode' AND NOT projection ? 'raw')
  )
);
