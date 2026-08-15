-- Stable, private resource identity for retry safety and duplicate ownership protection.
-- The raw internal asset reference is never stored; only a keyed server-side fingerprint is persisted.
ALTER TABLE compute_resources
  ADD COLUMN asset_fingerprint text,
  ADD COLUMN asset_identity_kind text CHECK (asset_identity_kind IS NULL OR asset_identity_kind IN ('hardware_serial', 'cloud_resource_id', 'internal_asset_id')),
  ADD COLUMN client_request_id text,
  ADD COLUMN payload_digest text,
  ADD CONSTRAINT compute_resources_identity_metadata_complete CHECK (
    (asset_fingerprint IS NULL AND asset_identity_kind IS NULL AND client_request_id IS NULL AND payload_digest IS NULL)
    OR
    (asset_fingerprint IS NOT NULL AND asset_identity_kind IS NOT NULL AND client_request_id IS NOT NULL AND payload_digest IS NOT NULL
      AND char_length(client_request_id) BETWEEN 16 AND 120)
  );

CREATE UNIQUE INDEX compute_resources_asset_identity
  ON compute_resources(asset_identity_kind, asset_fingerprint)
  WHERE asset_fingerprint IS NOT NULL AND asset_identity_kind IN ('hardware_serial', 'cloud_resource_id');

CREATE UNIQUE INDEX compute_resources_internal_asset_identity
  ON compute_resources(supplier_id, asset_fingerprint)
  WHERE asset_fingerprint IS NOT NULL AND asset_identity_kind = 'internal_asset_id';

CREATE UNIQUE INDEX compute_resources_create_request
  ON compute_resources(supplier_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
