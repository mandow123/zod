CREATE TABLE kai_cloud_resource_verifications (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL UNIQUE REFERENCES compute_assets(id),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  upstream_verification_id text NOT NULL UNIQUE CHECK (char_length(upstream_verification_id) BETWEEN 3 AND 200),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'revoked')),
  upstream_version bigint NOT NULL CHECK (upstream_version > 0),
  start_idempotency_key text NOT NULL CHECK (char_length(start_idempotency_key) BETWEEN 16 AND 128),
  request_payload_digest text NOT NULL CHECK (request_payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  failure_message text CHECK (failure_message IS NULL OR char_length(failure_message) BETWEEN 1 AND 240),
  upstream_updated_at timestamptz NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, start_idempotency_key)
);

CREATE INDEX kai_cloud_resource_verifications_subject_status
  ON kai_cloud_resource_verifications(subject_id, status, updated_at DESC);

CREATE TABLE kai_cloud_resource_verification_events (
  id uuid PRIMARY KEY,
  verification_id uuid NOT NULL REFERENCES kai_cloud_resource_verifications(id),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'revoked')),
  source text NOT NULL CHECK (source IN ('api', 'webhook', 'revoke')),
  upstream_updated_at timestamptz NOT NULL,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (verification_id, status, upstream_updated_at)
);

CREATE TABLE kai_cloud_webhook_deliveries (
  delivery_id text PRIMARY KEY CHECK (char_length(delivery_id) BETWEEN 8 AND 160),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9._-]{2,100}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER kai_cloud_resource_verifications_updated_at
  BEFORE UPDATE ON kai_cloud_resource_verifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
