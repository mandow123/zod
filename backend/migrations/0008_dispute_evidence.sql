ALTER TABLE disputes
  ADD COLUMN order_status_before_dispute text,
  ADD COLUMN resolution_refund_id uuid REFERENCES refunds(id),
  ADD COLUMN evidence_deadline timestamptz,
  ADD COLUMN buyer_evidence_completed_at timestamptz,
  ADD COLUMN supplier_evidence_completed_at timestamptz,
  ADD COLUMN idempotency_key text,
  ADD COLUMN payload_digest text;

CREATE UNIQUE INDEX disputes_open_idempotency
  ON disputes(opened_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE disputes ADD CONSTRAINT disputes_category_check
  CHECK (category IN ('not_delivered', 'spec_mismatch', 'service_unavailable', 'billing', 'unauthorized', 'other'));

CREATE UNIQUE INDEX disputes_one_active_per_order
  ON disputes(order_id)
  WHERE status IN ('open', 'evidence_pending', 'reviewing');

CREATE TABLE dispute_evidence (
  id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  submitted_by uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  sha256_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_upload', 'pending_scan', 'scan_failed', 'verified', 'rejected', 'deleted')),
  scan_result text,
  uploaded_at timestamptz,
  verified_at timestamptz,
  rejected_at timestamptz,
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_evidence_timeline ON dispute_evidence(dispute_id, created_at, id);
CREATE INDEX dispute_evidence_scan_queue ON dispute_evidence(status, created_at) WHERE status = 'pending_scan';

CREATE TABLE dispute_events (
  id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  from_status text,
  to_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_events_timeline ON dispute_events(dispute_id, created_at, id);

CREATE TRIGGER dispute_evidence_updated_at BEFORE UPDATE ON dispute_evidence FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dispute_events_immutable BEFORE UPDATE OR DELETE ON dispute_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
