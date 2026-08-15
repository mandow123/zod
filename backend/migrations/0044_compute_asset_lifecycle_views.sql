-- Provider asset views must be backed by custody and lifecycle facts.  These
-- columns deliberately do not infer hosting, renewal or repurchase from a
-- resource/listing label.
ALTER TABLE compute_assets DROP CONSTRAINT compute_assets_management_mode_check;
ALTER TABLE compute_assets ADD CONSTRAINT compute_assets_management_mode_check
  CHECK (management_mode IN ('self_managed', 'platform_hosted'));

ALTER TABLE compute_assets
  ADD COLUMN renewed_at timestamptz,
  ADD COLUMN repurchased_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT compute_assets_repurchase_closed
    CHECK (repurchased_at IS NULL OR closed_at IS NOT NULL),
  ADD CONSTRAINT compute_assets_closed_lifecycle
    CHECK (closed_at IS NULL OR lifecycle_status = 'retired');

-- Existing retired assets already represent a real closed device. Preserve
-- their original last-change time instead of inventing a new close time.
UPDATE compute_assets
SET closed_at = updated_at
WHERE lifecycle_status = 'retired' AND closed_at IS NULL;

CREATE INDEX compute_assets_supplier_management
  ON compute_assets(supplier_id, management_mode, updated_at DESC);
CREATE INDEX compute_assets_supplier_lifecycle_facts
  ON compute_assets(supplier_id, closed_at, repurchased_at, renewed_at, updated_at DESC);
