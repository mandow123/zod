ALTER TABLE offer_wizard_drafts
  ADD COLUMN abandoned_at timestamptz,
  ADD COLUMN abandoned_by uuid REFERENCES users(id);

ALTER TABLE offer_wizard_drafts DROP CONSTRAINT offer_wizard_drafts_status_check;
ALTER TABLE offer_wizard_drafts ADD CONSTRAINT offer_wizard_drafts_status_check
  CHECK (status IN ('active', 'submitted', 'abandoned'));

ALTER TABLE offer_wizard_drafts DROP CONSTRAINT offer_wizard_drafts_check;
ALTER TABLE offer_wizard_drafts ADD CONSTRAINT offer_wizard_drafts_check CHECK (
  (status = 'active' AND submit_request_id IS NULL AND submit_payload_digest IS NULL
    AND converted_offer_id IS NULL AND abandoned_at IS NULL AND abandoned_by IS NULL)
  OR
  (status = 'submitted' AND submit_request_id IS NOT NULL AND submit_payload_digest IS NOT NULL
    AND converted_offer_id IS NOT NULL AND abandoned_at IS NULL AND abandoned_by IS NULL)
  OR
  (status = 'abandoned' AND submit_request_id IS NULL AND submit_payload_digest IS NULL
    AND converted_offer_id IS NULL AND abandoned_at IS NOT NULL AND abandoned_by IS NOT NULL)
);

CREATE INDEX offer_wizard_drafts_abandoned_audit
  ON offer_wizard_drafts(supplier_id, abandoned_at DESC)
  WHERE status = 'abandoned';
