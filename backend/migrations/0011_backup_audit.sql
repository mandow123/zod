CREATE TABLE backup_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  artifact_name text NOT NULL,
  object_key text,
  encrypted_size_bytes bigint,
  encrypted_sha256_digest text,
  schema_version text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_runs_status_time ON backup_runs(status, started_at DESC);

CREATE TABLE restore_drills (
  id uuid PRIMARY KEY,
  backup_artifact_name text NOT NULL,
  target_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  schema_version text,
  verified_invariants jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restore_drills_status_time ON restore_drills(status, started_at DESC);

CREATE TRIGGER backup_runs_immutable BEFORE UPDATE OR DELETE ON backup_runs
  FOR EACH ROW WHEN (OLD.status IN ('succeeded', 'failed')) EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER restore_drills_immutable BEFORE UPDATE OR DELETE ON restore_drills
  FOR EACH ROW WHEN (OLD.status IN ('succeeded', 'failed')) EXECUTE FUNCTION reject_immutable_mutation();
