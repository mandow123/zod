CREATE TABLE resource_verification_resubmissions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  verification_run_id uuid NOT NULL UNIQUE REFERENCES resource_verification_runs(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, client_request_id)
);

CREATE INDEX resource_verification_resubmissions_resource
  ON resource_verification_resubmissions(resource_id, created_at DESC);
