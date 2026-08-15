CREATE TABLE resource_verification_evidence (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  submitted_by uuid NOT NULL REFERENCES users(id),
  category text NOT NULL CHECK (category IN ('ownership', 'configuration', 'availability')),
  object_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  sha256_digest text NOT NULL CHECK (sha256_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending_upload', 'pending_scan', 'verified', 'rejected', 'scan_failed', 'deleted')),
  scan_result text,
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL,
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  verified_at timestamptz,
  rejected_at timestamptz,
  UNIQUE (supplier_id, client_request_id)
);

CREATE INDEX resource_verification_evidence_resource
  ON resource_verification_evidence(resource_id, category, created_at DESC)
  WHERE status <> 'deleted';
CREATE INDEX resource_verification_evidence_scan_queue
  ON resource_verification_evidence(status, created_at)
  WHERE status = 'pending_scan';

COMMENT ON TABLE resource_verification_evidence IS
  'Private, malware-scanned materials used for resource ownership, configuration and availability review.';

ALTER TABLE resource_verification_runs
  ADD COLUMN materials_submitted_at timestamptz;

CREATE TABLE resource_verification_material_submissions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  verification_run_id uuid NOT NULL UNIQUE REFERENCES resource_verification_runs(id),
  submitted_by uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, client_request_id)
);

CREATE TABLE resource_verification_material_items (
  submission_id uuid NOT NULL REFERENCES resource_verification_material_submissions(id),
  evidence_id uuid NOT NULL REFERENCES resource_verification_evidence(id),
  category text NOT NULL CHECK (category IN ('ownership', 'configuration', 'availability')),
  sha256_digest text NOT NULL CHECK (sha256_digest ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (submission_id, category),
  UNIQUE (submission_id, evidence_id)
);

COMMENT ON TABLE resource_verification_material_submissions IS
  'Immutable snapshot of the private materials submitted for one resource verification run.';

CREATE TRIGGER resource_material_submission_immutable
  BEFORE UPDATE OR DELETE ON resource_verification_material_submissions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER resource_material_item_immutable
  BEFORE UPDATE OR DELETE ON resource_verification_material_items
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
