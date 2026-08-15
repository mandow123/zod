-- A physical/logical asset is the provider-owned management aggregate. It is
-- deliberately separate from resource verification, node health and sales.
CREATE TABLE compute_assets (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  management_mode text NOT NULL DEFAULT 'self_managed' CHECK (management_mode = 'self_managed'),
  lifecycle_status text NOT NULL DEFAULT 'registered' CHECK (lifecycle_status IN ('registered', 'active', 'retired')),
  lifecycle_generation integer NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0),
  asset_identity_kind text NOT NULL CHECK (asset_identity_kind IN (
    'hardware_serial', 'cloud_resource_id', 'internal_asset_id', 'legacy_resource_id'
  )),
  asset_fingerprint text NOT NULL CHECK (char_length(asset_fingerprint) BETWEEN 16 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, supplier_id)
);

CREATE UNIQUE INDEX compute_assets_global_identity
  ON compute_assets(asset_identity_kind, asset_fingerprint)
  WHERE asset_identity_kind IN ('hardware_serial', 'cloud_resource_id');
CREATE UNIQUE INDEX compute_assets_supplier_identity
  ON compute_assets(supplier_id, asset_fingerprint)
  WHERE asset_identity_kind IN ('internal_asset_id', 'legacy_resource_id');
CREATE INDEX compute_assets_supplier_lifecycle
  ON compute_assets(supplier_id, lifecycle_status, updated_at DESC);

ALTER TABLE compute_resources ADD COLUMN asset_id uuid;

-- Existing rows have no custody contract. They remain truthfully
-- self-managed. A verified resource is active as a resource aggregate, but it
-- is not called hosted and its live usability still comes only from the
-- delivery-readiness view.
INSERT INTO compute_assets(id, supplier_id, management_mode, lifecycle_status,
  asset_identity_kind, asset_fingerprint, created_at, updated_at)
SELECT r.id, r.supplier_id, 'self_managed',
  CASE WHEN r.status = 'retired' THEN 'retired' WHEN r.status = 'verified' THEN 'active' ELSE 'registered' END,
  COALESCE(r.asset_identity_kind, 'legacy_resource_id'),
  COALESCE(r.asset_fingerprint, 'legacy-resource:' || r.id::text),
  r.created_at, r.updated_at
FROM compute_resources r;

UPDATE compute_resources SET asset_id = id WHERE asset_id IS NULL;

ALTER TABLE compute_resources
  ALTER COLUMN asset_id SET NOT NULL,
  ADD CONSTRAINT compute_resources_asset_unique UNIQUE (asset_id),
  ADD CONSTRAINT compute_resources_asset_supplier_fk
    FOREIGN KEY (asset_id, supplier_id) REFERENCES compute_assets(id, supplier_id);

CREATE TRIGGER compute_assets_updated_at
  BEFORE UPDATE ON compute_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
