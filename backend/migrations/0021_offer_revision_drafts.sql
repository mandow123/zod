-- Reviewer-directed offer revisions remain resumable without mutating the formal offer until resubmission.
ALTER TABLE offer_audit_versions
  ADD COLUMN return_step text CHECK (return_step IS NULL OR return_step IN ('service', 'terms', 'price'));

CREATE TABLE offer_revision_drafts (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES offer_templates(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  created_by uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  source_offer_version integer NOT NULL CHECK (source_offer_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_step text NOT NULL CHECK (current_step IN ('service', 'terms', 'price', 'review')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted')),
  submit_request_id text,
  submit_payload_digest text,
  submitted_submission_version integer CHECK (submitted_submission_version IS NULL OR submitted_submission_version > 0),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, client_request_id),
  CHECK (
    (status = 'active' AND submit_request_id IS NULL AND submit_payload_digest IS NULL
      AND submitted_submission_version IS NULL AND submitted_at IS NULL)
    OR
    (status = 'submitted' AND submit_request_id IS NOT NULL AND submit_payload_digest IS NOT NULL
      AND submitted_submission_version IS NOT NULL AND submitted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX offer_revision_drafts_active_offer
  ON offer_revision_drafts(offer_id) WHERE status = 'active';
CREATE INDEX offer_revision_drafts_resume
  ON offer_revision_drafts(supplier_id, updated_at DESC) WHERE status = 'active';

CREATE TRIGGER offer_revision_drafts_updated_at
  BEFORE UPDATE ON offer_revision_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
