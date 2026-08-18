ALTER TABLE candidate_resources RENAME COLUMN last_verified_at TO source_observed_at;
ALTER TABLE candidate_resources
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN supplier_subject_id uuid REFERENCES trading_subjects(id),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by uuid REFERENCES users(id);

ALTER TABLE resource_inquiries DROP CONSTRAINT resource_inquiries_status_check;
ALTER TABLE resource_inquiries ADD CONSTRAINT resource_inquiries_status_check CHECK (status IN (
  'submitted', 'awaiting_supplier', 'clarification_required', 'supplier_declined',
  'inquiry_expired', 'user_cancelled', 'capacity_confirmed', 'audit_pending'
));
ALTER TABLE resource_inquiries
  ADD COLUMN supplier_subject_id uuid REFERENCES trading_subjects(id),
  ADD COLUMN assigned_by uuid REFERENCES users(id),
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN capacity_confirmed_at timestamptz,
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN status_message text CHECK (status_message IS NULL OR char_length(status_message) BETWEEN 2 AND 1000),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE INDEX resource_inquiries_supplier_page
  ON resource_inquiries(supplier_subject_id, created_at DESC, id DESC)
  WHERE supplier_subject_id IS NOT NULL;
CREATE INDEX resource_inquiries_expiry_scan
  ON resource_inquiries(confirm_by, id)
  WHERE status IN ('submitted', 'awaiting_supplier', 'clarification_required');

ALTER TABLE resource_inquiry_clarifications
  ADD COLUMN author_kind text NOT NULL DEFAULT 'buyer'
    CHECK (author_kind IN ('buyer', 'supplier', 'operator')),
  ADD COLUMN author_subject_id uuid REFERENCES trading_subjects(id),
  ADD COLUMN message_kind text NOT NULL DEFAULT 'buyer_response'
    CHECK (message_kind IN ('buyer_response', 'supplier_request', 'operator_request'));
UPDATE resource_inquiry_clarifications
SET author_subject_id=subject_id
WHERE author_subject_id IS NULL;

CREATE TABLE resource_inquiry_actions (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES resource_inquiries(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_subject_id uuid REFERENCES trading_subjects(id),
  action text NOT NULL CHECK (action IN (
    'assign', 'request_clarification', 'decline', 'confirm_capacity',
    'expire', 'submit_audit'
  )),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) = 128),
  from_status text NOT NULL,
  to_status text NOT NULL,
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, inquiry_id, action, idempotency_key)
);

CREATE INDEX resource_inquiry_actions_inquiry
  ON resource_inquiry_actions(inquiry_id, created_at, id);
