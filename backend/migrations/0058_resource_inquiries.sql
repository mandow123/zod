CREATE TABLE supplier_import_batches (
  id uuid PRIMARY KEY,
  source_digest text NOT NULL UNIQUE CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('committed', 'superseded')),
  source_size_bytes bigint NOT NULL CHECK (source_size_bytes > 0),
  lead_count integer NOT NULL CHECK (lead_count >= 0),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  warning_count integer NOT NULL CHECK (warning_count >= 0),
  committed_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

CREATE TABLE supplier_leads (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES supplier_import_batches(id),
  source_row integer NOT NULL CHECK (source_row > 0),
  supplier_reference_digest text NOT NULL CHECK (char_length(supplier_reference_digest) = 128),
  private_payload_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_row),
  UNIQUE (batch_id, supplier_reference_digest)
);

CREATE TABLE candidate_resources (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES supplier_import_batches(id),
  lead_id uuid NOT NULL REFERENCES supplier_leads(id),
  candidate_fingerprint text NOT NULL CHECK (char_length(candidate_fingerprint) = 128),
  model text NOT NULL CHECK (model IN ('H100', 'H200', 'B300')),
  card_type text NOT NULL CHECK (char_length(card_type) BETWEEN 2 AND 40),
  wide_region text NOT NULL CHECK (char_length(wide_region) BETWEEN 2 AND 40),
  modes text[] NOT NULL CHECK (cardinality(modes) BETWEEN 1 AND 2 AND modes <@ ARRAY['hourly','monthly']::text[]),
  status text NOT NULL DEFAULT 'inquiry_required' CHECK (status = 'inquiry_required'),
  last_verified_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, lead_id, model),
  UNIQUE (batch_id, candidate_fingerprint)
);
CREATE INDEX candidate_resources_public_catalog
  ON candidate_resources(created_at DESC, id DESC) WHERE active;
CREATE INDEX candidate_resources_public_filters
  ON candidate_resources(model, wide_region, created_at DESC, id DESC) WHERE active;

CREATE TABLE supplier_import_source_warnings (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES supplier_import_batches(id),
  lead_id uuid REFERENCES supplier_leads(id),
  warning_code text NOT NULL CHECK (warning_code IN ('H200_QUOTE_WITHOUT_MODEL')),
  source_row integer NOT NULL CHECK (source_row > 0),
  source_column text NOT NULL CHECK (source_column ~ '^[A-Z]{1,3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_row, source_column, warning_code)
);

CREATE TABLE h200_unconfirmed_leads (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES supplier_import_batches(id),
  lead_id uuid NOT NULL REFERENCES supplier_leads(id),
  source_row integer NOT NULL CHECK (source_row > 0),
  hourly_quote_present boolean NOT NULL,
  monthly_quote_present boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, lead_id)
);

CREATE TABLE resource_inquiries (
  id uuid PRIMARY KEY,
  inquiry_number text NOT NULL UNIQUE,
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  candidate_id uuid NOT NULL REFERENCES candidate_resources(id),
  status text NOT NULL CHECK (status IN (
    'submitted', 'awaiting_supplier', 'clarification_required',
    'supplier_declined', 'inquiry_expired', 'user_cancelled'
  )),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 100),
  confirm_by timestamptz NOT NULL,
  gpu_count integer NOT NULL CHECK (gpu_count > 0 AND gpu_count <= 100000),
  billing_mode text NOT NULL CHECK (billing_mode IN ('hourly', 'monthly')),
  allow_substitutes boolean NOT NULL,
  max_credit_micros bigint NOT NULL CHECK (max_credit_micros > 0 AND max_credit_micros % 10000 = 0),
  use_case text NOT NULL CHECK (use_case IN ('training', 'inference', 'rendering', 'research', 'other')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 500),
  environment text NOT NULL CHECK (environment IN ('bare_metal', 'virtual_machine', 'container', 'flexible')),
  network text NOT NULL CHECK (network IN ('public_internet', 'private_network', 'dedicated_line', 'flexible')),
  storage_gib integer NOT NULL CHECK (storage_gib > 0 AND storage_gib <= 10000000),
  data_region text NOT NULL CHECK (char_length(data_region) BETWEEN 2 AND 80),
  terms_version text NOT NULL CHECK (char_length(terms_version) BETWEEN 1 AND 40),
  privacy_version text NOT NULL CHECK (char_length(privacy_version) BETWEEN 1 AND 40),
  inquiry_version text NOT NULL CHECK (char_length(inquiry_version) BETWEEN 1 AND 40),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) = 128),
  cancel_idempotency_key text,
  cancel_payload_digest text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, client_request_id)
);
CREATE INDEX resource_inquiries_subject_page
  ON resource_inquiries(subject_id, created_at DESC, id DESC);
CREATE INDEX resource_inquiries_candidate_status
  ON resource_inquiries(candidate_id, status, created_at DESC);

CREATE TABLE resource_inquiry_terms_acceptances (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES resource_inquiries(id),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  document_kind text NOT NULL CHECK (document_kind IN ('terms', 'privacy', 'inquiry')),
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 40),
  ip_hash text NOT NULL CHECK (char_length(ip_hash) = 128),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inquiry_id, document_kind)
);

CREATE TABLE resource_inquiry_clarifications (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES resource_inquiries(id),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  author_user_id uuid NOT NULL REFERENCES users(id),
  message text NOT NULL CHECK (char_length(message) BETWEEN 20 AND 1000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) = 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, inquiry_id, idempotency_key)
);
CREATE INDEX resource_inquiry_clarifications_page
  ON resource_inquiry_clarifications(inquiry_id, created_at, id);

CREATE TRIGGER resource_inquiries_updated_at
  BEFORE UPDATE ON resource_inquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION protect_supplier_import_private_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.batch_id <> OLD.batch_id OR NEW.source_row <> OLD.source_row
    OR NEW.supplier_reference_digest <> OLD.supplier_reference_digest
    OR NEW.private_payload_ciphertext <> OLD.private_payload_ciphertext THEN
    RAISE EXCEPTION 'supplier import private source is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_leads_private_immutable
  BEFORE UPDATE ON supplier_leads FOR EACH ROW EXECUTE FUNCTION protect_supplier_import_private_fields();
