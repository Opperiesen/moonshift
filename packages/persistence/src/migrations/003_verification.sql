CREATE TABLE verification_policies (
  policy_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (policy_id, version)
);

CREATE TABLE verification_rules (
  policy_id text NOT NULL,
  policy_version integer NOT NULL,
  rule_id text NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version > 0),
  kind text NOT NULL CHECK (kind IN ('REQUIRED_EVIDENCE', 'INDEPENDENT_REVIEW', 'NO_BLOCKING_FINDINGS')),
  evidence_type text NULL CHECK (
    evidence_type IS NULL OR evidence_type IN ('BUILD', 'TEST', 'INTEGRITY', 'COVERAGE', 'REVIEW', 'APPROVAL', 'RECONCILIATION')
  ),
  payload jsonb NOT NULL,
  PRIMARY KEY (policy_id, policy_version, rule_id, rule_version),
  FOREIGN KEY (policy_id, policy_version)
    REFERENCES verification_policies (policy_id, version) ON DELETE RESTRICT
);

CREATE TABLE verification_artifacts (
  artifact_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_snapshots (project_id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  author_agent_id uuid NOT NULL,
  author_lineage_id uuid NOT NULL,
  kind text NOT NULL,
  media_type text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  storage_key text NOT NULL,
  git_revision text NOT NULL CHECK (git_revision ~ '^[a-f0-9]{40,64}$'),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (project_id, artifact_id, content_hash)
);

CREATE TABLE verification_evidence (
  evidence_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_snapshots (project_id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  artifact_id uuid NULL REFERENCES verification_artifacts (artifact_id) ON DELETE RESTRICT,
  producer_agent_id uuid NOT NULL,
  producer_lineage_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK (
    evidence_type IN ('BUILD', 'TEST', 'INTEGRITY', 'COVERAGE', 'REVIEW', 'APPROVAL', 'RECONCILIATION')
  ),
  status text NOT NULL CHECK (status IN ('PASS', 'FAIL', 'MISSING', 'STALE', 'BLOCKING')),
  observed_at timestamptz NOT NULL,
  git_revision text NOT NULL CHECK (git_revision ~ '^[a-f0-9]{40,64}$'),
  source_hash text NOT NULL CHECK (source_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL
);

CREATE TABLE verification_evaluations (
  evaluation_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_snapshots (project_id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  artifact_id uuid NOT NULL REFERENCES verification_artifacts (artifact_id) ON DELETE RESTRICT,
  policy_id text NOT NULL,
  policy_version integer NOT NULL,
  expected_revision text NOT NULL CHECK (expected_revision ~ '^[a-f0-9]{40,64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('EVALUATING', 'PASSED', 'FAILED', 'STALE')),
  captured_at timestamptz NOT NULL,
  decided_at timestamptz NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (policy_id, policy_version)
    REFERENCES verification_policies (policy_id, version) ON DELETE RESTRICT
);

CREATE INDEX verification_artifacts_project_task_idx
  ON verification_artifacts (project_id, task_id, created_at, artifact_id);
CREATE INDEX verification_evidence_project_task_idx
  ON verification_evidence (project_id, task_id, observed_at, evidence_id);
CREATE INDEX verification_evaluations_project_task_idx
  ON verification_evaluations (project_id, task_id, captured_at, evaluation_id);
