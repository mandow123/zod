-- In-progress mobile listing plans live separately from auditable offer templates.
-- Only a final, atomic submit turns one of these drafts into a formal offer.
-- A verified resource may have multiple service modes and offer plans.
ALTER TABLE offer_templates DROP CONSTRAINT offer_templates_supplier_id_resource_id_version_key;

CREATE TABLE offer_wizard_drafts (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  created_by uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_step text NOT NULL DEFAULT 'service' CHECK (current_step IN ('service', 'terms', 'price', 'review')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted')),
  submit_request_id text,
  submit_payload_digest text,
  converted_offer_id uuid REFERENCES offer_templates(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, client_request_id),
  CHECK (
    (status = 'active' AND submit_request_id IS NULL AND submit_payload_digest IS NULL AND converted_offer_id IS NULL)
    OR
    (status = 'submitted' AND submit_request_id IS NOT NULL AND submit_payload_digest IS NOT NULL AND converted_offer_id IS NOT NULL)
  )
);

CREATE INDEX offer_wizard_drafts_resume
  ON offer_wizard_drafts(supplier_id, updated_at DESC)
  WHERE status = 'active';

CREATE TRIGGER offer_wizard_drafts_updated_at
  BEFORE UPDATE ON offer_wizard_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
