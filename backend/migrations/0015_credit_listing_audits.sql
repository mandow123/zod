-- KAI credit-only listing baseline. This intentionally does not reference early RMB market listings.
CREATE TABLE offer_templates (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  submission_version integer NOT NULL DEFAULT 0 CHECK (submission_version >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  service_mode text NOT NULL CHECK (service_mode IN ('dedicated', 'shared', 'slice', 'node', 'reserved')),
  native_unit text NOT NULL CHECK (char_length(native_unit) BETWEEN 1 AND 40),
  minimum_quantity numeric(24,6) NOT NULL CHECK (minimum_quantity > 0),
  sla jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  refund_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  cleanup_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  suggested_price_cny_micros bigint NOT NULL CHECK (suggested_price_cny_micros > 0),
  price_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'under_review', 'changes_requested', 'approved', 'rejected', 'suspended', 'expired'
  )),
  approved_reference_cny_micros bigint CHECK (approved_reference_cny_micros IS NULL OR approved_reference_cny_micros > 0),
  approved_unit_credit_micros bigint CHECK (approved_unit_credit_micros IS NULL OR approved_unit_credit_micros > 0),
  conversion_cny_micros_per_credit bigint CHECK (conversion_cny_micros_per_credit IS NULL OR conversion_cny_micros_per_credit > 0),
  audit_valid_until timestamptz,
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, resource_id, version),
  UNIQUE (supplier_id, client_request_id)
);
CREATE INDEX offer_templates_supplier_status ON offer_templates(supplier_id, status, updated_at DESC);
CREATE INDEX offer_templates_resource ON offer_templates(resource_id, version DESC);

CREATE TABLE offer_audit_versions (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES offer_templates(id),
  submission_version integer NOT NULL CHECK (submission_version > 0),
  kind text NOT NULL CHECK (kind IN ('resource', 'price')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'expired', 'cancelled')),
  reviewer_id uuid REFERENCES users(id),
  decision_reason text,
  evidence_summary text,
  evidence_digest text,
  decision_digest text,
  approved_reference_cny_micros bigint CHECK (approved_reference_cny_micros IS NULL OR approved_reference_cny_micros > 0),
  conversion_cny_micros_per_credit bigint CHECK (conversion_cny_micros_per_credit IS NULL OR conversion_cny_micros_per_credit > 0),
  approved_unit_credit_micros bigint CHECK (approved_unit_credit_micros IS NULL OR approved_unit_credit_micros > 0),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (offer_id, submission_version, kind),
  CHECK (
    status IN ('pending', 'cancelled') OR
    (reviewer_id IS NOT NULL AND decision_reason IS NOT NULL AND evidence_summary IS NOT NULL
      AND evidence_digest IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (
    kind = 'resource' OR status <> 'approved' OR
    (approved_reference_cny_micros IS NOT NULL AND conversion_cny_micros_per_credit IS NOT NULL
      AND approved_unit_credit_micros IS NOT NULL)
  ),
  CHECK (status <> 'approved' OR valid_until IS NOT NULL)
);
CREATE INDEX offer_audit_queue ON offer_audit_versions(kind, status, created_at);
CREATE INDEX offer_audit_timeline ON offer_audit_versions(offer_id, submission_version, kind);

CREATE TABLE credit_market_listings (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES offer_templates(id),
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL,
  resource_audit_id uuid NOT NULL REFERENCES offer_audit_versions(id),
  price_audit_id uuid NOT NULL REFERENCES offer_audit_versions(id),
  capacity_total numeric(24,6) NOT NULL CHECK (capacity_total > 0),
  capacity_reserved numeric(24,6) NOT NULL DEFAULT 0 CHECK (capacity_reserved >= 0),
  capacity_sold numeric(24,6) NOT NULL DEFAULT 0 CHECK (capacity_sold >= 0),
  capacity_unit text NOT NULL,
  minimum_quantity numeric(24,6) NOT NULL CHECK (minimum_quantity > 0),
  unit_credit_micros bigint NOT NULL CHECK (unit_credit_micros > 0),
  reference_cny_micros bigint NOT NULL CHECK (reference_cny_micros > 0),
  conversion_cny_micros_per_credit bigint NOT NULL CHECK (conversion_cny_micros_per_credit > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'sold_out', 'expired', 'withdrawn', 'suspended')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  audit_snapshot jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (capacity_reserved + capacity_sold <= capacity_total)
);
CREATE INDEX credit_market_listings_public ON credit_market_listings(status, starts_at, expires_at, created_at DESC)
  WHERE status = 'active';
CREATE INDEX credit_market_listings_supplier ON credit_market_listings(supplier_id, status, created_at DESC);
CREATE UNIQUE INDEX credit_market_listings_request ON credit_market_listings(supplier_id, client_request_id);
CREATE INDEX credit_market_listings_resource_window ON credit_market_listings(resource_id, starts_at, expires_at)
  WHERE status IN ('active', 'paused', 'sold_out');

CREATE TRIGGER offer_templates_updated_at
  BEFORE UPDATE ON offer_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER credit_market_listings_updated_at
  BEFORE UPDATE ON credit_market_listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION prevent_decided_offer_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'decided offer audit versions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_audit_versions_immutable
  BEFORE UPDATE OR DELETE ON offer_audit_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_decided_offer_audit_mutation();
