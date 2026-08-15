ALTER TABLE market_listings ADD COLUMN sla jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE resource_verification_runs (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed')),
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_digest text,
  failure_reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX resource_verification_queue ON resource_verification_runs(status, requested_at);
CREATE INDEX resource_verification_resource ON resource_verification_runs(resource_id, requested_at DESC);

CREATE TABLE capacity_reservations (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  listing_id uuid NOT NULL REFERENCES market_listings(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  quantity numeric(24,6) NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('active', 'captured', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capacity_reservations_expiry ON capacity_reservations(expires_at) WHERE status = 'active';

CREATE TRIGGER resource_verification_immutable
  BEFORE UPDATE OR DELETE ON resource_verification_runs
  FOR EACH ROW WHEN (OLD.status IN ('passed', 'failed'))
  EXECUTE FUNCTION reject_immutable_mutation();
