ALTER TABLE invoices RENAME COLUMN invoice_title TO invoice_title_ciphertext;
ALTER TABLE invoices RENAME COLUMN tax_id TO tax_id_ciphertext;
ALTER TABLE invoices RENAME COLUMN email TO email_ciphertext;

ALTER TABLE invoices ALTER COLUMN tax_id_ciphertext DROP NOT NULL;
ALTER TABLE invoices
  ADD COLUMN invoice_type text NOT NULL DEFAULT 'business' CHECK (invoice_type IN ('personal', 'business')),
  ADD COLUMN email_lookup_hash text,
  ADD COLUMN idempotency_key text,
  ADD COLUMN payload_digest text,
  ADD COLUMN failure_reason text,
  ADD COLUMN invoice_code text,
  ADD COLUMN invoice_number text,
  ADD COLUMN document_sha256_digest text,
  ADD COLUMN document_size_bytes bigint,
  ADD COLUMN red_invoice_code text,
  ADD COLUMN red_invoice_number text,
  ADD COLUMN red_document_object_key text,
  ADD COLUMN red_document_sha256_digest text,
  ADD COLUMN red_document_size_bytes bigint,
  ADD COLUMN red_issued_at timestamptz,
  ADD COLUMN processed_by uuid REFERENCES users(id),
  ADD COLUMN processing_started_at timestamptz;

ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('requested', 'processing', 'issued', 'failed', 'cancelled', 'red_pending', 'red_issued'));

CREATE UNIQUE INDEX invoices_request_idempotency
  ON invoices(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE invoices DROP CONSTRAINT invoices_order_id_user_id_key;
CREATE UNIQUE INDEX invoices_one_active_per_order
  ON invoices(order_id, user_id)
  WHERE status IN ('requested', 'processing', 'issued', 'red_pending');

CREATE TABLE invoice_events (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  from_status text,
  to_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_events_timeline ON invoice_events(invoice_id, created_at, id);
CREATE TRIGGER invoice_events_immutable BEFORE UPDATE OR DELETE ON invoice_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE invoice_document_uploads (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  kind text NOT NULL CHECK (kind IN ('blue', 'red')),
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 8 AND 10485760),
  sha256_digest text NOT NULL CHECK (sha256_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'verified', 'rejected')),
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_document_uploads_invoice ON invoice_document_uploads(invoice_id, created_at DESC);
CREATE TRIGGER invoice_document_uploads_immutable BEFORE UPDATE OR DELETE ON invoice_document_uploads
  FOR EACH ROW WHEN (OLD.status IN ('verified', 'rejected')) EXECUTE FUNCTION reject_immutable_mutation();
